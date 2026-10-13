import { listTinyimgen, fetchTinyimgen, propFiles } from '../core/tinyimgen.js';

let catalog = null;

/** tinyimgen's characters and props ({ characters, props }), fetched once and shared by the panels. */
export function tinyimgenCatalog({ refresh = false } = {}) {
  if (refresh || !catalog) catalog = listTinyimgen();
  return catalog;
}

/**
 * The library asset for a tinyimgen character or prop, downloading it the first time. Props bring their grip.json
 * (hold, finger curls, carry pose) along in the asset's meta, so the hold is saved with the project.
 */
export async function importTinyimgen(editor, item) {
  const have = editor.assets.findTinyimgen(item.id, item.role);
  if (have) return have;
  const [buffer, grip] = await Promise.all([
    fetchTinyimgen(item.url),
    item.gripUrl ? fetchTinyimgen(item.gripUrl, 'json').catch(() => null) : null,
  ]);
  return editor.assets.add(`${item.name}.glb`, buffer, undefined, { tinyimgen: { id: item.id, role: item.role }, grip });
}

/**
 * Keep the library's tinyimgen props in step with the Prop Editor: check each prop's grip.json every couple of
 * seconds (and when the tab comes back into view), and when a save changed it, load the new prop.glb + grip into the
 * library and every placed copy. onUpdate(asset, placedCount) runs after each one.
 */
export function watchTinyimgenProps(editor, { interval = 2000, onUpdate } = {}) {
  let busy = false;
  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const asset of editor.assets.list()) {
        const src = asset.meta.tinyimgen;
        if (src?.role !== 'prop') continue;
        const { url, gripUrl } = propFiles(src.id);
        const grip = await fetchTinyimgen(gripUrl, 'json').catch(() => null); // offline, or the job was deleted
        if (!grip || JSON.stringify(grip) === JSON.stringify(asset.meta.grip ?? null)) continue;
        // grip.json is written just before prop.glb is rebuilt from it; give the rebuild a moment to land
        await new Promise((r) => setTimeout(r, 400));
        const buffer = await fetchTinyimgen(url).catch(() => null);
        if (!buffer || editor.assets.get(asset.id) !== asset) continue;
        const placed = await editor.reloadAsset(asset.id, buffer, { ...asset.meta, grip });
        onUpdate?.(asset, placed);
      }
    } catch (err) {
      console.warn('tinyimgen prop sync failed', err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(check, interval);
  document.addEventListener('visibilitychange', check);
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); };
}
