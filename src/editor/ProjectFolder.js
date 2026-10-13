// A project saved as a folder of ordinary files, so it can be opened in VS Code (or any editor) and kept in git:
//
//   project.json              the map: environment, objects (with their scripts' params), camera, settings; and an
//                             index of the files below (pretty-printed JSON)
//   scripts/**/<Name>.js      one file per script (subfolders allowed)
//   assets/**/<name>.glb      the models
//   terrain/heights.f32, terrain/colors.f32   the terrain grid (raw little-endian Float32)
//
// Animation clips live in the engine (engine/clips/), not here. A clips/ folder from an older project is still read
// (its clips join the engine's) but never written or watched.
//
// Uses the File System Access API (Chrome / Edge). Scripts and models are written as soon as they change
// (saveFiles); Ctrl+S also writes project.json and the terrain (save). While a folder is open the editor polls it, so
// files added, edited or deleted outside the editor (VS Code, a file manager) show up (watch).
import { projectFromJSON, PROJECT_FORMAT } from './Project.js';
import { idbGet, idbSet, idbDelete } from '../core/storage.js';
import { uid } from '../core/utils.js';
import { stemOf } from '../core/paths.js';

export const folderSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const MANIFEST = 'project.json';
const REMEMBER = 'project-folder';
const RW = { mode: 'readwrite' };
export const isScriptPath = (p) => p.startsWith('scripts/') && p.endsWith('.js');
export const isModelPath = (p) => p.startsWith('assets/') && /\.(glb|gltf)$/i.test(p);
export const isClipPath = (p) => p.startsWith('clips/') && p.toLowerCase().endsWith('.clip.json');

async function subdir(root, parts, create) {
  let d = root;
  for (const p of parts) if (p) d = await d.getDirectoryHandle(p, { create });
  return d;
}

async function fileHandle(root, path, create = false) {
  const parts = path.split('/');
  try {
    const d = await subdir(root, parts.slice(0, -1), create);
    return await d.getFileHandle(parts.at(-1), { create });
  } catch (err) {
    if (!create && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')) return null;
    throw err;
  }
}

async function readFile(root, path) {
  const h = await fileHandle(root, path);
  return h ? h.getFile() : null;
}

async function writeFile(root, path, data) {
  const h = await fileHandle(root, path, true);
  const w = await h.createWritable();
  await w.write(data);
  await w.close();
  return h.getFile();
}

async function removeFile(root, path) {
  const parts = path.split('/');
  try {
    const d = await subdir(root, parts.slice(0, -1), false);
    await d.removeEntry(parts.at(-1));
  } catch { /* already gone */ }
}

/** Every file under a folder, as paths from the project root ("scripts/enemies/Goblin.js"). */
async function listTree(root, dir) {
  const out = [];
  const walk = async (d, prefix) => {
    for await (const [name, h] of d.entries()) {
      if (name.startsWith('.')) continue;
      if (h.kind === 'directory') await walk(h, `${prefix}${name}/`);
      else out.push(`${prefix}${name}`);
    }
  };
  try { await walk(await subdir(root, dir.split('/'), false), `${dir}/`); } catch { /* no such folder */ }
  return out;
}

const f32Blob = (a) => new Blob([a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength)]);

export class ProjectFolder {
  constructor(handle) {
    this.handle = handle;
    this.synced = new Map();   // path -> { text?, size?, modified }: the file as the editor last read or wrote it
    this.manifestModified = 0;
    this.timer = null;
    this.attached = false;     // knows what's on disk (after load, save or attach)
  }

  get name() { return this.handle.name; }

  static async pick() {
    return new ProjectFolder(await window.showDirectoryPicker({ id: '3dmap-project', mode: 'readwrite' }));
  }

  /** The folder the editor had open last time (permission may need asking again). */
  static async remembered() {
    const h = await idbGet(REMEMBER).catch(() => null);
    return h ? new ProjectFolder(h) : null;
  }

  remember() { return idbSet(REMEMBER, this.handle); }
  static forget() { return idbDelete(REMEMBER).catch(() => {}); }

  /** Whether the editor may read and write the folder; ask: prompt the user (needs a click or key press). */
  async permitted(ask = false) {
    if ((await this.handle.queryPermission(RW)) === 'granted') return true;
    return ask && (await this.handle.requestPermission(RW)) === 'granted';
  }

  async hasProject() { return !!(await fileHandle(this.handle, MANIFEST)); }

  async isEmpty() {
    for await (const _ of this.handle.keys()) return false;
    return true;
  }

  // ------------------------------------------------------------------ write

  /**
   * Write the scripts and models that changed since the editor last wrote or read them, and delete the files
   * of ones that were removed or renamed (only files the editor knows about). files: { scripts, assets } as in
   * serializeProject(). A file changed on disk *and* in the editor is overwritten and reported in conflicts.
   */
  async saveFiles({ scripts = [], assets = [] }) {
    const root = this.handle;
    const conflicts = [];
    const live = new Set();
    const text = async (path, content, name) => {
      live.add(path);
      const known = this.synced.get(path);
      if (known && known.text === content) return; // unchanged in the editor (disk edits come in through watch())
      if (known) {
        const disk = await readFile(root, path);
        if (disk && disk.lastModified !== known.modified && (await disk.text()) !== known.text) conflicts.push(name);
      }
      const f = await writeFile(root, path, content);
      this.synced.set(path, { text: content, modified: f.lastModified });
    };
    for (const s of scripts) await text(s.path, s.source, s.name ?? stemOf(s.path));
    for (const a of assets) {
      live.add(a.path);
      const known = this.synced.get(a.path);
      if (known && (known.buffer ? known.buffer === a.buffer : known.size === a.buffer.byteLength)) continue;
      const f = await writeFile(root, a.path, a.buffer);
      this.synced.set(a.path, { size: f.size, modified: f.lastModified, buffer: a.buffer });
    }
    for (const path of [...this.synced.keys()]) {
      // a project's clips/ (from before clips lived in the engine) is left alone
      if ((isScriptPath(path) || isModelPath(path)) && !live.has(path)) {
        await removeFile(root, path);
        this.synced.delete(path);
      }
    }
    this.attached = true;
    return { conflicts };
  }

  /** Write the whole project (serializeProject() data): its files, the terrain, and project.json. */
  async save(data) {
    const result = await this.saveFiles(data);
    const root = this.handle;
    const t = data.terrain;
    await writeFile(root, 'terrain/heights.f32', f32Blob(t.heights));
    await writeFile(root, 'terrain/colors.f32', f32Blob(t.colors));
    const { assets, scripts, clips, terrain, ...rest } = data; // clips: the engine's, not written here
    const manifest = {
      ...rest,
      format: PROJECT_FORMAT,
      layout: 'folder',
      terrain: { size: t.size, segments: t.segments, material: t.material, heights: 'terrain/heights.f32', colors: 'terrain/colors.f32' },
      scripts: scripts.map((s) => ({ id: s.id, file: s.path })),
      assets: assets.map((a) => ({ id: a.id, name: a.name, file: a.path, meta: a.meta })),
    };
    this.manifestModified = (await writeFile(root, MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)).lastModified;
    return result;
  }

  // ------------------------------------------------------------------ read

  async _manifest() {
    const mf = await readFile(this.handle, MANIFEST);
    if (!mf) return null;
    const manifest = JSON.parse(await mf.text());
    if (manifest.format !== PROJECT_FORMAT) throw new Error(`${MANIFEST} isn't a 3D Map Creator project`);
    this.manifestModified = mf.lastModified;
    return manifest;
  }

  async _readText(path) {
    const f = await readFile(this.handle, path);
    if (!f) return null;
    const text = await f.text();
    this.synced.set(path, { text, modified: f.lastModified });
    return text;
  }

  async _readModel(path) {
    const f = await readFile(this.handle, path);
    if (!f) return null;
    const buffer = await f.arrayBuffer();
    this.synced.set(path, { size: f.size, modified: f.lastModified, buffer });
    return buffer;
  }

  async _readClip(path, id) {
    const text = await this._readText(path);
    if (text === null) return null;
    const clip = projectFromJSON(text);
    return { ...clip, id: id ?? clip.id ?? uid(), path };
  }

  /** Read the folder as serializeProject()-shaped data (for loadProject), including files added outside the editor. */
  async load() {
    const root = this.handle;
    const manifest = await this._manifest();
    if (!manifest) throw new Error(`No ${MANIFEST} in “${this.name}”`);
    const need = async (path) => {
      const f = await readFile(root, path);
      if (!f) throw new Error(`Missing ${path}`);
      return f;
    };
    const t = manifest.terrain;
    const terrain = {
      size: t.size, segments: t.segments, material: t.material,
      heights: new Float32Array(await (await need(t.heights)).arrayBuffer()),
      colors: new Float32Array(await (await need(t.colors)).arrayBuffer()),
    };

    const listed = new Set();
    const scripts = [];
    for (const s of manifest.scripts ?? []) {
      const source = await this._readText(s.file);
      if (source === null) { console.warn(`Missing ${s.file}`); continue; }
      scripts.push({ id: s.id, path: s.file, source });
      listed.add(s.file);
    }
    for (const path of (await listTree(root, 'scripts')).filter((p) => isScriptPath(p) && !listed.has(p))) {
      scripts.push({ id: uid(), path, source: await this._readText(path) });
    }

    listed.clear();
    const assets = [];
    for (const a of manifest.assets ?? []) {
      const buffer = await this._readModel(a.file);
      if (!buffer) { console.warn(`Missing ${a.file}`); continue; }
      assets.push({ id: a.id, name: a.name, path: a.file, buffer, meta: a.meta ?? {} });
      listed.add(a.file);
    }
    for (const path of (await listTree(root, 'assets')).filter((p) => isModelPath(p) && !listed.has(p))) {
      assets.push({ id: uid(), name: path.slice(path.lastIndexOf('/') + 1), path, buffer: await this._readModel(path), meta: {} });
    }

    listed.clear();
    const clips = [];
    if (typeof manifest.clips === 'string') {
      const f = await readFile(root, manifest.clips); // the old one-file library
      if (f) clips.push(...projectFromJSON(await f.text()));
    } else {
      for (const c of manifest.clips ?? []) {
        const clip = await this._readClip(c.file, c.id).catch(() => null);
        if (clip) { clips.push(clip); listed.add(c.file); }
      }
    }
    for (const path of (await listTree(root, 'clips')).filter((p) => isClipPath(p) && !listed.has(p))) {
      const clip = await this._readClip(path).catch(() => null);
      if (clip) clips.push(clip);
    }
    this.attached = true;
    return { ...manifest, terrain, assets, scripts, clips };
  }

  /**
   * Pick up a folder the editor had open before a reload (its project is already in the editor, from the autosave):
   * learn what's on disk, and take script files edited after `since` (ms) into the library. Files the libraries
   * don't have yet stay unknown, so watch() brings them in. Returns the names of the scripts it took.
   */
  async attach({ scripts, assets }, since = 0) {
    await this._manifest().catch(() => null);
    const taken = [];
    for (const path of await listTree(this.handle, 'scripts')) {
      const mine = isScriptPath(path) && scripts.byPath(path);
      if (!mine) continue;
      const f = await readFile(this.handle, path);
      const text = await f.text();
      this.synced.set(path, { text, modified: f.lastModified });
      if (mine.source !== text && f.lastModified > since) { scripts.update(mine.id, { source: text }); taken.push(mine.name); }
    }
    for (const path of await listTree(this.handle, 'assets')) {
      if (!isModelPath(path) || !assets.byPath(path)) continue;
      const f = await readFile(this.handle, path);
      this.synced.set(path, { size: f.size, modified: f.lastModified });
    }
    this.attached = true;
    return taken;
  }

  // ------------------------------------------------------------------ watch

  /**
   * Poll for changes made outside the editor and report them:
   *   on.script({ path, text }) a script file changed      on.scriptAdded({ path, text })   on.scriptRemoved(path)
   *   on.modelAdded({ path, buffer })                       on.modelRemoved(path)           on.manifest()
   */
  watch(on, interval = 1000) {
    this.unwatch();
    let busy = false;
    const scan = async (dir, test, { changed, added, removed, read }) => {
      const paths = (await listTree(this.handle, dir)).filter(test);
      const seen = new Set(paths);
      for (const path of paths) {
        const f = await readFile(this.handle, path);
        if (!f) continue;
        const known = this.synced.get(path);
        if (known && known.modified === f.lastModified) continue;
        const value = await read(f);
        if (known && 'text' in known && known.text === value.text) { known.modified = f.lastModified; continue; }
        this.synced.set(path, value.text !== undefined ? { text: value.text, modified: f.lastModified } : { size: f.size, modified: f.lastModified, buffer: value.buffer });
        await (known ? changed : added)?.({ path, ...value });
      }
      for (const path of [...this.synced.keys()]) {
        if (test(path) && !seen.has(path)) { this.synced.delete(path); await removed?.(path); }
      }
    };
    this.timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        if (!(await this.permitted())) return;
        await scan('scripts', isScriptPath, {
          read: async (f) => ({ text: await f.text() }),
          changed: on.script, added: on.scriptAdded, removed: on.scriptRemoved,
        });
        await scan('assets', isModelPath, {
          read: async (f) => ({ buffer: await f.arrayBuffer() }),
          changed: on.modelChanged, added: on.modelAdded, removed: on.modelRemoved,
        });
        const mf = await readFile(this.handle, MANIFEST);
        if (mf && this.manifestModified && mf.lastModified !== this.manifestModified) {
          this.manifestModified = mf.lastModified;
          on.manifest?.();
        }
      } catch (err) {
        console.warn('project folder watch', err);
      } finally {
        busy = false;
      }
    }, interval);
  }

  unwatch() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
