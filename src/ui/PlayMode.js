// Play mode: the playtest running inside the editor's viewport (game.html in an iframe, so it plays exactly like
// ▶ Play in a tab), with pause / restart / stop and a console for what the map's scripts log.
import { h, button } from './dom.js';

const MAX_LOGS = 200;

export class PlayMode {
  /** prepare(): export the map for the playtest (writePlaytest). onChange(): the toolbar should update. */
  constructor(editor, { prepare, onChange, openInTab }) {
    this.editor = editor;
    this.prepare = prepare;
    this.onChange = onChange;
    this.openInTab = openInTab;
    this.playing = false;
    this.starting = false;
    this.paused = false;
    this.edited = false; // the map changed since the game started: Restart picks it up
    this.logs = [];
    this.consoleOpen = false;
    this.run = 0; // bumped by stop(): a start/restart still exporting when you stop must not carry on
    window.addEventListener('message', (e) => this._onMessage(e));
    editor.on('changed', () => { if (this.playing && !this.starting) { this.edited = true; this._sync(); } });
  }

  toggle() { return this.playing ? this.stop() : this.start(); }

  async start() {
    if (this.playing || this.starting) return;
    const run = ++this.run;
    this.starting = true;
    this.onChange?.();
    try {
      await this.prepare();
      if (run !== this.run) return;
      this._build();
      this.playing = true;
      this.editor.setPaused(true); // the game draws now; the editor's view is covered
      this._load();
    } finally {
      if (run === this.run) { this.starting = false; this._sync(); }
    }
  }

  async restart() {
    if (!this.playing || this.starting) return;
    const run = this.run;
    this.starting = true;
    this._sync();
    try {
      await this.prepare();
      if (run === this.run) this._load();
    } finally {
      if (run === this.run) { this.starting = false; this._sync(); }
    }
  }

  stop() {
    this.run++;
    this.starting = false;
    if (!this.playing) { this._sync(); return; }
    this.root.remove(); // takes the game's page (and its WebGL context) with it
    this.root = null;
    this.playing = false;
    this.paused = false;
    this.editor.setPaused(false);
    this._sync();
  }

  togglePause() {
    if (!this.playing) return;
    this.paused = !this.paused;
    this.frame.contentWindow?.postMessage({ type: 'pause', paused: this.paused }, location.origin);
    this._sync();
  }

  /** The map was re-exported and the game reloaded it (a script was saved): nothing to restart for. */
  reloaded() {
    this.edited = false;
    this._sync();
  }

  _load() {
    this.edited = false;
    this.paused = false;
    this.logs = [];
    this._renderConsole();
    this.frame.src = `./game.html?playtest=1&embed=1&t=${Date.now()}`;
  }

  _build() {
    this.frame = h('iframe', { class: 'play-frame', title: 'Play mode', allow: 'fullscreen' });
    this.frame.addEventListener('load', () => this.frame.contentWindow?.focus());
    this.status = h('span', { class: 'play-status' });
    this.pauseBtn = button('⏸', () => this.togglePause(), { cls: 'btn-icon', title: 'Pause / resume the game' });
    this.restartBtn = button('↻ Restart', () => this.restart(), { cls: 'btn-sm', title: 'Export the map again and start over' });
    this.consoleBtn = button('Console', () => { this.consoleOpen = !this.consoleOpen; this._renderConsole(); }, { cls: 'btn-sm', title: 'What the map\'s scripts log, and errors' });
    this.consoleList = h('div', { class: 'play-console-list' });
    this.console = h('div', { class: 'play-console' },
      h('div', { class: 'play-console-head' }, h('b', {}, 'Console'), h('div', { class: 'spacer' }),
        button('Clear', () => { this.logs = []; this._renderConsole(); }, { cls: 'btn-sm' }),
        button('✕', () => { this.consoleOpen = false; this._renderConsole(); }, { cls: 'btn-sm btn-ghost' })),
      this.consoleList);
    this.root = h('div', { class: 'play-mode' },
      this.frame,
      h('div', { class: 'play-bar' },
        this.status, this.pauseBtn, this.restartBtn, this.consoleBtn,
        button('↗', () => this.openInTab?.(), { cls: 'btn-icon', title: 'Open the playtest in a new tab' }),
        button('⏹ Stop', () => this.stop(), { cls: 'btn-sm btn-danger', title: 'Back to editing (Ctrl+P)' })),
      this.console);
    document.getElementById('viewport').append(this.root);
    this._renderConsole();
  }

  _onMessage(e) {
    if (!this.playing || !this.frame || e.source !== this.frame.contentWindow || e.data?.from !== '3dmap-play') return;
    const d = e.data;
    if (d.type === 'stop') this.stop();
    else if (d.type === 'log') {
      this.logs.push({ level: d.level, text: d.text, time: new Date() });
      if (this.logs.length > MAX_LOGS) this.logs.shift();
      if (d.level === 'error' && !this.consoleOpen) this.consoleOpen = true; // errors open the console
      this._renderConsole();
    }
  }

  _renderConsole() {
    if (!this.console) return;
    this.console.hidden = !this.consoleOpen;
    const errors = this.logs.filter((l) => l.level === 'error').length;
    this.consoleBtn.textContent = this.logs.length ? `Console (${this.logs.length}${errors ? ` · ${errors} ⚠` : ''})` : 'Console';
    this.consoleBtn.classList.toggle('play-has-errors', errors > 0);
    this.consoleList.replaceChildren(...(this.logs.length ? this.logs.map((l) => h('div', { class: `play-log ${l.level}` },
      h('time', {}, l.time.toLocaleTimeString()), h('span', {}, l.text))) : [h('p', { class: 'hint' }, 'Nothing logged yet. Scripts write here with this.game.log(…); errors show up too.')]));
    this.consoleList.scrollTop = this.consoleList.scrollHeight;
  }

  _sync() {
    if (this.root) {
      this.status.textContent = this.starting ? 'Starting…' : this.paused ? '❚❚ Paused' : '● Playing';
      this.status.classList.toggle('paused', this.paused);
      this.pauseBtn.textContent = this.paused ? '▶' : '⏸';
      this.restartBtn.textContent = this.edited ? '↻ Restart · edited' : '↻ Restart';
      this.restartBtn.classList.toggle('btn-primary', this.edited);
      this.restartBtn.disabled = this.starting;
    }
    this.onChange?.();
  }
}
