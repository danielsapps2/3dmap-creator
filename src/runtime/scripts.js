/**
 * Scripts — runs the scripts attached to objects in a map exported by 3D Map Creator. Drop it into your three.js
 * game next to MapLoader.js (it depends only on `three` and MapLoader.js).
 *
 *   const map = await loadMap('/maps/level1.glb');
 *   const scripts = await runScripts(map, {
 *     player: { position: playerFeetPosition, teleport(x, y, z) { ... } },
 *     message: (text, seconds) => showOnHud(text),
 *   });
 *   // every frame:                                  scripts.update(dt);
 *   // when the player enters / leaves a trigger:     scripts.triggerEnter(trigger.node) / scripts.triggerExit(...)
 *   // when the player presses "use" near an object:  scripts.interact(node)   (scripts.interactables() lists them)
 *   // when you unload the map:                       scripts.dispose();
 *
 * The map's scene root holds the sources (`root.userData.scripts`: { id: { name, source } }) and each scripted node
 * lists its scripts (`node.userData.scripts`: [{ script: id, name, params }]). A script is an ES module:
 *
 *   export const params = { speed: { type: 'number', default: 90, label: 'Speed (°/s)' } };
 *   export default class Spin {
 *     start() {}                       // once, before the first update
 *     update(dt) { this.object.rotation.y += THREE.MathUtils.degToRad(this.params.speed) * dt; }
 *     onTriggerEnter(player) {}        // on a Trigger Volume: the player walked in (onTriggerExit: out)
 *     onInteract(player) {}            // the player pressed E near this object (set this.prompt for the hint)
 *     onDestroy() {}                   // the object was destroyed, or the map unloaded
 *   }
 *
 * Each instance gets `this.object` (its node), `this.params` (the values set in the editor, with defaults filled
 * in), `this.game` (the API below) and `this.THREE`. Characters animate through `this.game.animator(object)` and
 * `this.game.stateMachine({ object, initial, states })` (animator.js). Scripts can't `import` (they run from a blob URL): everything
 * they need comes through those. A script that throws is stopped and reported; the others keep running.
 */
import * as THREE from 'three';
import { createCollider, createCapsuleCollider } from './MapLoader.js';
import { Animator, createStateMachine, decodeClips } from './animator.js';

/** Import a script's source as a module. */
export async function loadScriptModule(source) {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A script's `params` export as full field definitions: { key: { type, default, label, min, max, step, options } }.
 * Shorthand values are allowed: `{ speed: 90, label: 'Hi', on: true }` infers number / text / bool.
 */
export function normalizeParams(schema) {
  const out = {};
  if (!schema || typeof schema !== 'object') return out;
  for (const [key, raw] of Object.entries(schema)) {
    const def = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : { default: raw };
    if (!def.type) {
      const d = def.default;
      def.type = def.options ? 'select' : typeof d === 'number' ? 'number' : typeof d === 'boolean' ? 'bool'
        : typeof d === 'string' && /^#[0-9a-f]{6}$/i.test(d) ? 'color' : 'text';
    }
    if (def.default === undefined) def.default = { number: 0, bool: false, color: '#ffffff', select: def.options?.[0] ?? '' }[def.type] ?? '';
    def.label ??= key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
    out[key] = def;
  }
  return out;
}

/** The values a script instance runs with: what was set on the object, defaults for the rest. */
export function resolveParams(fields, values = {}) {
  const out = {};
  for (const [key, def] of Object.entries(fields)) out[key] = values?.[key] !== undefined ? values[key] : def.default;
  return out;
}

const isBelow = (node, root) => { for (let o = node; o; o = o.parent) if (o === root) return true; return false; };

/**
 * Start every script in the map. host (all optional):
 *   player   { position: Vector3 (feet), teleport(x, y, z), ... } — passed to the hooks and as game.player
 *   camera   the game camera (game.camera)
 *   message  (text, seconds) => void — game.message shows text to the player (default: console.log)
 *   onError  (text, error) => void — a script failed (default: console.error)
 *   log      (...args) => void — game.log (default: console.log)
 *   inputActive  () => bool — whether the game has the keyboard now (game.input.active; default: mouse captured)
 *   onRemove (node) => void — game.destroy removed a node: drop it from your own lists (camera blockers etc.)
 *   keys     false to not listen to the keyboard (then call scripts.keyDown(code) / keyUp(code) yourself)
 *   clips    animation clips for game.animator (default: the library exported in the map, root.userData.clips)
 *   physics, view   what a player controller script uses (see PlayerController.script.js): game.physics, game.view
 *   defaultController  { source, name, node, params }: started when no script in the map exports `controlsPlayer`,
 *            or when the map's controller crashes, so the player can always move
 */
export async function runScripts(map, host = {}) {
  const sources = map.root.userData.scripts ?? {};
  const report = (text, err) => (host.onError ?? ((t, e) => console.error(t, e)))(text, err);
  const modules = {};
  for (const [id, s] of Object.entries(sources)) {
    try {
      modules[id] = await loadScriptModule(s.source);
    } catch (err) {
      report(`Script "${s.name}" didn't load: ${err.message}`, err);
    }
  }

  // ------------------------------------------------------------------ input
  const down = new Set(), pressed = new Set();
  const mouse = { dx: 0, dy: 0, wheel: 0 }; // this frame
  const keyDown = (code) => { if (!down.has(code)) pressed.add(code); down.add(code); };
  const keyUp = (code) => down.delete(code);
  const onKeyDown = (e) => keyDown(e.code), onKeyUp = (e) => keyUp(e.code);
  const onMouse = (e) => { mouse.dx += e.movementX ?? 0; mouse.dy += e.movementY ?? 0; };
  const onWheel = (e) => { mouse.wheel += e.deltaY; };
  const onBlur = () => down.clear();
  const listening = host.keys !== false && typeof window !== 'undefined';
  if (listening) {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    document.addEventListener('mousemove', onMouse);
    window.addEventListener('wheel', onWheel, { passive: true });
  }

  // ------------------------------------------------------------------ events
  const listeners = new Map();
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  };
  const emit = (event, data) => {
    for (const fn of [...(listeners.get(event) ?? [])]) {
      try { fn(data); } catch (err) { report(`A listener for "${event}" failed: ${err.message}`, err); }
    }
  };

  // ------------------------------------------------------------------ colliders
  const rebuild = (c) => (c.type === 'capsule' ? createCapsuleCollider(c.node) : createCollider(c.node));
  const disable = (c) => {
    if (c.disabled) return;
    c.disabled = true;
    c._enabled = { surfaceAt: c.surfaceAt, overlaps: c.overlaps, pushOut: c.pushOut, rayDistance: c.rayDistance };
    c.surfaceAt = () => null;
    c.overlaps = () => false;
    c.pushOut = () => false;
    if (c.rayDistance) c.rayDistance = (o, d, far = Infinity) => far;
  };
  const enable = (c) => {
    if (!c.disabled) return;
    Object.assign(c, c._enabled);
    c.disabled = false;
  };
  const collidersOf = (node) => map.colliders.filter((c) => isBelow(c.node, node));

  // ------------------------------------------------------------------ animation
  const clips = host.clips ?? decodeClips(map.root.userData.clips);
  const animators = new Map(); // node -> Animator (null: not a character)
  const machines = [];         // { sm, node }
  const animatorOf = (node) => {
    if (!node) return null;
    if (!animators.has(node)) {
      let a = null;
      try {
        const holding = map.held.filter((x) => x.parent === node && /^(Left|Right)Hand_Socket$/.test(x.attachedTo)).map((x) => x.attachedTo.slice(0, x.attachedTo.indexOf('Hand')));
        a = new Animator(node, clips, { holding });
      } catch (err) {
        report(`game.animator: ${err.message}`, err);
      }
      animators.set(node, a);
    }
    return animators.get(node);
  };
  const dropAnimation = (root) => {
    for (const [node, a] of animators) if (isBelow(node, root)) { a?.dispose(); animators.delete(node); }
    for (let i = machines.length - 1; i >= 0; i--) if (machines[i].node && isBelow(machines[i].node, root)) machines.splice(i, 1);
  };

  // ------------------------------------------------------------------ API
  const records = [];
  const game = {
    THREE,
    map,
    time: 0,
    dt: 0,
    get player() { return host.player ?? null; },
    get camera() { return host.camera ?? null; },
    get physics() { return host.physics ?? null; },
    get view() { return host.view ?? null; },
    /** A map object by its name in the editor. */
    find: (name) => map.findByName(name) ?? null,
    /** Map objects with this tag (set in the editor's Game data). */
    findByTag: (tag) => map.findByTag(tag),
    byId: (id) => map.byId.get(id) ?? null,
    /** Show text to the player for a few seconds. */
    message: (text, seconds = 2.5) => (host.message ? host.message(String(text), seconds) : console.log(text)),
    log: (...args) => (host.log ? host.log(...args) : console.log('[script]', ...args)),
    input: {
      isDown: (code) => down.has(code),
      pressed: (code) => pressed.has(code),
      mouse,
      /** The mouse is captured (pointer lock): mouse movement is for the game. */
      get locked() { return typeof document !== 'undefined' && !!document.pointerLockElement; },
      /** The game has the keyboard (host.inputActive: e.g. focused, no menu open). Defaults to `locked`. */
      get active() { return host.inputActive ? !!host.inputActive() : game.input.locked; },
    },
    /** Listen for an event (a Trigger Volume's event name fires when the player enters it). Returns an unsubscribe. */
    on,
    emit,
    /** Distance from the player's feet to the object's position (Infinity without a player). */
    distanceToPlayer(node) {
      const p = host.player?.position;
      return p ? node.getWorldPosition(new THREE.Vector3()).distanceTo(p) : Infinity;
    },
    /** Turn an object's collision (and its children's) off or on. */
    setCollidable(node, collidable) {
      for (const c of collidersOf(node)) (collidable ? enable : disable)(c);
    },
    /** Names of the animation clips characters can play (the editor's clip library). */
    get clips() { return [...new Set(clips.map((c) => c.name))]; },
    /** The Animator of a tinyimgen character in the map (play / crossfade clips), or null. See animator.js. */
    animator: animatorOf,
    /**
     * A state machine (see animator.js): { object (a character, for its clips) or animator, initial, states }.
     * It's updated every frame for you, before the animation.
     */
    stateMachine(def) {
      const sm = createStateMachine({ ...def, animator: def.animator ?? animatorOf(def.object) });
      machines.push({ sm, node: def.object ?? def.animator?.node ?? null });
      return sm;
    },
    /** Remove an object (and its children) from the game: its scripts get onDestroy, its collision goes. */
    destroy(node) {
      if (!node?.parent) return;
      for (const r of records) if (r.alive && isBelow(r.node, node)) { call(r, 'onDestroy'); r.alive = false; }
      dropAnimation(node);
      game.setCollidable(node, false);
      node.removeFromParent();
      host.onRemove?.(node);
    },
  };

  const call = (r, hook, ...args) => {
    const fn = r.inst[hook];
    if (typeof fn !== 'function') return;
    try {
      const out = fn.apply(r.inst, args);
      if (out && typeof out.catch === 'function') out.catch((err) => fail(r, hook, err));
    } catch (err) {
      fail(r, hook, err);
    }
  };
  const fail = (r, hook, err) => {
    if (!r.alive) return;
    r.alive = false;
    report(`${r.name} on "${r.node.userData.name ?? r.node.name}" stopped (${hook}): ${err.message}`, err);
  };

  /** An instance of a loaded script module on a node (null if it can't be made). */
  const instantiate = (mod, node, name, values) => {
    const Cls = mod.default;
    if (typeof Cls !== 'function') { report(`Script "${name}" has no default export class`); return null; }
    const r = { node, name, inst: null, alive: true, controls: !!mod.controlsPlayer };
    try {
      r.inst = new Cls();
    } catch (err) {
      report(`${name} couldn't start: ${err.message}`, err);
      return null;
    }
    Object.assign(r.inst, { object: node, params: resolveParams(normalizeParams(mod.params), values), game, THREE });
    records.push(r);
    return r;
  };

  // one instance per attached script
  const scripted = [];
  map.root.traverse((n) => { if (Array.isArray(n.userData?.scripts) && n.userData.scripts.length) scripted.push(n); });
  for (const node of scripted) {
    for (const ref of node.userData.scripts) {
      const mod = modules[ref.script];
      if (mod) instantiate(mod, node, sources[ref.script]?.name ?? ref.name ?? 'script', ref.params);
    }
  }
  // the player controller: the map's, or the default one
  let fallback = null;
  const startFallback = async () => {
    const d = host.defaultController;
    if (!d) return;
    try {
      fallback ??= await loadScriptModule(d.source);
      const r = instantiate(fallback, d.node ?? map.root, d.name ?? 'Player controller', d.params);
      if (r) call(r, 'start');
    } catch (err) {
      report(`The default player controller didn't load: ${err.message}`, err);
    }
  };
  for (const r of [...records]) call(r, 'start');
  if (!records.some((r) => r.controls && r.alive)) await startFallback();
  let recovering = false, fallbackStarts = 0;

  // colliders of scripted objects (and their children) follow them when scripts move them
  const moving = map.colliders.filter((c) => scripted.some((n) => isBelow(c.node, n)));
  const _m = new THREE.Matrix4();

  return {
    game,
    get instances() { return records.filter((r) => r.alive).map((r) => r.inst); },
    keyDown,
    keyUp,
    update(dt) {
      game.dt = dt;
      game.time += dt;
      // the player controller first, so everything else sees where the player is this frame
      for (const r of records) if (r.alive && r.controls) call(r, 'update', dt);
      for (const r of records) if (r.alive && !r.controls) call(r, 'update', dt);
      if (host.defaultController && !recovering && fallbackStarts < 3 && !records.some((r) => r.controls && r.alive)) {
        recovering = true; // the map's controller crashed: hand the player to the default one
        fallbackStarts++;
        startFallback().finally(() => { recovering = false; });
      }
      for (const m of [...machines]) {
        try { m.sm.update(dt); } catch (err) { report(`A state machine failed in "${m.sm.state}": ${err.message}`, err); machines.splice(machines.indexOf(m), 1); }
      }
      for (const a of animators.values()) a?.update(dt);
      pressed.clear();
      mouse.dx = mouse.dy = mouse.wheel = 0;
      if (moving.length) {
        map.root.updateMatrixWorld();
        for (const c of moving) {
          if (!c.node.parent || _m.copy(c.node.matrixWorld).equals(c.matrix)) continue;
          const wasDisabled = c.disabled;
          enable(c);
          Object.assign(c, rebuild(c));
          if (wasDisabled) disable(c);
        }
      }
    },
    /** The player entered a Trigger Volume node: its scripts' onTriggerEnter, then its event name on the bus. */
    triggerEnter(node) {
      for (const r of records) if (r.alive && r.node === node) call(r, 'onTriggerEnter', host.player ?? null);
      const event = node.userData.params?.event;
      if (event) emit(event, { trigger: node, entered: true });
      emit('triggerEnter', { trigger: node });
    },
    triggerExit(node) {
      for (const r of records) if (r.alive && r.node === node) call(r, 'onTriggerExit', host.player ?? null);
      emit('triggerExit', { trigger: node });
    },
    /** Objects the player can use: [{ node, prompt }] for every live script with onInteract. */
    interactables() {
      const out = new Map();
      for (const r of records) {
        if (!r.alive || typeof r.inst.onInteract !== 'function' || !r.node.parent || r.inst.interactable === false) continue;
        if (!out.has(r.node)) out.set(r.node, r.inst.prompt ?? r.inst.params?.prompt ?? `Use ${r.node.userData.name ?? r.node.name}`);
      }
      return [...out].map(([node, prompt]) => ({ node, prompt }));
    },
    interact(node) {
      for (const r of records) if (r.alive && r.node === node) call(r, 'onInteract', host.player ?? null);
    },
    dispose() {
      for (const r of records) if (r.alive) { call(r, 'onDestroy'); r.alive = false; }
      dropAnimation(map.root);
      listeners.clear();
      if (listening) {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('blur', onBlur);
        document.removeEventListener('mousemove', onMouse);
        window.removeEventListener('wheel', onWheel);
      }
    },
  };
}
