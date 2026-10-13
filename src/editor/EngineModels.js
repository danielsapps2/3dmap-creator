// Engine models in a project. A project's copy of an engine model (in its assets/) carries
// meta.engine = { file, modified }: the engine file it follows and the version it has. watchEngineModels() pulls in
// newer engine versions (placed copies update, and the project folder gets the new file), and links project models
// that are byte-for-byte the same as an engine model, so copies made before the engine had them follow it too.
import { listEngineModels, fetchEngineModel, saveEngineModel, sha256 } from '../core/engine.js';
import { fileStem } from '../core/paths.js';

/** Fires 'changed' when the engine's model list changes (for the panels). */
export const engineEvents = new EventTarget();

let catalog = null;
let lastListing = '';

/** The engine's models, fetched once and shared by the panels (and refreshed by the watcher). */
export function engineCatalog({ refresh = false } = {}) {
  if (refresh || !catalog) catalog = listEngineModels();
  return catalog;
}

function setListing(list) {
  const key = JSON.stringify(list);
  catalog = Promise.resolve(list);
  if (key !== lastListing) {
    lastListing = key;
    engineEvents.dispatchEvent(new Event('changed'));
  }
}

/** The asset's meta without the engine link (what the engine stores beside the model). */
const ownMeta = (meta) => {
  const { engine, ...rest } = meta ?? {};
  return rest;
};

export const engineLink = (asset) => asset?.meta?.engine ?? null;

/** The project's copy of an engine model, if it has one. */
export function findEngineCopy(editor, file) {
  return editor.assets.list().find((a) => a.meta.engine?.file === file) ?? null;
}

/** The project's copy of an engine model, downloading it into assets/ the first time. */
export async function importEngineModel(editor, item) {
  const have = findEngineCopy(editor, item.file);
  if (have) return have;
  const buffer = await fetchEngineModel(item.file);
  const ext = /\.gltf$/i.test(item.file) ? '.gltf' : '.glb';
  return editor.assets.add(`${item.name}${ext}`, buffer, undefined, { ...item.meta, engine: { file: item.file, modified: item.modified } });
}

/**
 * Put a project model into the engine (a new engine model, or a new version of the one it's linked to) and link
 * the project's copy to it. Every other project using it picks the new version up.
 */
export async function copyToEngine(editor, asset, { file = null } = {}) {
  const list = await listEngineModels();
  if (!file) {
    file = engineLink(asset)?.file;
    if (!file) {
      const ext = /\.gltf$/i.test(asset.path) ? '.gltf' : '.glb';
      const stem = fileStem(asset.name);
      const taken = new Set(list.map((e) => e.file.toLowerCase()));
      file = `${stem}${ext}`;
      for (let i = 2; taken.has(file.toLowerCase()); i++) file = `${stem} ${i}${ext}`;
    }
  }
  const entry = await saveEngineModel(file, asset.buffer, ownMeta(asset.meta));
  asset.meta = { ...asset.meta, engine: { file: entry.file, modified: entry.modified } };
  editor.assets.dispatchEvent(new Event('changed'));
  setListing(await listEngineModels());
  return entry;
}

/** Stop following the engine: the project keeps its copy as it is. */
export function unlinkEngine(editor, asset) {
  asset.meta = ownMeta(asset.meta);
  editor.assets.dispatchEvent(new Event('changed'));
}

/**
 * Keep the project's engine models in step with the engine: check every couple of seconds (and when the tab comes
 * back into view). onUpdate(asset, placedCount) after a model was reloaded from the engine; onLink(asset, entry)
 * after an identical project model was linked.
 */
export function watchEngineModels(editor, { interval = 2000, onUpdate, onLink } = {}) {
  const hashes = new WeakMap(); // ArrayBuffer -> sha256 promise
  const hashOf = (buffer) => {
    if (!hashes.has(buffer)) hashes.set(buffer, sha256(buffer));
    return hashes.get(buffer);
  };
  let busy = false;
  const check = async () => {
    if (busy || document.hidden) return;
    busy = true;
    try {
      let list;
      try {
        list = await listEngineModels();
      } catch {
        return; // served without the engine library (a static build): nothing to follow
      }
      setListing(list);
      const byFile = new Map(list.map((e) => [e.file, e]));
      for (const asset of editor.assets.list()) {
        const link = engineLink(asset);
        if (link) {
          const e = byFile.get(link.file);
          if (!e || e.modified === link.modified) continue; // removed from the engine: the project keeps its copy
          const sameModel = e.sha256 === (await hashOf(asset.buffer));
          const sameMeta = JSON.stringify(e.meta ?? {}) === JSON.stringify(ownMeta(asset.meta));
          const meta = { ...ownMeta(asset.meta), ...e.meta, engine: { file: e.file, modified: e.modified } };
          if (sameModel && sameMeta) { asset.meta = meta; continue; } // e.g. this project just wrote it
          const buffer = sameModel ? asset.buffer : await fetchEngineModel(e.file);
          if (editor.assets.get(asset.id) !== asset) continue; // deleted meanwhile
          const placed = await editor.reloadAsset(asset.id, buffer, meta);
          onUpdate?.(asset, placed);
        } else {
          const size = asset.buffer.byteLength;
          const candidates = list.filter((e) => e.size === size);
          if (!candidates.length) continue;
          const hash = await hashOf(asset.buffer);
          const e = candidates.find((c) => c.sha256 === hash);
          if (!e || engineLink(asset)) continue;
          asset.meta = { ...asset.meta, engine: { file: e.file, modified: e.modified } };
          editor.assets.dispatchEvent(new Event('changed'));
          onLink?.(asset, e);
        }
      }
    } catch (err) {
      console.warn('engine model sync failed', err);
    } finally {
      busy = false;
    }
  };
  check();
  const timer = setInterval(check, interval);
  document.addEventListener('visibilitychange', check);
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); };
}
