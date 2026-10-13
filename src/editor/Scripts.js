// The map's scripts: JavaScript modules attached to objects (entity.scripts = [{ id, params }]) and run by
// src/runtime/scripts.js in the playtest, or in your own game. They're saved with the project and exported inside
// the map GLB (the scene's userData.scripts; each node's userData.scripts).
import { uid } from '../core/utils.js';
import { fileStem, stemOf, dirName, uniquePath } from '../core/paths.js';
import { loadScriptModule, normalizeParams } from '../runtime/scripts.js';
import CONTROLLER_SOURCE from '../runtime/PlayerController.script.js?raw';

export const HOOKS = ['start', 'update', 'onTriggerEnter', 'onTriggerExit', 'onInteract', 'onDestroy'];

export class ScriptLibrary extends EventTarget {
  constructor() {
    super();
    this.scripts = [];
    this._meta = new Map(); // id -> { source, promise }
  }

  list() { return this.scripts; }
  get(id) { return this.scripts.find((s) => s.id === id) ?? null; }
  changed(detail = {}) { this.dispatchEvent(new CustomEvent('changed', { detail })); }

  /** A script is a file: path ("scripts/Door.js") is where it lives in the project; name is the file's stem. */
  add({ name = 'Script', source = TEMPLATES[0].source, path = null, dir = 'scripts' } = {}) {
    path = path ?? uniquePath(dir, fileStem(name), '.js', this._paths());
    const script = { id: uid(), path, name: stemOf(path), source };
    this.scripts.push(script);
    this.changed({ script, source: true });
    return script;
  }

  /** patch: { source }, { name } (renames the file, same folder) or { path } (moves it). */
  update(id, patch) {
    const s = this.get(id);
    if (!s) return;
    patch = { ...patch };
    if (patch.name !== undefined) {
      const stem = fileStem(patch.name.trim() || s.name);
      if (stem !== s.name) patch.path = uniquePath(dirName(s.path), stem, '.js', this._paths(s));
      delete patch.name;
    }
    if (patch.path !== undefined) patch.name = stemOf(patch.path);
    Object.assign(s, patch);
    this.changed({ script: s, source: patch.source !== undefined });
  }

  _paths(self = null) { return this.scripts.filter((s) => s !== self).map((s) => s.path); }
  byPath(path) { return this.scripts.find((s) => s.path.toLowerCase() === path.toLowerCase()) ?? null; }

  remove(id) {
    this.scripts = this.scripts.filter((s) => s.id !== id);
    this._meta.delete(id);
    this.changed({ removed: id });
  }

  clear() { this.load([]); }

  load(list) {
    this.scripts = [];
    for (const s of (Array.isArray(list) ? list : []).filter((x) => x && typeof x.id === 'string' && typeof x.source === 'string')) {
      const path = s.path ?? uniquePath('scripts', fileStem(s.name ?? 'Script'), '.js', this._paths());
      this.scripts.push({ id: s.id, path, name: stemOf(path), source: s.source });
    }
    this._meta.clear();
    this.changed({ source: true });
  }

  toJSON() { return this.scripts.map((s) => ({ ...s })); }

  /** A player controller script: it exports `controlsPlayer` (the playtest hands it the player). */
  isController(id) { return /export\s+const\s+controlsPlayer\s*=\s*true/.test(this.get(id)?.source ?? ''); }

  /**
   * What a script declares, by importing it: { fields (normalized params), hooks: [names], error }. Cached per
   * source. Importing runs the module's top level, the same as the playtest will.
   */
  meta(id) {
    const s = this.get(id);
    if (!s) return Promise.resolve({ fields: {}, hooks: [], error: 'Missing script' });
    const cached = this._meta.get(id);
    if (cached?.source === s.source) return cached.promise;
    const promise = inspectSource(s.source);
    this._meta.set(id, { source: s.source, promise });
    return promise;
  }
}

export async function inspectSource(source) {
  try {
    const mod = await loadScriptModule(source);
    const Cls = mod.default;
    if (typeof Cls !== 'function') return { fields: normalizeParams(mod.params), hooks: [], error: 'It needs `export default class { … }`' };
    const proto = Cls.prototype ?? {};
    return { fields: normalizeParams(mod.params), hooks: HOOKS.filter((h) => typeof proto[h] === 'function'), error: null };
  } catch (err) {
    return { fields: {}, hooks: [], error: err.message };
  }
}

/** The scripts an object list uses, for the export: { id: { name, source } }. */
export function usedScripts(library, objects) {
  const out = {};
  for (const o of objects) {
    for (const ref of o.entity.scripts ?? []) {
      const s = library.get(ref.id);
      if (s) out[s.id] = { name: s.name, source: s.source };
    }
  }
  return out;
}

// ------------------------------------------------------------------ templates

const t = (strings) => strings[0].replace(/^\n/, '');

export const TEMPLATES = [
  {
    name: 'Empty', description: 'Every hook, ready to fill in',
    source: t`
// Parameters show up in the Inspector of every object this script is attached to.
export const params = {
  speed: { type: 'number', default: 1, min: 0, step: 0.1, label: 'Speed' },
};

export default class {
  // this.object (the object), this.params, this.game (find, message, input, on/emit, destroy…), this.THREE

  start() {
  }

  update(dt) {
  }

  // onTriggerEnter(player) {}  // attached to a Trigger Volume: the player walked in
  // onTriggerExit(player) {}
  // onInteract(player) {}      // the player pressed E nearby (set this.prompt to change the hint)
  // onDestroy() {}
}
`,
  },
  {
    name: 'Player controller', description: 'On the Player Spawn: how the player moves, looks and jumps',
    source: CONTROLLER_SOURCE,
  },
  {
    name: 'Spin', description: 'Turns the object around an axis',
    source: t`
export const params = {
  speed: { type: 'number', default: 90, step: 5, label: 'Speed (°/s)' },
  axis: { type: 'select', options: ['x', 'y', 'z'], default: 'y' },
};

export default class Spin {
  update(dt) {
    this.object.rotation[this.params.axis] += this.THREE.MathUtils.degToRad(this.params.speed) * dt;
  }
}
`,
  },
  {
    name: 'Bob', description: 'Floats up and down',
    source: t`
export const params = {
  height: { type: 'number', default: 0.25, step: 0.05, label: 'Height (m)' },
  period: { type: 'number', default: 2, min: 0.1, step: 0.1, label: 'Period (s)' },
};

export default class Bob {
  start() {
    this.baseY = this.object.position.y;
    this.phase = Math.random() * Math.PI * 2;
  }

  update() {
    const t = (this.game.time / this.params.period) * Math.PI * 2 + this.phase;
    this.object.position.y = this.baseY + Math.sin(t) * this.params.height;
  }
}
`,
  },
  {
    name: 'Door', description: 'Swings open and shut when the player presses E',
    source: t`
// Turns the object around its own pivot. Put the pivot on the hinge: parent the door to an Empty at the hinge
// and attach this to the Empty.
export const params = {
  angle: { type: 'number', default: 90, step: 5, label: 'Open angle (°)' },
  time: { type: 'number', default: 0.6, min: 0.05, step: 0.05, label: 'Swing time (s)' },
  locked: { type: 'bool', default: false },
  key: { type: 'text', default: '', label: 'Opens on event' },
};

export default class Door {
  start() {
    this.closedY = this.object.rotation.y;
    this.open = false;
    this.t = 0;
    if (this.params.key) this.game.on(this.params.key, () => { this.params.locked = false; this.toggle(true); });
  }

  get prompt() { return this.params.locked ? 'Locked' : this.open ? 'Close' : 'Open'; }

  onInteract() {
    if (this.params.locked) this.game.message("It's locked.");
    else this.toggle(!this.open);
  }

  toggle(open) { this.open = open; }

  update(dt) {
    this.t = Math.min(1, Math.max(0, this.t + (this.open ? dt : -dt) / this.params.time));
    const ease = this.t * this.t * (3 - 2 * this.t);
    this.object.rotation.y = this.closedY + this.THREE.MathUtils.degToRad(this.params.angle) * ease;
  }
}
`,
  },
  {
    name: 'Pickup', description: 'Collected with E (or by walking into it)',
    source: t`
export const params = {
  item: { type: 'text', default: 'Coin' },
  touch: { type: 'bool', default: false, label: 'Pick up on touch' },
  radius: { type: 'number', default: 1, min: 0.1, step: 0.1, label: 'Touch radius (m)' },
};

export default class Pickup {
  get prompt() { return \`Take \${this.params.item}\`; }

  update() {
    if (this.params.touch && this.game.distanceToPlayer(this.object) < this.params.radius) this.collect();
  }

  onInteract() { this.collect(); }

  collect() {
    this.game.message(\`Picked up \${this.params.item}\`);
    this.game.emit('pickup', { item: this.params.item, object: this.object });
    this.game.destroy(this.object);
  }
}
`,
  },
  {
    name: 'Message zone', description: 'On a Trigger Volume: shows text when the player walks in',
    source: t`
export const params = {
  text: { type: 'text', default: 'You feel the warmth of the fire.' },
  seconds: { type: 'number', default: 3, min: 0.5, step: 0.5 },
  once: { type: 'bool', default: true, label: 'Only once' },
};

export default class MessageZone {
  onTriggerEnter() {
    if (this.shown && this.params.once) return;
    this.shown = true;
    this.game.message(this.params.text, this.params.seconds);
  }
}
`,
  },
  {
    name: 'Flicker', description: 'On a Point Light: flickers like a fire',
    source: t`
export const params = {
  amount: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.05, label: 'Amount' },
  speed: { type: 'number', default: 8, min: 0.1, step: 0.5 },
};

export default class Flicker {
  start() {
    this.light = this.object.isLight ? this.object : this.object.getObjectByProperty('isLight', true);
    this.base = this.light?.intensity ?? 0;
  }

  update() {
    if (!this.light) return;
    const t = this.game.time * this.params.speed;
    const n = Math.sin(t) * 0.5 + Math.sin(t * 2.7 + 1.3) * 0.3 + Math.sin(t * 6.1 + 4) * 0.2; // -1..1
    this.light.intensity = this.base * (1 + n * this.params.amount);
  }
}
`,
  },
  {
    name: 'Animate', description: 'On a character: plays an animation clip on repeat',
    source: t`
// Clips come from the animation library (🎬 Animate), plus the character's own Idle, Walk and Run.
export const params = {
  clip: { type: 'clip', default: 'Idle' },
  speed: { type: 'number', default: 1, min: 0, step: 0.1 },
};

export default class Animate {
  start() {
    this.anim = this.game.animator(this.object);
    this.anim?.play(this.params.clip, { loop: true, speed: this.params.speed });
  }
}
`,
  },
  {
    name: 'NPC states', description: 'On a character: an animation state machine (greets you, sits on E)',
    source: t`
export const params = {
  idle: { type: 'clip', default: 'Idle' },
  greet: { type: 'clip', default: 'Salute', label: 'Greeting clip' },
  sit: { type: 'clip', default: 'Sitting Idle', label: 'Sitting clip' },
  radius: { type: 'number', default: 3, min: 0.5, step: 0.5, label: 'Greet within (m)' },
  line: { type: 'text', default: 'Well met, traveller.' },
};

export default class NpcStates {
  start() {
    const p = this.params;
    // Each state plays a clip. update() returns the next state's name; next: where a one-shot clip leads.
    this.fsm = this.game.stateMachine({
      object: this.object,
      initial: 'idle',
      states: {
        idle: {
          clip: p.idle,
          update: () => {
            if (!this.near()) this.greeted = false;
            return this.near() && !this.greeted ? 'greet' : null;
          },
        },
        greet: {
          clip: p.greet, loop: false, next: 'idle',
          enter: () => { this.greeted = true; this.game.message(p.line); },
        },
        sitting: { clip: p.sit, loop: true },
      },
    });
  }

  near() { return this.game.distanceToPlayer(this.object) < this.params.radius; }

  get prompt() { return this.fsm?.state === 'sitting' ? 'Ask to stand' : 'Ask to sit'; }

  onInteract() { this.fsm.go(this.fsm.state === 'sitting' ? 'idle' : 'sitting'); }
}
`,
  },
  {
    name: 'Moving platform', description: 'Slides back and forth (its collision follows)',
    source: t`
export const params = {
  x: { type: 'number', default: 0, step: 0.5, label: 'Move X (m)' },
  y: { type: 'number', default: 2, step: 0.5, label: 'Move Y (m)' },
  z: { type: 'number', default: 0, step: 0.5, label: 'Move Z (m)' },
  period: { type: 'number', default: 4, min: 0.1, step: 0.5, label: 'Round trip (s)' },
};

export default class MovingPlatform {
  start() {
    this.from = this.object.position.clone();
    this.offset = new this.THREE.Vector3(this.params.x, this.params.y, this.params.z);
  }

  update() {
    const k = 0.5 - 0.5 * Math.cos((this.game.time / this.params.period) * Math.PI * 2);
    this.object.position.copy(this.from).addScaledVector(this.offset, k);
  }
}
`,
  },
];
