// Project file paths ("scripts/enemies/Goblin.js", "assets/knight.glb", "clips/Wave.clip.json"): always relative to
// the project folder, with forward slashes.

/** A file-name-safe version of a name: keeps letters, digits, spaces and - _ ( ) [ ]. */
export const fileStem = (name) => (name || 'untitled').replace(/[^\w\- ()[\]]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';

export const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);
export const dirName = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** File name without the extension ('.clip.json' counts as one). */
export const stemOf = (path) => baseName(path).replace(/(\.clip\.json|\.[^.]+)$/i, '');
export const extOf = (path) => (baseName(path).match(/(\.clip\.json|\.[^.]+)$/i)?.[1] ?? '').toLowerCase();

/** dir/stem+ext, or dir/stem 2+ext… if that's taken (taken: paths, compared case-insensitively). */
export function uniquePath(dir, stem, ext, taken) {
  const lower = new Set([...taken].map((p) => p.toLowerCase()));
  const make = (s) => `${dir ? `${dir}/` : ''}${s}${ext}`;
  if (!lower.has(make(stem).toLowerCase())) return make(stem);
  const base = stem.replace(/ \d+$/, '');
  for (let i = 2; ; i++) if (!lower.has(make(`${base} ${i}`).toLowerCase())) return make(`${base} ${i}`);
}
