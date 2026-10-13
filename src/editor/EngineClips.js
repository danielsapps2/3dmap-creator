// The clip library lives in the engine (engine/clips/<name>.clip.json), not in projects: every project and the
// playtest use the same clips. This keeps the editor's ClipLibrary and that folder in step: it loads the folder,
// writes clips as they change (new, edited, renamed, deleted), and takes in changes made on disk.
// A clip's `path` is "clips/<file>", the file under engine/clips/.
import { listEngineClips, fetchEngineClip, saveEngineClip, deleteEngineClip } from '../core/engine.js';
import { projectToJSON, projectFromJSON } from './Project.js';

const fileOf = (path) => path.replace(/^clips\//, '');
const pathOf = (file) => `clips/${file}`;
const clipText = (clip) => {
  const { path, ...rest } = clip; // the path is where it lives, not part of it
  return projectToJSON(rest);
};

/**
 * Load the engine's clips into the library and keep them in step. Resolves to false (and does nothing) when the
 * editor isn't served with the engine library. ui: { toast(text, opts) }.
 * legacy: clips from before the engine had them (the browser's old library): added once if the engine lacks them.
 */
export async function connectEngineClips(library, { ui, legacy = null, interval = 2000 } = {}) {
  let listing;
  try {
    listing = await listEngineClips();
  } catch {
    return false;
  }
  const synced = new Map(); // file -> { text, modified }: as last read or written
  const read = async (entry) => {
    const text = await fetchEngineClip(entry.file);
    synced.set(entry.file, { text, modified: entry.modified });
    return { ...projectFromJSON(text), path: pathOf(entry.file) };
  };
  const loaded = [];
  for (const entry of listing) {
    try {
      loaded.push(await read(entry));
    } catch (err) {
      console.warn(`engine clip ${entry.file}`, err);
    }
  }
  library.load(loaded);
  if (legacy?.length) library.addMissing(legacy); // written below like any change

  let busy = false, dirty = false, timer = null;

  /** Write what changed in the library since it was last read or written. */
  const write = async () => {
    if (busy) { dirty = true; return; }
    busy = true;
    try {
      const live = new Set();
      for (const clip of library.clips) {
        const file = fileOf(clip.path);
        live.add(file);
        const text = clipText(clip);
        if (synced.get(file)?.text === text) continue;
        const entry = await saveEngineClip(file, text);
        synced.set(file, { text, modified: entry.modified });
      }
      for (const file of [...synced.keys()]) {
        if (live.has(file)) continue;
        await deleteEngineClip(file); // deleted, or renamed (written under its new name above)
        synced.delete(file);
      }
    } catch (err) {
      console.error(err);
      ui?.toast(`Couldn't save clips to the engine: ${err.message}`, { type: 'error', timeout: 6000 });
    } finally {
      busy = false;
      if (dirty) { dirty = false; schedule(); }
    }
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(write, 300); };
  library.addEventListener('changed', schedule);
  schedule();

  /** Take in clip files added, changed or deleted on disk (or by another editor tab). */
  const poll = async () => {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const list = await listEngineClips();
      const seen = new Set();
      let changed = false;
      for (const entry of list) {
        seen.add(entry.file);
        const known = synced.get(entry.file);
        if (known && known.modified === entry.modified) continue;
        const before = known?.text;
        const clip = await read(entry);
        if (before === synced.get(entry.file).text) continue; // same content (e.g. our own write)
        const mine = library.byPath(clip.path) ?? library.get(clip.id);
        if (mine) Object.assign(mine, clip); // in place: the animation editor keeps its selection
        else library.clips.push(clip);
        changed = true;
        ui?.toast(`${known ? 'Updated' : 'New'} clip from the engine: ${clip.name}`, { timeout: 2000 });
      }
      for (const file of [...synced.keys()]) {
        if (seen.has(file)) continue;
        synced.delete(file);
        const clip = library.byPath(pathOf(file));
        if (clip) { library.clips = library.clips.filter((c) => c !== clip); changed = true; ui?.toast(`${clip.name} was deleted from the engine`, { timeout: 3000 }); }
      }
      // emit after `synced` is up to date, so the write this triggers finds nothing to do
      if (changed) library.changed();
    } catch (err) {
      console.warn('engine clip sync', err);
    } finally {
      busy = false;
    }
  };
  setInterval(poll, interval);
  document.addEventListener('visibilitychange', poll);
  return true;
}
