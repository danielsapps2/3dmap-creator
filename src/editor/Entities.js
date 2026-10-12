import * as THREE from 'three';
import { PRIMITIVES, buildPrimitiveGeometry, primitiveDefaults } from './Primitives.js';
import { MARKERS, buildMarker, refreshMarker, markerDefaults } from './Markers.js';
import { uid } from '../core/utils.js';

/**
 * An entity is a top-level Object3D in the editor's objects root carrying `obj.entity`:
 * { id, kind: 'primitive' | 'asset' | 'marker', type, assetId, params, material, props, shadow }
 * `obj.entity` is a plain JS property (not userData) so it never leaks into exports as-is.
 */

export const DEFAULT_MATERIAL = {
  color: '#c9c9c9', roughness: 0.8, metalness: 0, emissive: '#000000', emissiveIntensity: 1,
  opacity: 1, flatShading: false, doubleSided: false,
};

export const COLLIDERS = ['none', 'box', 'ramp', 'sphere', 'mesh', 'trigger'];

/** Primitives whose walkable surface is a slope rising toward local -Z. */
export const RAMP_PRIMITIVES = ['ramp', 'stairs'];

export function defaultCollider(kind, type) {
  if (kind === 'marker') return 'none';
  return kind === 'primitive' && RAMP_PRIMITIVES.includes(type) ? 'ramp' : 'box';
}

export function defaultProps(kind, type) {
  return { collider: defaultCollider(kind, type), isStatic: true, tags: '', custom: [] };
}

export function createEntity(spec, assets) {
  const kind = spec.kind;
  const entity = {
    id: spec.id ?? uid(),
    kind,
    type: spec.type ?? null,
    assetId: spec.assetId ?? null,
    params: {},
    material: null,
    props: { ...defaultProps(kind, spec.type), ...structuredClone(spec.props ?? {}) },
    shadow: { cast: kind !== 'marker', receive: kind !== 'marker', ...spec.shadow },
  };
  let obj;

  if (kind === 'primitive') {
    const def = PRIMITIVES[spec.type];
    if (!def) throw new Error(`Unknown primitive "${spec.type}"`);
    entity.params = { ...primitiveDefaults(spec.type), ...spec.params };
    entity.material = { ...DEFAULT_MATERIAL, ...spec.material };
    obj = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
    obj.name = spec.name ?? def.label;
  } else if (kind === 'asset') {
    const asset = assets.get(spec.assetId);
    if (!asset) throw new Error(`Missing asset "${spec.assetId}"`);
    entity.type = 'asset';
    entity.params = { centerPivot: true, ...spec.params };
    obj = new THREE.Group();
    obj.name = spec.name ?? asset.name;
    obj.add(assets.instantiate(spec.assetId));
  } else if (kind === 'marker') {
    const def = MARKERS[spec.type];
    if (!def) throw new Error(`Unknown marker "${spec.type}"`);
    entity.params = { ...markerDefaults(spec.type), ...spec.params };
    obj = buildMarker(spec.type);
    obj.name = spec.name ?? def.label;
  } else {
    throw new Error(`Unknown entity kind "${kind}"`);
  }

  obj.entity = entity;
  refreshEntity(obj);
  const finite = (a, n) => Array.isArray(a) && a.length >= n && a.slice(0, n).every((v) => Number.isFinite(v));
  if (finite(spec.position, 3)) obj.position.fromArray(spec.position);
  if (finite(spec.rotation, 3)) obj.rotation.set(spec.rotation[0], spec.rotation[1], spec.rotation[2]);
  if (finite(spec.scale, 3)) obj.scale.fromArray(spec.scale);
  if (spec.visible === false) obj.visible = false;
  return obj;
}

/** Re-apply entity params/material/shadow settings to the scene object. */
export function refreshEntity(obj) {
  const e = obj.entity;
  if (e.kind === 'primitive') {
    const key = JSON.stringify(e.params);
    if (key !== e._paramsKey) {
      const old = obj.geometry;
      obj.geometry = buildPrimitiveGeometry(e.type, e.params);
      old.dispose();
      e._paramsKey = key;
    }
    applyMaterial(obj);
  } else if (e.kind === 'asset') {
    const inner = obj.children[0];
    if (inner?.__basePosition) {
      inner.position.copy(inner.__basePosition);
      if (e.params.centerPivot) inner.position.sub(inner.__pivotOffset);
    }
  } else if (e.kind === 'marker') {
    refreshMarker(obj, e.type, e.params);
  }
  applyShadows(obj);
}

function applyMaterial(obj) {
  const m = obj.material, p = obj.entity.material;
  m.name = obj.name;
  m.color.set(p.color);
  m.roughness = p.roughness;
  m.metalness = p.metalness;
  m.emissive.set(p.emissive);
  m.emissiveIntensity = p.emissiveIntensity;
  m.opacity = p.opacity;
  const transparent = p.opacity < 1;
  const side = p.doubleSided || obj.entity.type === 'plane' ? THREE.DoubleSide : THREE.FrontSide;
  if (m.transparent !== transparent || m.flatShading !== p.flatShading || m.side !== side) {
    m.transparent = transparent;
    m.flatShading = p.flatShading;
    m.side = side;
    m.needsUpdate = true;
  }
}

function applyShadows(obj) {
  const s = obj.entity.shadow;
  obj.traverse((o) => {
    if (o.isMesh && !isEditorOnly(o)) {
      o.castShadow = s.cast;
      o.receiveShadow = s.receive;
    }
  });
}

export function isEditorOnly(o) {
  while (o) {
    if (o.userData.editorOnly) return true;
    o = o.parent;
  }
  return false;
}

const _box = new THREE.Box3();

/** World bounds of an entity, ignoring helper parts flagged `userData.noBounds` (e.g. light range). */
export function entityBounds(obj, target = new THREE.Box3()) {
  target.makeEmpty();
  obj.updateWorldMatrix(true, true);
  const visit = (o) => {
    if (o.userData.noBounds) return;
    if (o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      _box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      target.union(_box);
    }
    for (const c of o.children) visit(c);
  };
  visit(obj);
  if (target.isEmpty()) target.setFromCenterAndSize(obj.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0.5, 0.5, 0.5));
  return target;
}

export function serializeEntity(obj) {
  const e = obj.entity;
  return {
    id: e.id,
    kind: e.kind,
    type: e.type,
    assetId: e.assetId,
    name: obj.name,
    visible: obj.visible,
    position: obj.position.toArray(),
    rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
    scale: obj.scale.toArray(),
    params: structuredClone(e.params),
    material: e.material ? { ...e.material } : null,
    props: structuredClone(e.props),
    shadow: { ...e.shadow },
  };
}

export function deserializeEntity(data, assets) {
  return createEntity(data, assets);
}

export function applyEntityState(obj, s) {
  const e = obj.entity;
  obj.name = s.name;
  obj.visible = s.visible;
  obj.position.fromArray(s.position);
  obj.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
  obj.scale.fromArray(s.scale);
  e.params = structuredClone(s.params);
  e.material = s.material ? { ...s.material } : null;
  e.props = structuredClone(s.props);
  e.shadow = { ...s.shadow };
  refreshEntity(obj);
}

export function disposeEntity(obj) {
  obj.traverse((o) => {
    if (o.isMesh || o.isLine) {
      // Asset geometry/materials are shared with the library source; only dispose our own.
      if (obj.entity?.kind !== 'asset' || isEditorOnly(o)) {
        o.geometry?.dispose();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose();
      }
    }
  });
}

/** Turn [{key, value}] custom props into an object, parsing numbers/booleans/JSON. */
export function customPropsToObject(list) {
  const out = {};
  for (const { key, value } of list ?? []) {
    if (!key) continue;
    out[key] = parseValue(value);
  }
  return out;
}

function parseValue(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && !isNaN(Number(t))) return Number(t);
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { return JSON.parse(t); } catch { /* keep as string */ }
  }
  return v;
}

export function entityLabel(obj) {
  const e = obj.entity;
  if (e.kind === 'primitive') return PRIMITIVES[e.type]?.label ?? e.type;
  if (e.kind === 'marker') return MARKERS[e.type]?.label ?? e.type;
  return 'GLB asset';
}

export function entityIcon(obj) {
  const e = obj.entity;
  if (e.kind === 'primitive') return PRIMITIVES[e.type]?.icon ?? '■';
  if (e.kind === 'marker') return MARKERS[e.type]?.icon ?? '◆';
  return '⬢';
}
