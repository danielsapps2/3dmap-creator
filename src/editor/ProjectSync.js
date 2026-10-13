// Keeps the editor's project and its folder (ProjectFolder.js) in step: opening and saving folders, writing scripts,
// models and clips as soon as they change, and taking in what changes on disk (VS Code, a file manager).
// Without a folder the project's files live in memory (and the autosave) until the first save picks one.
import { ProjectFolder, folderSupported } from './ProjectFolder.js';
import { serializeProject, loadProject } from './Project.js';
import { uid } from '../core/utils.js';

export class ProjectSync extends EventTarget {
  /**
   * ui: { toast(text, opts), confirm(title, text, okLabel) -> Promise<bool>, scriptChangedOnDisk(id, text),
   *       reloadGame() } — reloadGame runs after a script or clip changed on disk.
   */
  constructor(editor, ui) {
    super();
    this.editor = editor;
    this.ui = ui;
    this.folder = null;
    this.saveState = '';
    this._timer = null;
    this._writing = null;
    const soon = () => this.scheduleWrite();
    editor.scripts.addEventListener('changed', soon);
    editor.clips.addEventListener('changed', soon);
    editor.assets.addEventListener('changed', soon);
  }

  get supported() { return folderSupported; }
  get name() { return this.folder?.name ?? null; }
  changed() { this.dispatchEvent(new Event('changed')); }

  /** The project's files: what the folder holds (or will, once saved). */
  files() {
    const ed = this.editor;
    return {
      scripts: ed.scripts.list(),
      assets: ed.assets.list().map((a) => ({ id: a.id, name: a.fileName, path: a.path, buffer: a.buffer, meta: a.meta })),
      clips: ed.clips.clips,
    };
  }

  setFolder(f) {
    clearTimeout(this._timer); // a write queued for the old folder must not land after it's let go
    if (this.folder !== f) this.folder?.unwatch();
    this.folder = f;
    if (f) { f.remember(); if (f.attached) this._watch(); } else ProjectFolder.forget();
    this.changed();
  }

  // ------------------------------------------------------------------ write-through

  /** Write changed scripts / models / clips to the folder shortly (they're files: no Ctrl+S needed). */
  scheduleWrite() {
    if (!this.folder?.attached) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.writeFiles(), 300);
  }

  async writeFiles() {
    const f = this.folder;
    if (!f?.attached || !(await f.permitted())) return;
    await this._writing; // one at a time
    this._writing = f.saveFiles(this.files()).then(({ conflicts }) => {
      if (conflicts.length) this.ui.toast(`${conflicts.join(', ')} changed on disk too: the editor's version was written`, { type: 'error', timeout: 8000 });
    }).catch((err) => {
      console.error(err);
      this.ui.toast(`Couldn't write to ${f.name}/: ${err.message}`, { type: 'error', timeout: 6000 });
    });
    return this._writing;
  }

  // ------------------------------------------------------------------ open / save

  /** Open a project folder: pick one, or reload `f`. */
  async open(f = null) {
    try {
      if (!f) f = await ProjectFolder.pick();
      else if (!(await f.permitted(true))) return false;
      if (!(await f.hasProject())) { this.ui.toast(`“${f.name}” has no project.json`, { type: 'error', timeout: 6000 }); return false; }
      const fresh = new ProjectFolder(f.handle); // nothing carried over from the last session
      const data = await fresh.load();
      this.setFolder(null);
      await loadProject(this.editor, data, { onWarning: (m) => this.ui.toast(m, { type: 'error', timeout: 6000 }), mergeClips: false });
      this.editor.clips.load(data.clips); // a folder's clips are its own (clips/)
      this.setFolder(fresh);
      this.ui.toast(`Opened ${fresh.name}/`, { type: 'ok' });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      console.error(err);
      this.ui.toast(`Could not open the folder: ${err.message}`, { type: 'error', timeout: 6000 });
      return false;
    }
  }

  /** Save into the project's folder (asking for one the first time, or always with as: true). */
  async save({ as = false } = {}) {
    try {
      let f = as ? null : this.folder;
      if (f && !(await f.permitted(true))) f = null;
      if (f && !f.attached) await this.attach(f); // first save after a reload: don't undo edits made on disk
      if (!f) {
        f = await ProjectFolder.pick();
        if (this.folder && (await this.folder.handle.isSameEntry(f.handle))) f = this.folder;
        else if (await f.hasProject()) {
          if (!(await this.ui.confirm('Replace project?', `“${f.name}” already holds a project. Replace it with this one?`, 'Replace'))) return false;
        } else if (!(await f.isEmpty())) {
          if (!(await this.ui.confirm('Save into this folder?', `“${f.name}” isn't empty. The project goes in alongside what's there: project.json, scripts/, assets/, clips/ and terrain/.`, 'Save here'))) return false;
        }
      }
      await this._writing;
      const { conflicts } = await f.save(serializeProject(this.editor));
      if (f !== this.folder) this.setFolder(f);
      this.saveState = `saved to ${f.name}/`;
      this.changed();
      this.ui.toast(`Saved to ${f.name}/`, { type: 'ok' });
      if (conflicts.length) this.ui.toast(`${conflicts.join(', ')} changed on disk too: the editor's version was saved`, { type: 'error', timeout: 8000 });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      console.error(err);
      this.ui.toast(`Save failed: ${err.message}`, { type: 'error', timeout: 6000 });
      return false;
    }
  }

  /** After a reload: the remembered folder, reconnected now or when the user allows it again. */
  async reconnect(since) {
    const f = folderSupported ? await ProjectFolder.remembered() : null;
    if (!f) return;
    f.since = since;
    this.setFolder(f);
    if (await f.permitted()) await this.attach(f);
    else {
      this.ui.toast(`Reconnect to ${f.name}/ to keep it in sync (Ctrl+S does too)`, {
        timeout: 0, action: { label: 'Reconnect', run: async () => { if (await f.permitted(true)) this.attach(f); } },
      });
    }
  }

  /** Learn the folder's files, take script edits made on disk meanwhile, write what the editor has that it lacks. */
  async attach(f) {
    const taken = await f.attach(this.editor, f.since ?? 0);
    if (taken.length) this.ui.toast(`Took ${taken.join(', ')} from ${f.name}/ (edited on disk)`, { type: 'ok', timeout: 5000 });
    if (f === this.folder) {
      this._watch();
      this.scheduleWrite();
      this.changed();
    }
  }

  // ------------------------------------------------------------------ changes on disk

  _watch() {
    const { scripts, clips, assets } = this.editor;
    const { toast } = this.ui;
    this.folder.watch({
      script: ({ path, text }) => {
        const s = scripts.byPath(path);
        if (!s) return;
        scripts.update(s.id, { source: text });
        this.ui.scriptChangedOnDisk?.(s.id, text);
        toast(`${path} changed on disk`, { timeout: 1800 });
        this.ui.reloadGame?.();
      },
      scriptAdded: ({ path, text }) => {
        if (scripts.byPath(path)) return;
        scripts.add({ path, source: text });
        toast(`New script: ${path}`, { type: 'ok' });
      },
      scriptRemoved: (path) => {
        const s = scripts.byPath(path);
        if (!s) return;
        scripts.remove(s.id); // objects keep the reference, shown as a missing script
        toast(`${path} was deleted on disk`, { type: 'error', timeout: 5000 });
      },
      clip: ({ path, clip }) => {
        const mine = clips.byPath(path);
        if (!mine) return;
        Object.assign(mine, clip, { id: mine.id, path });
        clips.changed();
        toast(`${path} changed on disk`, { timeout: 1800 });
        this.ui.reloadGame?.();
      },
      clipAdded: ({ path, clip }) => {
        if (clips.byPath(path)) return;
        clips.merge([{ ...clip, id: clip.id && !clips.get(clip.id) ? clip.id : uid(), path }]);
        toast(`New clip: ${path}`, { type: 'ok' });
      },
      clipRemoved: (path) => {
        const c = clips.byPath(path);
        if (c) { clips.remove(c.id); toast(`${path} was deleted on disk`, { type: 'error', timeout: 5000 }); }
      },
      modelAdded: async ({ path, buffer }) => {
        if (assets.byPath(path)) return;
        try {
          await assets.add(path.slice(path.lastIndexOf('/') + 1), buffer, undefined, {}, path);
          toast(`New model: ${path}`, { type: 'ok' });
        } catch (err) {
          toast(`Couldn't load ${path}: ${err.message}`, { type: 'error', timeout: 6000 });
        }
      },
      modelChanged: async ({ path, buffer }) => {
        const a = assets.byPath(path);
        if (!a) return;
        await this.editor.reloadAsset(a.id, buffer, a.meta); // placed copies update too
        toast(`${path} changed on disk`, { timeout: 1800 });
      },
      modelRemoved: (path) => {
        if (assets.byPath(path)) toast(`${path} was deleted on disk; it's still in the project and will be written again on save`, { timeout: 5000 });
      },
      manifest: () => toast('project.json changed on disk', { timeout: 0, action: { label: 'Reload project', run: () => this.open(this.folder) } }),
    });
  }
}
