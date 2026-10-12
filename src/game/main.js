// Example game: a first-person walker that loads an exported map with MapLoader.js.
import { PerfHud } from './PerfHud.js'; // first: it hooks WebGL before the context exists
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { parseMap, applyEnvironment } from '../runtime/MapLoader.js';
import { idbGet } from '../core/storage.js';

const $ = (id) => document.getElementById(id);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.prepend(renderer.domElement);
const perf = new PerfHud(renderer);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#222');
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 3000);
const controls = new PointerLockControls(camera, renderer.domElement);

const PLAYER = { eye: 1.6, radius: 0.35, height: 1.8, step: 0.45, gravity: 24, jump: 8, walk: 6, run: 11, maxSlope: 50 };
const MIN_WALK_NY = Math.cos(THREE.MathUtils.degToRad(PLAYER.maxSlope)); // steeper surfaces can't be climbed
const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), onGround: false, groundNormal: new THREE.Vector3(0, 1, 0) };
let map = null;
let envObjects = [];
let solids = [];
const insideTriggers = new Set();

// ------------------------------------------------------------------ loading

async function loadMapBuffer(buffer, label) {
  if (map) scene.remove(map.root);
  envObjects.forEach((o) => scene.remove(o));
  insideTriggers.clear();

  map = await parseMap(buffer);
  scene.add(map.root);
  const extent = (map.terrain?.userData.size ?? 100) * 0.75;
  const { hemi, sun } = applyEnvironment(scene, map.environment, { renderer, shadowExtent: extent });
  envObjects = [hemi, sun, sun?.target].filter(Boolean);
  if (!map.environment) {
    const h = new THREE.HemisphereLight(0xffffff, 0x444444, 2);
    scene.add(h);
    envObjects.push(h);
  }
  solids = map.colliders.filter((c) => c.type !== 'trigger');

  $('map-name').textContent = map.name || label;
  $('title').textContent = map.name || label;
  $('subtitle').textContent = `${map.objects.length} objects · ${map.spawns.length} spawn(s) · ${map.triggers.length} trigger(s)`;
  $('play').hidden = false;
  respawn();
}

function respawn() {
  const s = map?.spawns[0];
  if (s) {
    player.pos.copy(s.position);
    camera.quaternion.setFromEuler(new THREE.Euler(0, s.rotationY, 0, 'YXZ'));
  } else {
    player.pos.set(0, map ? map.getHeightAt(0, 0) : 0, 0);
  }
  player.pos.y = Math.max(player.pos.y, groundHeight(player.pos.x, player.pos.z, player.pos.y + 2));
  player.vel.set(0, 0, 0);
}

// ------------------------------------------------------------------ physics

const _n = new THREE.Vector3();

/** How far above the feet a surface may be and still be stepped onto. Steep slopes can't be climbed. */
const climbFor = (normalY) => (normalY >= MIN_WALK_NY ? PLAYER.step : 0.02);

/** Highest surface under (x, z) the player can stand on from feetY. Writes its normal to player.groundNormal. */
function groundHeight(x, z, feetY) {
  let g = map ? map.getHeightAt(x, z) : 0;
  player.groundNormal.set(0, 1, 0);
  for (const c of solids) {
    const y = c.surfaceAt(x, z, PLAYER.radius, _n);
    if (y !== null && y > g && y <= feetY + climbFor(_n.y)) {
      g = y;
      player.groundNormal.copy(_n);
    }
  }
  return g;
}

/** Push the player out of anything too tall (or too steep) to step onto. `prev` is last frame's position. */
function resolveWalls(p, prev) {
  const r = PLAYER.radius;
  for (const c of solids) {
    if (p.y + PLAYER.height <= c.box.min.y) continue; // walking underneath
    const top = c.surfaceAt(p.x, p.z, r, _n);
    if (top === null || top <= p.y + climbFor(_n.y)) continue;
    if (c.overlaps(prev, r)) {
      // Already on/against it (e.g. a steep ramp): just refuse the move instead of teleporting to an edge.
      p.x = prev.x;
      p.z = prev.z;
    } else {
      c.pushOut(p, r);
    }
  }
}

const keys = new Set();
window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyR') respawn();
  if (e.code === 'Space' && player.onGround && controls.isLocked) { player.vel.y = PLAYER.jump; player.onGround = false; }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

const fwd = new THREE.Vector3(), right = new THREE.Vector3(), wish = new THREE.Vector3(), _prev = new THREE.Vector3();

function update(dt) {
  if (!map) return;
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  fwd.normalize();
  right.crossVectors(fwd, camera.up).normalize();
  wish.set(0, 0, 0);
  if (controls.isLocked) {
    if (keys.has('KeyW') || keys.has('ArrowUp')) wish.add(fwd);
    if (keys.has('KeyS') || keys.has('ArrowDown')) wish.sub(fwd);
    if (keys.has('KeyD') || keys.has('ArrowRight')) wish.add(right);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) wish.sub(right);
  }
  const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? PLAYER.run : PLAYER.walk;
  if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
  const accel = player.onGround && player.groundNormal.y >= MIN_WALK_NY ? 12 : 3; // little grip on steep slopes
  player.vel.x += (wish.x - player.vel.x) * Math.min(1, accel * dt);
  player.vel.z += (wish.z - player.vel.z) * Math.min(1, accel * dt);
  player.vel.y -= PLAYER.gravity * dt;

  // Steep ground: slide down it instead of standing still.
  const n = player.groundNormal;
  if (player.onGround && n.y < MIN_WALK_NY) {
    player.vel.x += n.x * PLAYER.gravity * dt;
    player.vel.z += n.z * PLAYER.gravity * dt;
  }

  const p = player.pos;
  const prevPos = _prev.copy(p);
  const wasOnGround = player.onGround;
  p.x += player.vel.x * dt;
  p.z += player.vel.z * dt;
  resolveWalls(p, prevPos);
  p.y += player.vel.y * dt;
  const g = groundHeight(p.x, p.z, prevPos.y);
  if (p.y <= g || (wasOnGround && player.vel.y <= 0 && p.y - g <= PLAYER.step)) {
    // Land, climb ramps/steps, and stick to the ground walking downhill instead of bouncing off it.
    p.y = g;
    player.vel.y = 0;
    player.onGround = true;
  } else {
    player.onGround = false;
  }
  if (p.y < -200) respawn();

  camera.position.set(p.x, p.y + PLAYER.eye, p.z);
  $('pos').textContent = `x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  z ${p.z.toFixed(1)}`;

  // Trigger volumes
  const probe = new THREE.Vector3(p.x, p.y + 0.9, p.z);
  for (const t of map.triggers) {
    const inside = t.contains(probe);
    if (inside && !insideTriggers.has(t)) { insideTriggers.add(t); flash(`Entered “${t.name}”${t.event ? ` → ${t.event}` : ''}`); }
    else if (!inside && insideTriggers.has(t)) { insideTriggers.delete(t); flash(`Left “${t.name}”`); }
  }
}

let flashTimer;
function flash(msg) {
  const el = $('event');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.style.display = 'none'; }, 2000);
}

// ------------------------------------------------------------------ UI / loop

$('play').addEventListener('click', () => controls.lock());
controls.addEventListener('lock', () => { $('overlay').style.display = 'none'; });
controls.addEventListener('unlock', () => { $('overlay').style.display = 'flex'; $('play').textContent = 'Resume'; });
$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) await loadMapBuffer(await f.arrayBuffer(), f.name);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) await loadMapBuffer(await f.arrayBuffer(), f.name);
});
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const timer = new THREE.Timer();
timer.connect(document);
renderer.setAnimationLoop((t) => {
  perf.begin();
  timer.update(t);
  update(Math.min(timer.getDelta(), 0.05));
  renderer.render(scene, camera);
  perf.end();
});

(async () => {
  const params = new URLSearchParams(location.search);
  try {
    if (params.has('playtest')) {
      const buf = await idbGet('playtest');
      if (buf) await loadMapBuffer(buf, 'Playtest');
    } else if (params.get('map')) {
      const res = await fetch(params.get('map'));
      await loadMapBuffer(await res.arrayBuffer(), params.get('map'));
    }
  } catch (err) {
    console.error(err);
    $('subtitle').textContent = `Failed to load map: ${err.message}`;
  }
})();
