// Example game: a first-person walker that loads an exported map with MapLoader.js.
import { PerfHud } from './PerfHud.js'; // first: it hooks WebGL before the context exists
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { parseMap, applyEnvironment } from '../runtime/MapLoader.js';
import { idbGet, idbSet } from '../core/storage.js';
import { runScripts } from '../runtime/scripts.js';
import { decodeClips } from '../runtime/animator.js';
import { loadCharacter } from './Character.js';
import { listTinyimgenCharacters } from '../core/tinyimgen.js';
import { listEngineModels } from '../core/engine.js';
import CONTROLLER_SOURCE from '../runtime/PlayerController.script.js?raw';

const $ = (id) => document.getElementById(id);

// Inside the editor's play mode (an iframe over its viewport): talk to the editor, which can pause and stop the game.
const embedded = new URLSearchParams(location.search).has('embed') && window.parent !== window;
const toEditor = (type, data = {}) => { if (embedded) window.parent.postMessage({ from: '3dmap-play', type, ...data }, location.origin); };
let paused = false;
if (embedded) {
  document.body.classList.add('embedded');
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== location.origin) return;
    if (e.data?.type === 'pause') paused = !!e.data.paused;
  });
  const text = (args) => {
    const parts = [];
    for (const a of args) {
      if (a instanceof Error) { if (!parts.some((p) => p.includes(a.message))) parts.push(a.message); } // usually already in the text
      else if (a && typeof a === 'object') { try { parts.push(JSON.stringify(a)); } catch { parts.push(String(a)); } }
      else parts.push(String(a));
    }
    return parts.join(' ');
  };
  for (const level of ['warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { orig(...args); toEditor('log', { level, text: text(args) }); };
  }
  window.addEventListener('error', (e) => toEditor('log', { level: 'error', text: e.message }));
  window.addEventListener('unhandledrejection', (e) => toEditor('log', { level: 'error', text: String(e.reason?.message ?? e.reason) }));
}

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
controls.enabled = false; // only captures the mouse: the player controller script does the looking

// The player's body for collisions: the controller script passes its own to game.physics.move each frame.
const BODY = { radius: 0.35, height: 1.8, step: 0.45, maxSlope: 50 };
let spawnView = null; // the controller's "Start in" view, overriding the player's choice when set
const player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), onGround: false, groundNormal: new THREE.Vector3(0, 1, 0) };
let map = null;
let cameraBlockers = []; // meshes the third-person camera can't pass through (each object's own, never skinned ones)
let cameraCapsules = []; // characters: the camera tests their capsule, not their skinned mesh (~50 ms per ray)
let envObjects = [];
let solids = [];
let mapPlayer = null; // the character under the map's Player Spawn: { node, spawn, name, buffer, controller, parts } (see findMapPlayer)
let playerSpawn = null;
const insideTriggers = new Set();

// ------------------------------------------------------------------ loading

/** keep: reloading the same map after an edit (a prop re-saved in tinyimgen), so the player stays where they are. */
async function loadMapBuffer(buffer, label, { playtest = false, keep = false } = {}) {
  scripts?.dispose();
  scripts = null;
  if (map) scene.remove(map.root);
  envObjects.forEach((o) => scene.remove(o));
  insideTriggers.clear();

  map = await parseMap(buffer);
  scene.add(map.root);
  mapPlayer = await findMapPlayer(map, playtest);
  playerSpawn = (mapPlayer && map.spawns.find((s) => s.node === mapPlayer.spawn)) ?? map.spawns[0] ?? null;
  spawnView = null;
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
  if (!keep) setMenu(false); // straight into the game
  if (!keep) respawn();
  if (mapPlayer?.buffer && (!keep || charSpec.kind === 'map')) selectCharacter({ kind: 'map', name: mapPlayer.name }, { switchToThird: !keep });
  else if (charSpec.kind === 'map') selectCharacter({ kind: 'capsule', name: 'Capsule' }, { switchToThird: false });
  else renderCharacterTiles();
  const loaded = map;
  const started = await runScripts(map, scriptHost);
  if (map === loaded) scripts = started; else started.dispose(); // another map came in meanwhile
}

// ------------------------------------------------------------------ scripts

/** The map's scripts (src/runtime/scripts.js), running while the map is loaded. */
let scripts = null;
let interactFocus = null; // { node, prompt } the player can use with E

const scriptHost = {
  player: {
    position: player.pos, // feet
    velocity: player.vel,
    get onGround() { return player.onGround; },
    set onGround(v) { player.onGround = !!v; },
    groundNormal: player.groundNormal,
    /** The Player Spawn ({ position, rotationY, params }), or null. */
    get spawn() { return playerSpawn; },
    respawn: () => respawn(),
    teleport(x, y, z) { player.pos.set(x, y, z); player.vel.set(0, 0, 0); },
    /**
     * Walk with library clips: { idle, walk, run, back, left, right } name a clip each (idle and walk needed). The
     * player controller calls this when it starts and on 'characterChanged'; until then a tinyimgen character has
     * no walking animation. speeds: { walk, run } in m/s (the clips play faster or slower to match; omit them for
     * the clips' own speeds). rates: { idle, walk, … } each clip's playback speed (× 1: quicker or slower steps at
     * the same movement speed). Returns the animator, or null without a character.
     */
    locomotion(states, speeds, rates) {
      if (!character) return null;
      const animator = character.useLocomotion(states, rates);
      if (speeds) character.setSpeeds(speeds);
      setCharMsg(describeCharacter(character));
      return animator;
    },
    /** Play a clip from the animation library on the player character (by name). */
    playClip(name) {
      const i = character?.actions.findIndex((c) => c.name === name) ?? -1;
      return i >= 0 && !!character.playAction(i);
    },
    get character() { return character; },
  },
  get camera() { return camera; },
  physics: {
    move: movePlayer,
    cameraClearance: (origin, dir, max) => cameraClearance(origin, dir, max),
    /** Highest surface the player could stand on at (x, z), from feet height y. */
    groundAt: (x, z, y = Infinity) => groundHeight(x, z, y),
  },
  view: {
    get mode() { return view.mode; },
    get facing() { return view.facing; },
    set: (mode, opts) => setView(mode, opts),
    setFacing: (facing) => setFacing(facing),
  },
  /** Maps without a player controller script get this one, with the Player Spawn's settings. */
  get defaultController() {
    return { source: CONTROLLER_SOURCE, name: 'Player controller', node: playerSpawn?.node ?? map?.root, params: playerSpawn?.params ?? {} };
  },
  message: (text, seconds) => flash(text, seconds * 1000),
  log: (...args) => { console.log('[script]', ...args); toEditor('log', { level: 'log', text: args.map(String).join(' ') }); },
  inputActive: () => gameHasInput(),
  onError: (text, err) => { console.error(text, err); flash(`⚠ ${text}`, 6000, true); },
  onRemove: (node) => {
    cameraBlockers = cameraBlockers.filter((m) => !isBelow(m, node));
    cameraCapsules = cameraCapsules.filter((c) => !isBelow(c.node, node));
  },
};

const _box = new THREE.Box3(), _chest = new THREE.Vector3();
/** The nearest object with onInteract within reach of the player, for the "E" hint. */
function findInteractable() {
  if (!scripts) return null;
  _chest.set(player.pos.x, player.pos.y + 0.9, player.pos.z);
  let best = null, bestD = 2;
  for (const it of scripts.interactables()) {
    const d = _box.setFromObject(it.node).distanceToPoint(_chest);
    if (d < bestD) { best = it; bestD = d; }
  }
  return best;
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
  return { node, spawn, name: playable ? rec.name : null, buffer: playable ? rec.buffer : null, height: playable ? rec.height : null, controller: playable ? rec.controller : null, parts: map.childrenOf(node) };
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
  scripts?.game.emit('respawn', s); // the controller turns the view to face the way the spawn does
}

// ------------------------------------------------------------------ physics

const _n = new THREE.Vector3();

/** How far above the feet a surface may be and still be stepped onto. Steep slopes can't be climbed. */
const climbFor = (normalY) => (normalY >= Math.cos(THREE.MathUtils.degToRad(BODY.maxSlope)) ? BODY.step : 0.02);

/** Highest surface under (x, z) the player can stand on from feetY. Writes its normal to player.groundNormal. */
function groundHeight(x, z, feetY) {
  let g = map ? map.getHeightAt(x, z) : 0;
  player.groundNormal.set(0, 1, 0);
  for (const c of solids) {
    const y = c.surfaceAt(x, z, BODY.radius, _n);
    if (y !== null && y > g && y <= feetY + climbFor(_n.y)) {
      g = y;
      player.groundNormal.copy(_n);
    }
  }
  return g;
}

/** Push the player out of anything too tall (or too steep) to step onto. `prev` is last frame's position. */
function resolveWalls(p, prev) {
  const r = BODY.radius;
  for (const c of solids) {
    if (p.y + BODY.height <= c.box.min.y) continue; // walking underneath
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
  if (e.code === 'KeyE' && !e.repeat && interactFocus && scripts) scripts.interact(interactFocus.node);
  // in the editor: Esc with the mouse free (the first Esc frees it), or Ctrl+P, stops playing
  if (embedded && ((e.code === 'Escape' && !controls.isLocked) || ((e.ctrlKey || e.metaKey) && e.code === 'KeyP'))) {
    e.preventDefault();
    toEditor('stop');
  } else if (!embedded && e.code === 'Escape' && !controls.isLocked && map) {
    setMenu(!menuOpen);
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));

const _prev = new THREE.Vector3();

/**
 * Walk the player by its velocity for dt: slide along walls, climb steps and ramps, land on (and stick to) the
 * ground. body: { radius, height, step, maxSlope } (the controller's settings). Exposed to scripts as game.physics.move.
 */
function movePlayer(dt, body = {}) {
  Object.assign(BODY, body);
  const p = player.pos;
  const prevPos = _prev.copy(p);
  const wasOnGround = player.onGround;
  p.x += player.vel.x * dt;
  p.z += player.vel.z * dt;
  resolveWalls(p, prevPos);
  p.y += player.vel.y * dt;
  const g = groundHeight(p.x, p.z, prevPos.y);
  if (p.y <= g || (wasOnGround && player.vel.y <= 0 && p.y - g <= BODY.step)) {
    // Land, climb ramps/steps, and stick to the ground walking downhill instead of bouncing off it.
    p.y = g;
    player.vel.y = 0;
    player.onGround = true;
  } else {
    player.onGround = false;
  }
  if (p.y < -200) respawn();
  return player.onGround;
}

function update(dt) {
  if (!map) return;
  const active = gameHasInput();
  scripts?.update(dt); // the player controller script moves the player and the camera
  if (character?.unanimated && !unanimatedShown) {
    unanimatedShown = true;
    flash('The player controller hasn\'t picked walking clips: call this.game.player.locomotion({ idle, walk, … }) (see the Player controller template)', 8000, true);
  }
  const p = player.pos;
  $('pos').textContent = `x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}  z ${p.z.toFixed(1)}`;

  // Trigger volumes
  const probe = new THREE.Vector3(p.x, p.y + 0.9, p.z);
  for (const t of map.triggers) {
    const inside = t.contains(probe);
    const scripted = !!t.node.userData.scripts?.length; // its scripts decide what the player sees
    if (inside && !insideTriggers.has(t)) {
      insideTriggers.add(t);
      if (!scripted) flash(`Entered “${t.name}”${t.event ? ` → ${t.event}` : ''}`);
      scripts?.triggerEnter(t.node);
    } else if (!inside && insideTriggers.has(t)) {
      insideTriggers.delete(t);
      if (!scripted) flash(`Left “${t.name}”`);
      scripts?.triggerExit(t.node);
    }
  }

  interactFocus = active ? findInteractable() : null;
  $('prompt').hidden = !interactFocus;
  if (interactFocus) $('prompt-text').textContent = interactFocus.prompt;
}

// ------------------------------------------------------------------ view

const view = { mode: readPref('view', 'first'), facing: readPref('facing', 'free') };
let character = null;
let unanimatedShown = false; // told the player once that the controller didn't pick walking clips
const camRay = new THREE.Raycaster();

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

/**
 * First or third person (third needs a character). sticky: the map asks for it (the controller's "Start in"), so
 * picking another character keeps it. The controller hears 'viewChanged' and turns its camera to match.
 */
function setView(mode, { sticky = false } = {}) {
  if (mode !== 'first' && mode !== 'third') return;
  if (sticky) spawnView = mode;
  if (mode === 'third' && !character) mode = 'first';
  const changed = mode !== view.mode;
  if (changed) {
    view.mode = mode;
    writePref('view', mode);
  }
  if (character) character.root.visible = mode === 'third';
  $('crosshair').hidden = mode === 'third';
  syncViewUI();
  if (changed) scripts?.game.emit('viewChanged', { mode });
}

function setFacing(facing) {
  if (facing !== 'free' && facing !== 'strafe') return;
  view.facing = facing;
  writePref('facing', facing);
  syncViewUI();
}

// ------------------------------------------------------------------ character picker

function readPref(key, fallback) {
  try { return localStorage.getItem(`playtest.${key}`) ?? fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(`playtest.${key}`, value); } catch { /* private mode */ }
}

/**
 * The animation clip library: the editor's (the engine's clips), handed over by ▶ Play, else the one exported in the
 * map. Re-read on reload.
 */
let clipsPromise = null;
const playtestClips = () => (clipsPromise ??= new URLSearchParams(location.search).has('playtest')
  ? idbGet('playtest-clips').catch(() => null) : Promise.resolve(null));
const libraryClips = async () => (await playtestClips()) ?? decodeClips(map?.root.userData.clips);

let charSpec = { kind: 'capsule' };
let tinyChars = [];
let engineChars = []; // characters among the engine's models: [{ file, name, tinyimgenId, controller }]
let fileChar = null; // { name, buffer } of a .glb picked from disk
let charLoadToken = 0;

async function selectCharacter(spec, { switchToThird = true } = {}) {
  const token = ++charLoadToken;
  charSpec = spec;
  renderCharacterTiles();
  setCharMsg(`Loading ${spec.name ?? 'character'}…`);
  try {
    const clips = await libraryClips();
    const next = spec.kind === 'map'
      ? await loadCharacter({ kind: 'file', name: mapPlayer.name, buffer: mapPlayer.buffer }, renderer, { clips })
      : await loadCharacter(spec, renderer, { clips });
    next.settings = controllerSettings(spec);
    if (spec.kind === 'map') {
      next.setHeight(mapPlayer.height);
      next.equip(mapPlayer.parts);
    }
    if (token !== charLoadToken) { next.dispose(); return; } // a newer pick won
    if (character) { scene.remove(character.root); character.dispose(); }
    character = next;
    unanimatedShown = false;
    scene.add(character.root);
    const { kind, ...saved } = spec;
    if (kind !== 'map') writePref('character', JSON.stringify(kind === 'file' ? { kind, name: spec.name } : { kind, ...saved }));
    setCharMsg(describeCharacter(character));
    setView(spawnView ?? (switchToThird ? 'third' : view.mode));
    scripts?.game.emit('characterChanged', { character }); // the controller picks its walking clips
  } catch (err) {
    if (token !== charLoadToken) return;
    console.error(err);
    setCharMsg(`Couldn't load ${spec.name ?? 'character'}: ${err.message}`, true);
  }
}

/** The player controller fields a character plays with: its model meta's `controller` (an engine model's, or the map player's). */
function controllerSettings(spec) {
  const engine = spec.kind === 'engine' ? engineChars.find((c) => c.file === spec.file)
    : spec.kind === 'tinyimgen' ? engineChars.find((c) => c.tinyimgenId === spec.id) : null;
  return { ...(spec.kind === 'map' ? mapPlayer.controller : engine?.controller) };
}

function describeCharacter(c) {
  const anim = {
    locomotion: `walks with ${Object.values(c.states ?? {}).filter(Boolean).join(', ')}`,
    rig: 'no walking clips picked yet', clips: 'its own idle/walk/run clips', static: 'no animations', capsule: 'no animations',
  }[c.kind];
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
    ...engineChars.map((c) => tile(c.name, {
      icon: '🧍', title: `${c.name} (engine/models/${c.file})`,
      selected: charSpec.kind === 'engine' && charSpec.file === c.file,
      onClick: () => selectCharacter({ kind: 'engine', file: c.file, name: c.name }),
    })),
    // tinyimgen's characters the engine doesn't have (the ones it has are played from the engine)
    ...tinyChars.filter((c) => !engineChars.some((e) => e.tinyimgenId === c.id)).map((c) => tile(c.name, {
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
  // the engine's characters (engine/models/) need nothing else running; tinyimgen adds the ones the engine lacks
  const engineLoaded = listEngineModels().then((list) => {
    engineChars = list.filter((m) => m.meta?.tinyimgen?.role === 'character')
      .map((m) => ({ file: m.file, name: m.name, tinyimgenId: m.meta.tinyimgen.id, controller: m.meta.controller }));
    renderCharacterTiles();
  }).catch(() => {}); // served without the engine library
  const tinyLoaded = engineLoaded.then(() => listTinyimgenCharacters()).then((list) => {
    tinyChars = list;
    renderCharacterTiles();
    if (!list.length && !engineChars.length) setCharMsg('tinyimgen has no rigged characters yet: build one with "Rig + animations" on.');
  }).catch((err) => {
    $('chars-note').textContent = engineChars.length
      ? 'tinyimgen isn\'t running: only the engine\'s characters are listed.'
      : `${err.message} at /tinyimgen. Start tinyimgen (server.py) to pick its characters.`;
  });
  await engineLoaded;
  let spec = { kind: 'capsule', name: 'Capsule' };
  if (saved?.kind === 'engine' && engineChars.some((c) => c.file === saved.file)) spec = saved;
  else if (saved?.kind === 'tinyimgen') {
    const copy = engineChars.find((c) => c.tinyimgenId === saved.id);
    if (copy) spec = { kind: 'engine', file: copy.file, name: copy.name }; // the engine has it: no tinyimgen needed
    else {
      await tinyLoaded; // only load it from tinyimgen if tinyimgen is up and still has it
      if (tinyChars.some((c) => c.id === saved.id)) spec = saved;
    }
  } else if (saved?.kind === 'file' && fileChar) spec = { kind: 'file', ...fileChar };
  if (charSpec.kind === 'map') return; // the map brought its own player
  const wantThird = view.mode === 'third';
  view.mode = 'first';
  await selectCharacter(spec, { switchToThird: false });
  if (charSpec.kind === 'map') return;
  setView(spawnView ?? (wantThird ? 'third' : 'first'));
}

let flashTimer;
function flash(msg, ms = 2000, error = false) {
  const el = $('event');
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.style.display = 'block';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.style.display = 'none'; }, ms);
}

// ------------------------------------------------------------------ UI / loop

// No "click to play": a loaded map plays straight away with the keyboard. Clicking the game captures the mouse for
// looking around; Esc frees it and opens the menu (character, view), whose Resume captures it again.
let menuOpen = false;
function setMenu(open) {
  menuOpen = open;
  $('overlay').style.display = open ? 'flex' : 'none';
  syncMouseHint();
}
function gameHasInput() { return !menuOpen && !!map && document.hasFocus(); }
function syncMouseHint() { $('mouse-hint').hidden = menuOpen || !map || controls.isLocked; }
if (embedded) $('mouse-hint').innerHTML = 'Click to look around · <kbd>Esc</kbd> stops'; // in the editor, Esc with the mouse free stops
$('play').addEventListener('click', () => { setMenu(false); controls.lock(); });
renderer.domElement.addEventListener('click', () => { if (!menuOpen && map && !controls.isLocked) controls.lock(); });
controls.addEventListener('lock', () => { setMenu(false); toEditor('locked', { locked: true }); });
// In a tab Esc brings up the menu; in the editor's play mode it only frees the mouse (Esc again stops).
controls.addEventListener('unlock', () => { if (map && !embedded) setMenu(true); syncMouseHint(); toEditor('locked', { locked: false }); });
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
  const dt = Math.min(timer.getDelta(), 0.05);
  if (!paused) update(dt);
  renderer.render(scene, camera);
  perf.end();
});

syncViewUI();
initCharacters();
// Handy for console tinkering (like window.editor in the editor).
window.playtest = { player, BODY, view, controls, keys, camera, get map() { return map; }, get character() { return character; }, get scripts() { return scripts; }, setView, selectCharacter };

const params = new URLSearchParams(location.search);

// The editor re-exports the playtest when a prop it uses is re-saved in tinyimgen; pick that up in place.
if (params.has('playtest')) {
  let reloading = Promise.resolve();
  new BroadcastChannel('3dmap-playtest').onmessage = ({ data }) => {
    if (data?.type !== 'reload') return;
    reloading = reloading.then(async () => {
      clipsPromise = null; // the editor may have changed its clips too
      const buf = await idbGet('playtest');
      if (buf) await loadMapBuffer(buf, 'Playtest', { playtest: true, keep: !!map });
      if (charSpec.kind !== 'map' && charSpec.kind !== 'capsule') await selectCharacter(charSpec, { switchToThird: false });
    }).catch((err) => console.error('playtest reload failed', err));
  };
}

(async () => {
  // Opened to play a map (▶ Play, ↗, ?map=): straight in, with no card. Opened on its own: the card, to load a .glb.
  const auto = params.has('playtest') || !!params.get('map');
  if (!auto) { setMenu(true); return; }
  $('loading').hidden = false;
  try {
    let buf = null;
    if (params.has('playtest')) buf = await idbGet('playtest');
    else buf = await (await fetch(params.get('map'))).arrayBuffer();
    if (!buf) throw new Error('nothing to play: press ▶ Play in the editor');
    await loadMapBuffer(buf, params.has('playtest') ? 'Playtest' : params.get('map'), { playtest: params.has('playtest') });
  } catch (err) {
    console.error(err);
    $('subtitle').textContent = `Failed to load map: ${err.message}`;
    setMenu(true);
  } finally {
    $('loading').hidden = true;
  }
})();
