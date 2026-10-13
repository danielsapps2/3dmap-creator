// Client for the engine's shared library (engine/, served by server/engine.js under /engine): models and animation
// clips every project uses, kept in one place so a change reaches all of them.

export const ENGINE = '/engine';

const url = (kind, file) => `${ENGINE}/${kind}/${file.split('/').map(encodeURIComponent).join('/')}`;
const fileUrl = (file) => url('models', file);

async function list(kind) {
  let res;
  try {
    res = await fetch(`${ENGINE}/api/${kind}`, { cache: 'no-cache' });
  } catch {
    throw new Error('the engine library is not reachable');
  }
  if (!res.ok || !res.headers.get('content-type')?.includes('json')) {
    throw new Error('the engine library is not available (run the editor with npm run dev or npm run preview)');
  }
  return res.json();
}

/** [{ file, name, size, modified, sha256, meta }]. Throws when the editor isn't served with the engine library. */
export const listEngineModels = () => list('models');

export async function fetchEngineModel(file) {
  const res = await fetch(fileUrl(file), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Couldn't download ${file} from the engine (HTTP ${res.status})`);
  return res.arrayBuffer();
}

/** Write a model (and its asset meta) to the engine. Returns its new listing entry. */
export async function saveEngineModel(file, buffer, meta = {}) {
  const put = async (path, body, type) => {
    const res = await fetch(fileUrl(path), { method: 'PUT', headers: { 'Content-Type': type }, body });
    if (!res.ok) throw new Error(`Couldn't write ${path} to the engine: ${await res.text()}`);
    return res;
  };
  // meta first: the model's write is the change other tabs and projects pick up
  await put(file.replace(/\.(glb|gltf)$/i, '.meta.json'), JSON.stringify(meta, null, 2), 'application/json');
  return (await put(file, buffer, 'application/octet-stream')).json();
}

/** SHA-256 of a buffer as hex (matches the listing's sha256). */
export async function sha256(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ clips

/** [{ file, size, modified }] (file: path under engine/clips/). Throws without the engine library. */
export const listEngineClips = () => list('clips');

export async function fetchEngineClip(file) {
  const res = await fetch(url('clips', file), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Couldn't read ${file} from the engine (HTTP ${res.status})`);
  return res.text();
}

/** Write a clip file (its JSON text). Returns its listing entry { file, size, modified }. */
export async function saveEngineClip(file, text) {
  const res = await fetch(url('clips', file), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: text });
  if (!res.ok) throw new Error(`Couldn't write ${file} to the engine: ${await res.text()}`);
  return res.json();
}

export async function deleteEngineClip(file) {
  const res = await fetch(url('clips', file), { method: 'DELETE' });
  if (!res.ok) throw new Error(`Couldn't delete ${file} from the engine: ${await res.text()}`);
}
