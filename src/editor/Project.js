import { serializeEntity, buildEntities, RAMP_PRIMITIVES } from './Entities.js';
import { DEFAULT_ENV } from './Editor.js';
import { arrayBufferToBase64, base64ToArrayBuffer } from '../core/utils.js';

export const PROJECT_FORMAT = '3dmap-creator-project';

/** Snapshot of the whole editor. Contains typed arrays / ArrayBuffers (IndexedDB-friendly). */
export function serializeProject(editor) {
  return {
    format: PROJECT_FORMAT,
    version: 5,
    name: editor.mapName,
    savedAt: new Date().toISOString(),
    environment: { ...editor.env },
    terrain: editor.terrain.toJSON(),
    assets: editor.assets.list().map((a) => ({ id: a.id, name: a.fileName, path: a.path, buffer: a.buffer, meta: a.meta })),
    objects: editor.objects.map(serializeEntity), // parents before children; transforms are local to the parent
    clips: [], // projects don't keep clips: the library lives in the engine (EngineClips.js)
    scripts: editor.scripts?.toJSON() ?? [], // the map's scripts (v5); objects refer to them by id
    camera: { position: editor.camera.position.toArray(), target: editor.orbit.target.toArray() },
    settings: {
      snap: { ...editor.snap },
      brush: { ...editor.brush },
      placeOptions: { ...editor.placeOptions },
      flySpeed: editor.fly.speed,
    },
  };
}

/**
 * mergeClips: add the file's animation clips to the shared library. The autosave skips it: the library keeps its
 * own, newer copy in IndexedDB.
 */
export async function loadProject(editor, data, { onWarning = console.warn, mergeClips = true } = {}) {
  if (data?.format !== PROJECT_FORMAT) throw new Error('Not a 3D Map Creator project file');
  editor.clearAll();
  editor.mapName = data.name ?? 'Untitled Map';
  editor.env = { ...DEFAULT_ENV, ...data.environment };
  editor.scripts?.load(data.scripts ?? []);
  const repaired = editor.terrain.fromJSON(data.terrain);
  if (repaired) onWarning(`Repaired ${repaired} invalid terrain height${repaired === 1 ? '' : 's'}`);
  editor.applyEnvironment();

  for (const a of data.assets ?? []) {
    try {
      await editor.assets.add(a.name, a.buffer, a.id, a.meta, a.path ?? null);
    } catch (err) {
      onWarning(`Could not load asset "${a.name}": ${err.message}`);
    }
  }
  for (const o of data.objects ?? []) {
    // v1 had no ramp collider, so ramps/stairs were saved with the default 'box'.
    if ((data.version ?? 1) < 2 && o.kind === 'primitive' && RAMP_PRIMITIVES.includes(o.type) && o.props?.collider === 'box') {
      o.props.collider = 'ramp';
    }
  }
  // Before v4 rigged models defaulted to a box collider (around their outstretched arms, and expensive for the
  // playtest camera); they collide as capsules now.
  if ((data.version ?? 1) < 4) {
    for (const o of data.objects ?? []) {
      if (o.kind === 'asset' && o.props?.collider === 'box' && editor.assets.get(o.assetId)?.rig) o.props.collider = 'capsule';
    }
  }
  // v1/v2 objects have no `parent`, so they all load at the top level.
  const { roots } = buildEntities(data.objects ?? [], editor.assets, (o, err) => onWarning(`Skipped object "${o.name}": ${err.message}`));
  roots.forEach((r) => editor.objectsRoot.add(r));
  if (data.camera) {
    editor.camera.position.fromArray(data.camera.position);
    editor.orbit.target.fromArray(data.camera.target);
  }
  if (data.settings) {
    Object.assign(editor.brush, data.settings.brush);
    Object.assign(editor.placeOptions, data.settings.placeOptions);
    editor.setSnap(data.settings.snap ?? {});
    if (Number.isFinite(data.settings.flySpeed)) editor.fly.speed = Math.min(500, Math.max(1, data.settings.flySpeed));
  }
  if (mergeClips) editor.clips?.addMissing(data.clips); // an older project's clips join the engine's (its own win)
  editor.history.clear();
  editor.emit('sceneChanged');
  editor.emit('terrainChanged');
  editor.emit('envChanged');
  editor.emit('brushChanged');
}

/** JSON encoding with binary data stored as base64. */
export function projectToJSON(data) {
  return JSON.stringify(data, (key, value) => {
    if (value instanceof Float32Array) return { $f32: arrayBufferToBase64(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) };
    if (value instanceof ArrayBuffer) return { $bin: arrayBufferToBase64(value) };
    return value;
  });
}

export function projectFromJSON(text) {
  return JSON.parse(text, (key, value) => {
    if (value && typeof value === 'object') {
      if (typeof value.$f32 === 'string') return new Float32Array(base64ToArrayBuffer(value.$f32));
      if (typeof value.$bin === 'string') return base64ToArrayBuffer(value.$bin);
    }
    return value;
  });
}
