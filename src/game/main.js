// Example game: a first-person walker that loads an exported map with MapLoader.js.
import { PerfHud } from './PerfHud.js'; // first: it hooks WebGL before the context exists
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { parseMap, applyEnvironment } from '../runtime/MapLoader.js';
import { idbGet, idbSet } from '../core/storage.js';
import { loadCharacter } from './Character.js';
import { listTinyimgenCharacters } from '../core/tinyimgen.js';

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

const PLAYER_DEFAULTS = { eye: 1.6, radius: 0.35, height: 1.8, step: 0.45, gravity: 24, jump: 8, walk: 6, run: 11, maxSlope: 50 };
const PLAYER = { ...PLAYER_DEFAULTS };
let MIN_WALK_NY = Math.cos(THREE.MathUtils.degToRad(PLAYER.maxSlope)); // steeper surfaces can't be climbed
/** The Player Spawn's settings (editor: Player Spawn → Camera / Movement) → spawn param key per PLAYER field. */
const SPAWN_PARAMS = { eye: 'eyeHeight', radius: 'radius', height: 'height', step: 'stepHeight', gravity: 'gravity', jump: 'jump', walk: 'walkSpeed', run: 'runSpeed', maxSlope: 'maxSlope' };
let spawnView = null; // the spawn's "Start in" camera, overriding the player's choice when set
const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), onGround: false, groundNormal: new THREE.Vector3(0, 1, 0) };
let map = null;
let cameraBlockers = []; // meshes the third-person camera can't pass through (each object's own, never skinned ones)
let cameraCapsules = []; // characters: the camera tests their capsule, not their skinned mesh (~50 ms per ray)
let envObjects = [];
let solids = [];
let mapPlayer = null; // the character under the map's Player Spawn: { node, spawn, name, buffer, parts } (see findMapPlayer)
let playerSpawn = null;
const insideTriggers = new Set();

// ------------------------------------------------------------------ loading

async function loadMapBuffer(buffer, label, { playtest = false } = {}) {
  if (map) scene.remove(map.root);
  envObjects.forEach((o) => scene.remove(o));
  insideTriggers.clear();

  map = await parseMap(buffer);
  scene.add(map.root);
  mapPlayer = await findMapPlayer(map, playtest);
  playerSpawn = (mapPlayer && map.spawns.find((s) => s.node === mapPlayer.spawn)) ?? map.spawns[0] ?? null;
  applySpawnSettings(playerSpawn?.params ?? {});
  const extent = (map.terrain?.userData.size ?? 100) * 0.75;
  const { hemi, sun } = applyEnvironment(scene, map.environment, { renderer, shadowExtent: extent });
  envObjects = [hemi, sun, sun?.target].filter(Boolean);
  if (!map.environment) {
    const h = new THREE.HemisphereLight(0xffffff, 0x444444, 2);
    scene.add(h);
    envObjects.push(h);
  }
  // The spawn's character (and what it holds) is the player, not part of the level.
  const isPlayer = (n) => !!mapPlayer && isBelow(n, mapPlayer.node);
  solids = map.colliders.filter((c) => c.type !== 'trigger' && !isPlayer(c.node));
  cameraCapsules = solids.filter((c) => c.type === 'capsule' && c.node.visible);
  const isCharacter = (n) => cameraCapsules.some((c) => isBelow(n, c.node)); // includes what they hold
  cameraBlockers = [];
  const ownMeshes = (o) => {
    if (o.isMesh && !o.isSkinnedMesh) cameraBlockers.push(o);
    for (const c of o.children) if (!c.userData?.mapType) ownMeshes(c);
  };
  map.objects.filter((o) => o.visible && !isPlayer(o) && !isCharacter(o)).forEach(ownMeshes);

  $('map-name').textContent = map.name || label;
  $('title').textContent = map.name || label;
  $('subtitle').textContent = `${map.objects.length} objects · ${map.spawns.length} spawn(s) · ${map.triggers.length} trigger(s)`;
  $('play').hidden = false;
  respawn();
  if (mapPlayer?.buffer) selectCharacter({ kind: 'map', name: mapPlayer.name });
  else if (charSpec.kind === 'map') selectCharacter({ kind: 'capsule', name: 'Capsule' }, { switchToThird: false });
  else renderCharacterTiles();
  if (spawnView) setView(spawnView);
}

/** Movement, camera and view settings from the Player Spawn (missing ones keep the defaults). */
function applySpawnSettings(params) {
  Object.assign(PLAYER, PLAYER_DEFAULTS);
  for (const [field, key] of Object.entries(SPAWN_PARAMS)) {
    if (Number.isFinite(params[key])) PLAYER[field] = params[key];
  }
  MIN_WALK_NY = Math.cos(THREE.MathUtils.degToRad(PLAYER.maxSlope));
  if (Number.isFinite(params.cameraDistance)) tp.dist = tp.curDist = THREE.MathUtils.clamp(params.cameraDistance, 1.2, 14);
  spawnView = params.view === 'first' || params.view === 'third' ? params.view : null;
  if (params.facing === 'free' || params.facing === 'strafe') { view.facing = params.facing; syncViewUI(); }
}

const isBelow = (node, root) => { for (let o = node; o; o = o.parent) if (o === root) return true; return false; };

/**
 * A rigged model under a Player Spawn (set up in the editor, holding props) is the player. Its copy in the map has
 * no animations, so it's hidden; the editor's ▶ Play passes the model's original GLB, which the playtest plays and
 * moves the held objects onto. A map loaded from a file has no GLB for it, so its spawn character is just hidden.
 */
async function findMapPlayer(map, playtest) {
  const rec = playtest ? await idbGet('playtest-player').catch(() => null) : null;
  let spawn = rec && map.byId.get(rec.spawnId), node = rec && map.byId.get(rec.characterId);
  if (!node) {
    for (const s of map.spawns) {
      s.node.traverse((n) => { if (!node && n !== s.node && n.userData.rig) { node = n; spawn = s.node; } });
      if (node) break;
    }
  }
  if (!node) return null;
  node.visible = false;
  const playable = rec && spawn;
  return { node, spawn, name: playable ? rec.name : null, buffer: playable ? rec.buffer : null, height: playable ? rec.height : null, parts: map.childrenOf(node) };
}

function respawn() {
  const s = playerSpawn;
  if (s) {
    player.pos.copy(s.position);
    camera.quaternion.setFromEuler(new THREE.Euler(0, s.rotationY, 0, 'YXZ'));
  } else {
    player.pos.set(0, map ? map.getHeightAt(0, 0) : 0, 0);
  }
  player.pos.y = Math.max(player.pos.y, groundHeight(player.pos.x, player.pos.z, player.pos.y + 2));
  player.vel.set(0, 0, 0);
  // Spawns face -Z (a camera's forward); characters face +Z, so turn them around.
  tp.yaw = tp.body = (s?.rotationY ?? 0) + Math.PI;
  tp.slide.set(0, 0);
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
    if (c.type !== 'capsule' && c.overlaps(prev, r)) {
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
  if (e.code === 'KeyV' && !e.repeat) setView(view.mode === 'third' ? 'first' : 'third');
  if (e.code === 'KeyT' && !e.repeat && view.mode === 'third') setFacing(view.facing === 'free' ? 'strafe' : 'free');
  if (e.code === 'Space' && player.onGround && controls.isLocked) { player.vel.y = PLAYER.jump; player.onGround = false; }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

const fwd = new THREE.Vector3(), right = new THREE.Vector3(), wish = new THREE.Vector3(), _prev = new THREE.Vector3();

const angleTo = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

function update(dt) {
  if (!map) return;
  const active = controls.isLocked;
  const ix = active ? (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) - (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) : 0;
  const iz = active ? (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) : 0;
  const running = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const n = player.groundNormal;
  const steep = player.onGround && n.y < MIN_WALK_NY;

  if (view.mode === 'third' && character) {
    moveThirdPerson(dt, ix, iz, running, steep);
  } else {
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    right.crossVectors(fwd, camera.up).normalize();
    wish.set(0, 0, 0).addScaledVector(fwd, iz).addScaledVector(right, -ix);
    const speed = running ? PLAYER.run : PLAYER.walk;
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
    const accel = player.onGround && !steep ? 12 : 3; // little grip on steep slopes
    player.vel.x += (wish.x - player.vel.x) * Math.min(1, accel * dt);
    player.vel.z += (wish.z - player.vel.z) * Math.min(1, accel * dt);
    // Steep ground: slide down it instead of standing still.
    if (steep) {
      player.vel.x += n.x * PLAYER.gravity * dt;
      player.vel.z += n.z * PLAYER.gravity * dt;
    }
  }
  player.vel.y -= PLAYER.gravity * dt;

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

  if (view.mode === 'third' && character) {
    character.root.position.copy(p);
    character.root.rotation.y = tp.body;
    updateThirdPersonCamera(dt);
  } else {
    camera.position.set(p.x, p.y + PLAYER.eye, p.z);
  }
  $('pos').textContent = `x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  z ${p.z.toFixed(1)}`;

  // Trigger volumes
  const probe = new THREE.Vector3(p.x, p.y + 0.9, p.z);
  for (const t of map.triggers) {
    const inside = t.contains(probe);
    if (inside && !insideTriggers.has(t)) { insideTriggers.add(t); flash(`Entered “${t.name}”${t.event ? ` → ${t.event}` : ''}`); }
    else if (!inside && insideTriggers.has(t)) { insideTriggers.delete(t); flash(`Left “${t.name}”`); }
  }
}

// ------------------------------------------------------------------ third person

// yaw: camera heading (the camera looks along +Z rotated by yaw), body: character heading (it faces +Z rotated by body)
const tp = { yaw: Math.PI, body: Math.PI, pitch: 0.3, dist: 4.5, curDist: 4.5, slide: new THREE.Vector2() };
const view = { mode: readPref('view', 'first'), facing: readPref('facing', 'free') };
let character = null;

/** Character movement comes from its animation (Locomotion); the shared physics below adds gravity and collisions. */
function moveThirdPerson(dt, ix, iz, running, steep) {
  let input;
  if (view.facing === 'strafe') {
    // Body turns to the camera heading; A/D strafe and S walks backwards.
    if (ix || iz) tp.body += angleTo(tp.body, tp.yaw) * (1 - Math.exp(-10 * dt));
    const d = angleTo(tp.body, tp.yaw), c = Math.cos(d), s = Math.sin(d);
    input = { x: ix * c + iz * s, z: iz * c - ix * s };
  } else {
    // Body turns toward where it's going and always walks forward.
    if (ix || iz) tp.body += angleTo(tp.body, tp.yaw + Math.atan2(ix, iz)) * (1 - Math.exp(-8 * dt));
    input = { x: 0, z: ix || iz ? 1 : 0 };
  }
  if (!player.onGround) input = { x: input.x * 0.3, z: input.z * 0.3 }; // limited air control
  const v = character.update(dt, input, running);
  const n = player.groundNormal;
  if (steep) tp.slide.x += n.x * PLAYER.gravity * dt, tp.slide.y += n.z * PLAYER.gravity * dt;
  else tp.slide.multiplyScalar(Math.exp(-10 * dt));
  const c = Math.cos(tp.body), s = Math.sin(tp.body);
  player.vel.x = v.z * s + v.x * c + tp.slide.x;
  player.vel.z = v.z * c - v.x * s + tp.slide.y;
}

const _camTarget = new THREE.Vector3(), _camDir = new THREE.Vector3();
const camRay = new THREE.Raycaster();

function updateThirdPersonCamera(dt) {
  const p = player.pos;
  _camTarget.set(p.x, p.y + character.height * 0.85, p.z);
  _camDir.set(-Math.sin(tp.yaw) * Math.cos(tp.pitch), Math.sin(tp.pitch), -Math.cos(tp.yaw) * Math.cos(tp.pitch));
  // Pull in instantly when something is between the camera and the character; ease back out afterwards.
  const free = Math.max(0.4, cameraClearance(_camTarget, _camDir, tp.dist) - 0.25);
  tp.curDist = free < tp.curDist ? free : tp.curDist + (Math.min(free, tp.dist) - tp.curDist) * (1 - Math.exp(-4 * dt));
  camera.position.copy(_camTarget).addScaledVector(_camDir, tp.curDist);
  camera.lookAt(_camTarget);
}

/** Distance along the ray before it hits map geometry or the terrain (up to maxDist). */
function cameraClearance(origin, dir, maxDist) {
  let best = maxDist;
  camRay.set(origin, dir);
  camRay.far = maxDist;
  const hit = camRay.intersectObjects(cameraBlockers, false)[0];
  if (hit) best = hit.distance;
  for (const c of cameraCapsules) best = Math.min(best, c.rayDistance(origin, dir, best));
  for (let t = 0.25; t < best; t += 0.25) { // terrain: march with the height sampler (cheaper than raycasting the mesh)
    const x = origin.x + dir.x * t, y = origin.y + dir.y * t, z = origin.z + dir.z * t;
    if (y < map.getHeightAt(x, z) + 0.15) return t;
  }
  return best;
}

function setView(mode) {
  if (mode === 'third' && !character) mode = 'first';
  if (mode !== view.mode) {
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    if (mode === 'third') {
      tp.yaw = tp.body = e.y + Math.PI;
      tp.curDist = 0.5; // zoom out from the eye
    } else {
      camera.quaternion.setFromEuler(new THREE.Euler(-tp.pitch * 0.5, tp.yaw + Math.PI, 0, 'YXZ'));
    }
    view.mode = mode;
    writePref('view', mode);
  }
  controls.enabled = mode === 'first'; // PointerLockControls only steers the first-person camera
  if (character) character.root.visible = mode === 'third';
  $('crosshair').hidden = mode === 'third';
  syncViewUI();
}

function setFacing(facing) {
  view.facing = facing;
  writePref('facing', facing);
  syncViewUI();
}

document.addEventListener('mousemove', (e) => {
  if (!controls.isLocked || view.mode !== 'third') return;
  tp.yaw -= e.movementX * 0.0025;
  tp.pitch = THREE.MathUtils.clamp(tp.pitch + e.movementY * 0.0025, -0.5, 1.25);
});
window.addEventListener('wheel', (e) => {
  if (view.mode !== 'third') return;
  tp.dist = THREE.MathUtils.clamp(tp.dist * Math.exp(e.deltaY * 0.001), 1.2, 14);
}, { passive: true });

// ------------------------------------------------------------------ character picker

function readPref(key, fallback) {
  try { return localStorage.getItem(`playtest.${key}`) ?? fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(`playtest.${key}`, value); } catch { /* private mode */ }
}

let charSpec = { kind: 'capsule' };
let tinyChars = [];
let fileChar = null; // { name, buffer } of a .glb picked from disk
let charLoadToken = 0;

async function selectCharacter(spec, { switchToThird = true } = {}) {
  const token = ++charLoadToken;
  charSpec = spec;
  renderCharacterTiles();
  setCharMsg(`Loading ${spec.name ?? 'character'}…`);
  try {
    const next = spec.kind === 'map'
      ? await loadCharacter({ kind: 'file', name: mapPlayer.name, buffer: mapPlayer.buffer }, renderer)
      : await loadCharacter(spec, renderer);
    if (spec.kind === 'map') {
      next.setHeight(mapPlayer.height);
      next.equip(mapPlayer.parts);
    }
    if (token !== charLoadToken) { next.dispose(); return; } // a newer pick won
    if (character) { scene.remove(character.root); character.dispose(); }
    character = next;
    scene.add(character.root);
    const { kind, ...saved } = spec;
    if (kind !== 'map') writePref('character', JSON.stringify(kind === 'file' ? { kind, name: spec.name } : { kind, ...saved }));
    setCharMsg(describeCharacter(character));
    setView(spawnView ?? (switchToThird ? 'third' : view.mode));
  } catch (err) {
    if (token !== charLoadToken) return;
    console.error(err);
    setCharMsg(`Couldn't load ${spec.name ?? 'character'}: ${err.message}`, true);
  }
}

function describeCharacter(c) {
  const anim = { locomotion: 'tinyimgen locomotion (6 mocap clips)', clips: 'idle/walk/run clips by name', static: 'no animations', capsule: 'no animations' }[c.kind];
  const holds = c.held.length ? ` · holding ${c.held.map((h) => h.holder.userData.name ?? h.holder.name).join(', ')}` : '';
  return `${c.name} · ${c.height.toFixed(2)} m · ${anim}${holds}`;
}

function setCharMsg(text, error = false) {
  const el = $('char-msg');
  el.textContent = text;
  el.classList.toggle('error', error);
}

function renderCharacterTiles() {
  const tile = (label, { thumb, icon, selected, onClick, title }) => {
    const b = document.createElement('button');
    b.className = `char-tile${selected ? ' selected' : ''}`;
    b.title = title ?? label;
    b.append(thumb ? Object.assign(document.createElement('img'), { src: thumb, alt: '', loading: 'lazy' })
      : Object.assign(document.createElement('span'), { className: 'char-icon', textContent: icon }));
    b.append(Object.assign(document.createElement('span'), { className: 'char-name', textContent: label }));
    b.addEventListener('click', onClick);
    return b;
  };
  const list = $('chars');
  list.replaceChildren(
    ...(mapPlayer?.buffer ? [tile(mapPlayer.name, {
      icon: '⚑', title: `${mapPlayer.name}: the character under the map's Player Spawn, with what it holds`,
      selected: charSpec.kind === 'map', onClick: () => selectCharacter({ kind: 'map', name: mapPlayer.name }),
    })] : []),
    tile('Capsule', { icon: '⬮', selected: charSpec.kind === 'capsule', onClick: () => selectCharacter({ kind: 'capsule', name: 'Capsule' }) }),
    ...tinyChars.map((c) => tile(c.name, {
      thumb: c.thumb, title: `${c.name} (tinyimgen ${c.id})`,
      selected: charSpec.kind === 'tinyimgen' && charSpec.id === c.id,
      onClick: () => selectCharacter({ kind: 'tinyimgen', id: c.id, name: c.name, url: c.url }),
    })),
    ...(fileChar ? [tile(fileChar.name, { icon: '⬢', selected: charSpec.kind === 'file', onClick: () => selectCharacter({ kind: 'file', ...fileChar }) })] : []),
    tile('Load .glb…', { icon: '+', onClick: () => $('char-file').click(), title: 'Use any rigged .glb as the player' }),
  );
}

$('char-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  fileChar = { name: f.name.replace(/\.(glb|gltf)$/i, ''), buffer: await f.arrayBuffer() };
  idbSet('playtest-character-file', fileChar).catch(() => {});
  selectCharacter({ kind: 'file', ...fileChar });
});

$('view-first').addEventListener('click', () => setView('first'));
$('view-third').addEventListener('click', () => setView('third'));
$('facing').addEventListener('click', () => setFacing(view.facing === 'free' ? 'strafe' : 'free'));

function syncViewUI() {
  $('view-first').classList.toggle('active', view.mode === 'first');
  $('view-third').classList.toggle('active', view.mode === 'third');
  $('facing').hidden = view.mode !== 'third';
  $('facing').textContent = view.facing === 'free' ? 'Facing: turns to move (T)' : 'Facing: strafe (T)';
  $('hud-view').textContent = view.mode === 'third' ? `3rd person · ${view.facing === 'free' ? 'free turn' : 'strafe'}` : '1st person';
}

async function initCharacters() {
  let saved = null;
  try { saved = JSON.parse(readPref('character', 'null')); } catch { /* ignore */ }
  fileChar = await idbGet('playtest-character-file').catch(() => null) ?? null;
  renderCharacterTiles();
  const tinyLoaded = listTinyimgenCharacters().then((list) => {
    tinyChars = list;
    renderCharacterTiles();
    if (!list.length) setCharMsg('tinyimgen has no rigged characters yet: build one with "Rig + animations" on.');
  }).catch((err) => {
    $('chars-note').textContent = `${err.message} at /tinyimgen. Start tinyimgen (server.py) to pick its characters.`;
  });
  let spec = { kind: 'capsule', name: 'Capsule' };
  if (saved?.kind === 'tinyimgen') spec = saved;
  else if (saved?.kind === 'file' && fileChar) spec = { kind: 'file', ...fileChar };
  if (spec.kind === 'tinyimgen') await tinyLoaded; // so its tile is there when it loads
  if (charSpec.kind === 'map') return; // the map brought its own player
  const wantThird = view.mode === 'third';
  view.mode = 'first';
  await selectCharacter(spec, { switchToThird: false });
  if (charSpec.kind === 'map') return;
  setView(spawnView ?? (wantThird ? 'third' : 'first'));
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

syncViewUI();
initCharacters();
// Handy for console tinkering (like window.editor in the editor).
window.playtest = { player, PLAYER, view, tp, controls, keys, camera, get map() { return map; }, get character() { return character; }, setView, selectCharacter };

(async () => {
  const params = new URLSearchParams(location.search);
  try {
    if (params.has('playtest')) {
      const buf = await idbGet('playtest');
      if (buf) await loadMapBuffer(buf, 'Playtest', { playtest: true });
    } else if (params.get('map')) {
      const res = await fetch(params.get('map'));
      await loadMapBuffer(await res.arrayBuffer(), params.get('map'));
    }
  } catch (err) {
    console.error(err);
    $('subtitle').textContent = `Failed to load map: ${err.message}`;
  }
})();
