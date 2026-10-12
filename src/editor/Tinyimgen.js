import { listTinyimgen, fetchTinyimgen } from '../core/tinyimgen.js';

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
