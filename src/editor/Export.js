import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { customPropsToObject, isEditorOnly } from './Entities.js';

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
  if (e.kind === 'primitive') {
    ud.primitive = e.type;
    ud.params = { ...e.params };
  } else if (e.kind === 'asset') {
    ud.asset = editor.assets.get(e.assetId)?.name ?? e.assetId;
  } else if (e.kind === 'marker') {
    ud.marker = e.type;
    ud.params = { ...e.params };
  }
  return ud;
}

function cloneForExport(obj, editor) {
  const e = obj.entity;
  let c;
  if (e.kind === 'marker') {
    c = obj.isPointLight
      ? new THREE.PointLight(obj.color, obj.intensity, obj.distance, obj.decay)
      : new THREE.Object3D();
  } else if (e.kind === 'asset') {
    c = skeletonClone(obj);
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
  if (includeTerrain) {
    const mesh = new THREE.Mesh(t.mesh.geometry, t.material);
    mesh.name = 'Terrain';
    mesh.userData = {
      mapType: 'terrain', size: t.size, segments: t.segments, collider: 'heightfield', static: true,
      castShadow: true, receiveShadow: true,
    };
    root.add(mesh);
  }
  for (const obj of editor.objects) {
    if (!obj.visible) continue;
    if (!includeMarkers && obj.entity.kind === 'marker') continue;
    root.add(cloneForExport(obj, editor));
  }
  return root;
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
