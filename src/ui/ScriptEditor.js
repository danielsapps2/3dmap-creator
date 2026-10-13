// Code editor for the map's scripts (CodeMirror 6, loaded the first time it opens).
import { h, button, toast, modal } from './dom.js';
import { inspectSource, HOOKS } from '../editor/Scripts.js';

// What a script can reach, for autocompletion and the reference panel.
const THIS = [
  ['object', 'The object this script is attached to (a THREE.Object3D: position, rotation, scale, visible…)'],
  ['params', 'This object\'s values for the script\'s `params` (set in the Inspector)'],
  ['game', 'The game API (below)'],
  ['THREE', 'The three.js namespace (Vector3, MathUtils, …): scripts can\'t import'],
  ['prompt', 'Set it to change the "E · …" hint shown near an object with onInteract'],
  ['interactable', 'Set it to false to hide the E hint for now'],
];
const GAME = [
  ['time', 'Seconds since the map started'],
  ['dt', 'Seconds since the last frame'],
  ['player', 'The player: position (feet), velocity, onGround, character, spawn, respawn(), teleport(), playClip(name)'],
  ['physics', 'For a player controller: move(dt, { radius, height, step, maxSlope }), cameraClearance(origin, dir, max), groundAt(x, z, y)'],
  ['view', 'mode (\'first\' | \'third\'), facing (\'free\' | \'strafe\'), set(mode), setFacing(facing)'],
  ['camera', 'The game camera'],
  ['map', 'The loaded map (MapLoader): objects, markers, colliders, getHeightAt(x, z)…'],
  ['find(name)', 'A map object by its name in the editor'],
  ['findByTag(tag)', 'Map objects with a tag (Game data → Tags)'],
  ['byId(id)', 'A map object by its id'],
  ['message(text, seconds)', 'Show text to the player'],
  ['log(...args)', 'console.log, labelled'],
  ['input', 'Keyboard: isDown(code), pressed(code) (this frame). Codes like "KeyF", "Space", "Digit1"'],
  ['on(event, fn)', 'Listen for an event; returns an unsubscribe function. A Trigger Volume\'s event name fires when the player enters it'],
  ['emit(event, data)', 'Send an event to every listener'],
  ['distanceToPlayer(object)', 'Metres from the player\'s feet to an object'],
  ['setCollidable(object, on)', 'Turn an object\'s collision off or on'],
  ['destroy(object)', 'Remove an object (its scripts get onDestroy)'],
  ['animator(object)', 'Animation for a tinyimgen character: play(clip, { fade, loop, speed }), state, stop(), onFinished(fn)'],
  ['stateMachine(def)', '{ object, initial, states: { name: { clip, loop, next, duration, enter, exit, update } } }: updated for you'],
  ['clips', 'Names of the clips characters can play'],
];
const ANIM = [
  ['play(name, opts)', 'Crossfade to a clip ({ fade = 0.25, loop, speed, restart }). Returns a promise that resolves when a one-shot ends'],
  ['state', 'The clip playing'],
  ['time', 'Seconds into it'],
  ['stop(fade)', 'Fade back to the exported pose'],
  ['onFinished(fn)', 'fn(name) whenever a one-shot ends'],
  ['has(name)', 'Whether the clip exists'],
  ['speed', 'Playback speed of every clip'],
];
const FSM = [
  ['state / previous', 'The current and last state'],
  ['time', 'Seconds in the current state'],
  ['go(name, data)', 'Switch state (runs exit, then enter(sm, data))'],
];
const INPUT = [['isDown(code)', 'Held now'], ['pressed(code)', 'Went down this frame'], ['mouse', '{ dx, dy, wheel } this frame'], ['locked', 'The mouse is captured (the game has the keyboard)']];
const PLAYER = [
  ['position', 'Feet position (Vector3)'], ['velocity', 'Vector3, m/s'], ['onGround', 'Standing on something (writable)'],
  ['groundNormal', 'Normal of the ground underfoot'], ['character', 'The player character (null in a capsule-free map): root, height, settings (controller fields from its model meta), update(dt, move, running) (after locomotion()), playAction(i)'],
  ['spawn', 'The Player Spawn: position, rotationY, params'], ['respawn()', 'Back to the spawn'],
  ['teleport(x, y, z)', 'Move the player'], ['playClip(name)', 'Play a clip from the animation library on the player character'],
  ['locomotion(states, speeds, rates)', 'Walk the character with library clips: { idle, walk, run, back, left, right } (clip names); speeds { walk, run } in m/s; rates: each clip\'s playback speed (× 1). Call it in start() and on \'characterChanged\''],
];
const PHYSICS = [
  ['move(dt, body)', 'Walk the player by its velocity: walls, steps, ramps, landing. body: { radius, height, step, maxSlope }'],
  ['cameraClearance(origin, dir, max)', 'How far along a ray a camera can sit before hitting the map'],
  ['groundAt(x, z, y)', 'Highest surface the player could stand on at (x, z) from height y'],
];
const VIEW = [['mode', '\'first\' or \'third\''], ['facing', '\'free\' or \'strafe\''], ['set(mode, { sticky })', 'Switch view (sticky: keep it when the character changes)'], ['setFacing(facing)', 'Third-person facing']];
const HOOK_DOCS = {
  start: 'Once, before the first update',
  update: 'update(dt): every frame',
  onTriggerEnter: 'onTriggerEnter(player): on a Trigger Volume, the player walked in',
  onTriggerExit: 'onTriggerExit(player): …and out',
  onInteract: 'onInteract(player): the player pressed E near the object',
  onDestroy: 'The object was destroyed, or the map unloaded',
};
// A script that exports `controlsPlayer = true` (the Player controller template) moves the player in the playtest.

const option = ([label, info], type) => ({ label: label.replace(/\(.*$/, ''), detail: label.includes('(') ? label.slice(label.indexOf('(')) : '', info, type });
const SOURCES = [
  [/(?:this\.)?game\.input\.\w*$/, INPUT.map((x) => option(x, 'method'))],
  [/(?:this\.)?game\.player\.\w*$/, PLAYER.map((x) => option(x, 'property'))],
  [/(?:this\.)?game\.physics\.\w*$/, PHYSICS.map((x) => option(x, 'method'))],
  [/(?:this\.)?game\.view\.\w*$/, VIEW.map((x) => option(x, x[0].includes('(') ? 'method' : 'property'))],
  [/\b(?:input)\.\w*$/, INPUT.map((x) => option(x, 'method'))],
  [/\b(?:player)\.\w*$/, PLAYER.map((x) => option(x, 'property'))],
  [/(?:this\.)?game\.\w*$/, GAME.map((x) => option(x, x[0].includes('(') ? 'method' : 'property'))],
  [/\b(?:anim|animator)\.\w*$/, ANIM.map((x) => option(x, x[0].includes('(') ? 'method' : 'property'))],
  [/\b(?:fsm|sm|machine)\.\w*$/, FSM.map((x) => option(x, x[0].includes('(') ? 'method' : 'property'))],
  [/this\.\w*$/, THIS.map((x) => option(x, 'property'))],
];
function complete(ctx) {
  for (const [re, options] of SOURCES) {
    const m = ctx.matchBefore(re);
    if (m) return { from: m.from + m.text.lastIndexOf('.') + 1, options, validFor: /^\w*$/ };
  }
  return null;
}

let cm = null;
const loadCodeMirror = () => (cm ??= Promise.all([import('codemirror'), import('@codemirror/lang-javascript'), import('@codemirror/theme-one-dark')])
  .then(([core, js, dark]) => ({ ...core, ...js, oneDark: dark.oneDark })));

export class ScriptEditor {
  /** onSaved(script) runs after every save. */
  constructor(library, { onSaved } = {}) {
    this.library = library;
    this.onSaved = onSaved;
    this.id = null;
    this.view = null;
    this.saved = '';
  }

  get isOpen() { return !!this.root && !this.root.hidden; }
  get dirty() { return !!this.view && this.view.state.doc.toString() !== this.saved; }

  async open(id) {
    const script = this.library.get(id);
    if (!script) return;
    if (this.isOpen && this.id !== id && this.dirty && !(await this._confirmDiscard())) return;
    if (!this.root) this._build();
    const { EditorView, basicSetup, javascript, javascriptLanguage, oneDark } = await loadCodeMirror();
    this.id = id;
    this.saved = script.source;
    this.name.value = script.name;
    this.root.hidden = false;
    this.view?.destroy();
    this.view = new EditorView({
      doc: script.source,
      parent: this.host,
      extensions: [
        basicSetup, javascript(), oneDark,
        javascriptLanguage.data.of({ autocomplete: complete }),
        EditorView.updateListener.of((u) => { if (u.docChanged) this._syncStatus(); }),
        EditorView.theme({ '&': { height: '100%', fontSize: '13px' }, '.cm-scroller': { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace" } }),
      ],
    });
    this.view.focus();
    this._setStatus('');
    this._syncStatus();
    this._check(script.source);
  }

  /** A script changed outside the editor (its file, in VS Code): show it, unless there are unsaved edits here. */
  external(id, text) {
    if (!this.isOpen || this.id !== id || !this.view) return;
    if (this.dirty) {
      toast('This script also changed on disk. Saving here keeps your version; close without saving to take the file\'s.', { type: 'error', timeout: 8000 });
      return;
    }
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
    this.saved = text;
    this._syncStatus();
    this._check(text);
  }

  async close() {
    if (this.dirty && !(await this._confirmDiscard())) return;
    this.root.hidden = true;
    this.view?.destroy();
    this.view = null;
    this.id = null;
  }

  async save() {
    if (!this.view || !this.library.get(this.id)) return;
    const source = this.view.state.doc.toString();
    const name = this.name.value.trim();
    this.library.update(this.id, { source, ...(name ? { name } : {}) });
    this.saved = source;
    this.name.value = this.library.get(this.id).name;
    this._syncStatus();
    const meta = await this._check(source);
    if (!meta.error) this.onSaved?.(this.library.get(this.id));
  }

  async _check(source) {
    const meta = await inspectSource(source);
    if (meta.error) this._setStatus(`⚠ ${meta.error}`, 'error');
    else this._setStatus(`✓ ${meta.hooks.length ? meta.hooks.join(' · ') : 'no hooks yet'}${Object.keys(meta.fields).length ? ` · ${Object.keys(meta.fields).length} param${Object.keys(meta.fields).length === 1 ? '' : 's'}` : ''}`, 'ok');
    return meta;
  }

  _setStatus(text, kind = '') {
    this.status.textContent = text;
    this.status.className = `script-status ${kind}`;
  }

  _syncStatus() {
    this.saveBtn.disabled = !this.dirty;
    this.saveBtn.textContent = this.dirty ? 'Save (Ctrl+S)' : 'Saved';
  }

  _confirmDiscard() {
    return new Promise((resolve) => {
      modal('Unsaved changes', h('p', {}, 'Discard your changes to this script?'), {
        actions: [{ label: 'Keep editing', run: () => resolve(false) }, { label: 'Discard', cls: 'btn-danger', run: () => resolve(true) }],
      });
    });
  }

  _build() {
    this.name = h('input', { type: 'text', class: 'script-name', title: 'Script name' });
    this.name.addEventListener('input', () => { this.saveBtn.disabled = false; this.saveBtn.textContent = 'Save (Ctrl+S)'; });
    this.status = h('span', { class: 'script-status' });
    this.saveBtn = button('Saved', () => this.save(), { cls: 'btn-primary' });
    this.host = h('div', { class: 'script-code' });
    const ref = (title, rows) => h('div', {}, h('h4', {}, title),
      h('dl', {}, ...rows.flatMap(([k, v]) => [h('dt', {}, h('code', {}, k)), h('dd', {}, v)])));
    this.root = h('div', { class: 'script-editor', hidden: true },
      h('div', { class: 'script-window' },
        h('header', { class: 'script-top' },
          h('span', { class: 'muted' }, '{ }'), this.name, this.status, h('div', { class: 'spacer' }),
          this.saveBtn, button('Close', () => this.close(), { cls: 'btn', title: 'Esc' })),
        h('div', { class: 'script-body' },
          this.host,
          h('aside', { class: 'script-ref' },
            ref('Hooks (methods of the default class)', HOOKS.map((k) => [k, HOOK_DOCS[k]])),
            ref('this', THIS),
            ref('this.game', GAME),
            ref('this.game.player', PLAYER),
            ref('this.game.input', INPUT),
            ref('this.game.physics (player controllers)', PHYSICS),
            ref('this.game.view', VIEW),
            ref('Animator (game.animator(object))', ANIM),
            ref('State machine (game.stateMachine(…))', FSM),
            h('h4', {}, 'Params'),
            h('p', {}, 'export const params = { speed: { type: \'number\', default: 1, min, max, step, label } }. Types: number, text, bool, color, select (with options), clip (a clip from the animation library). Each object gets its own values in the Inspector.'),
            h('p', { class: 'muted' }, 'Scripts run in the playtest (▶ Play) and in your own game through src/runtime/scripts.js. Saving reloads an open playtest.')))));
    document.body.append(this.root);
    // Keys typed here are for the code: keep them from the map editor's shortcuts.
    this.root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); }
      else if (e.key === 'Escape' && !e.defaultPrevented && !this.root.querySelector('.cm-tooltip-autocomplete')) this.close();
    });
    this.root.addEventListener('keyup', (e) => e.stopPropagation());
    this.library.addEventListener('changed', (e) => {
      if (this.isOpen && e.detail.removed === this.id) { this.view?.destroy(); this.view = null; this.root.hidden = true; toast('The script was deleted'); }
    });
  }
}
