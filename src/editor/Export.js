import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { customPropsToObject, isEditorOnly, childEntities, parentEntity, isShown } from './Entities.js';
import { holdData } from './Rig.js';
import { usedScripts } from './Scripts.js';
import { findBones } from '../anim/skeleton.js';
import { arrayBufferToBase64 } from '../core/utils.js';

export const MAP_FORMAT = '3dmap-creator';

/** Game-facing metadata written to each node's userData (glTF "extras"). */
export function exportUserData(obj, editor) {
  const e = obj.entity;
  const ud = {
    mapType: e.kind,
    id: e.id,
    collider: e.props.collider,
    static: e.props.isStatic,
    tags: e.props.tags.split(',').map((t) => t.trim()).filter(Boolean),
    castShadow: e.shadow.cast,
    receiveShadow: e.shadow.receive,
    props: customPropsToObject(e.props.custom),
  };
  const parent = parentEntity(obj);
  if (parent) ud.parentId = parent.entity.id;
  if (e.attach) ud.attachedTo = e.attach; // the parent's bone this node is parented to (e.g. "RightHand_Socket")
  if (e.kind === 'primitive') {
    ud.primitive = e.type;
    ud.params = { ...e.params };
  } else if (e.kind === 'asset') {
    const asset = editor.assets.get(e.assetId);
    ud.asset = asset?.name ?? e.assetId;
    if (asset?.meta.tinyimgen) ud.tinyimgen = { ...asset.meta.tinyimgen };
    if (asset?.rig) {
      ud.rig = { sockets: [...asset.rig.sockets] };
      // the node is exported in the editor's pose; animating it from code needs the hips' rest position
      const hips = findBones(asset.scene)?.Hips;
      if (hips) ud.rig.restHips = hips.position.toArray();
    }
    if (asset?.prop) ud.grip = holdData(obj, editor.assets); // tinyimgen grip.json + this instance's edits
  } else if (e.kind === 'marker') {
    ud.marker = e.type;
    ud.params = { ...e.params };
  }
  // scripts attached in the editor (sources are on the scene root): run by src/runtime/scripts.js
  const scripts = (e.scripts ?? []).map((r) => ({ ref: r, script: editor.scripts?.get(r.id) })).filter((x) => x.script);
  if (scripts.length) ud.scripts = scripts.map(({ ref, script }) => ({ script: script.id, name: script.name, params: { ...ref.params } }));
  return ud;
}

/** Run fn with obj's child entities taken out of it, so cloning obj copies only its own parts. */
function withoutChildEntities(obj, fn) {
  const kids = childEntities(obj).map((k) => ({ k, parent: k.parent, index: k.parent.children.indexOf(k) }));
  kids.forEach(({ k }) => k.parent.remove(k));
  try {
    return fn();
  } finally {
    for (const { k, parent, index } of kids.reverse()) {
      parent.children.splice(index, 0, k);
      k.parent = parent;
    }
  }
}

function cloneForExport(obj, editor) {
  const e = obj.entity;
  let c;
  if (e.kind === 'marker') {
    c = obj.isPointLight
      ? new THREE.PointLight(obj.color, obj.intensity, obj.distance, obj.decay)
      : new THREE.Object3D();
  } else if (e.kind === 'asset') {
    c = withoutChildEntities(obj, () => skeletonClone(obj));
  } else if (e.kind === 'group') {
    c = new THREE.Object3D();
  } else {
    c = obj.clone(false);
  }
  c.name = obj.name;
  c.position.copy(obj.position);
  c.quaternion.copy(obj.quaternion);
  c.scale.copy(obj.scale);
  const strip = [];
  c.traverse((o) => { if (o !== c && isEditorOnly(o)) strip.push(o); });
  strip.forEach((o) => o.removeFromParent());
  c.userData = exportUserData(obj, editor);
  return c;
}

/**
 * An entity and its visible child entities as nested nodes. A child attached to a bone goes under that bone's
 * copy, so a held prop follows the hand in any engine that animates the character.
 */
function exportTree(obj, editor, includeMarkers) {
  const kids = childEntities(obj).filter((k) => k.visible);
  let c;
  if (!includeMarkers && obj.entity.kind === 'marker') {
    if (!kids.length) return null;
    c = new THREE.Object3D(); // keep the marker's children where they are
    c.name = obj.name;
    c.position.copy(obj.position);
    c.quaternion.copy(obj.quaternion);
    c.scale.copy(obj.scale);
  } else {
    c = cloneForExport(obj, editor);
  }
  for (const k of kids) {
    const kc = exportTree(k, editor, includeMarkers);
    if (!kc) continue;
    let host = c;
    if (k.entity.attach) c.traverse((n) => { if (host === c && n.name === k.entity.attach) host = n; });
    host.add(kc);
  }
  return c;
}

export function buildExportScene(editor, { includeTerrain = true, includeMarkers = true } = {}) {
  const root = new THREE.Scene();
  root.name = editor.mapName;
  const t = editor.terrain;
  root.userData = {
    mapFormat: MAP_FORMAT,
    version: 1,
    name: editor.mapName,
    environment: { ...editor.env },
    terrain: includeTerrain ? { name: 'Terrain', size: t.size, segments: t.segments } : null,
  };
  const shown = editor.objects.filter((o) => isShown(o));
  if (editor.scripts) {
    const scripts = usedScripts(editor.scripts, shown);
    if (Object.keys(scripts).length) root.userData.scripts = scripts;
  }
  const clips = animationClips(editor, shown);
  if (clips.length) root.userData.clips = encodeClips(clips);
  if (includeTerrain) {
    const mesh = new THREE.Mesh(t.mesh.geometry, t.material);
    mesh.name = 'Terrain';
    mesh.userData = {
      mapType: 'terrain', size: t.size, segments: t.segments, collider: 'heightfield', static: true,
      castShadow: true, receiveShadow: true,
    };
    root.add(mesh);
  }
  editor.updatePoses(); // characters export in the pose the editor shows (idle frame, holding their props)
  for (const obj of editor.roots) {
    if (!obj.visible) continue;
    const c = exportTree(obj, editor, includeMarkers);
    if (c) root.add(c);
  }
  return root;
}

/**
 * Clips for animating the map's tinyimgen characters from code (runtime/animator.js, runtime/clipLocomotion.js): the
 * animation library (the engine's clips). Empty without characters.
 */
function animationClips(editor, objects) {
  const characters = objects.some((o) => {
    const scene = o.entity.kind === 'asset' && editor.assets.get(o.entity.assetId)?.scene;
    return !!scene && !!findBones(scene);
  });
  return characters ? [...(editor.clips?.clips ?? [])].map(({ path, ...clip }) => clip) : [];
}

/** Clips as glTF extras (plain JSON): Float32Arrays become { $f32: base64 } (decodeClips in runtime/animator.js). */
function encodeClips(clips) {
  const enc = (v) => {
    if (v instanceof Float32Array) return { $f32: arrayBufferToBase64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) };
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)]));
    return v;
  };
  return clips.map(enc);
}

/** Returns a Blob containing a .glb (binary) or .gltf (JSON) of the map. */
export async function exportMap(editor, { binary = true, ...opts } = {}) {
  const root = buildExportScene(editor, opts);
  const result = await new GLTFExporter().parseAsync(root, { binary, onlyVisible: true });
  return binary
    ? new Blob([result], { type: 'model/gltf-binary' })
    : new Blob([JSON.stringify(result, null, 2)], { type: 'model/gltf+json' });
}

/** Lightweight layout JSON: transforms + metadata, for games that load their own models. */
export function exportLayoutJSON(editor) {
  const t = editor.terrain;
  const data = {
    format: `${MAP_FORMAT}-layout`,
    version: 1,
    name: editor.mapName,
    environment: { ...editor.env },
    terrain: {
      size: t.size,
      segments: t.segments,
      // Row-major, index = iz * (segments + 1) + ix; x = ix * size / segments - size / 2 (same for z)
      heights: Array.from(t.heights, (h) => Math.round(h * 1000) / 1000),
    },
    // Parents come before their children; a child's transform is local to its parent (or to the parent's bone
    // `attachedTo`).
    objects: editor.objects.map((obj) => ({
      name: obj.name,
      visible: obj.visible,
      position: obj.position.toArray(),
      rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
      quaternion: obj.quaternion.toArray(),
      scale: obj.scale.toArray(),
      ...exportUserData(obj, editor),
      material: obj.entity.material ?? undefined,
    })),
  };
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}
