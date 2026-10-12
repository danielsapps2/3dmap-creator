import * as THREE from 'three';
import { PRIMITIVES, buildPrimitiveGeometry, primitiveDefaults } from './Primitives.js';
import { MARKERS, buildMarker, refreshMarker, markerDefaults } from './Markers.js';
import { uid } from '../core/utils.js';

/**
 * An entity is an Object3D in the editor's objects root carrying `obj.entity`:
 * { id, kind: 'primitive' | 'asset' | 'marker' | 'group', type, assetId, attach, params, material, props, shadow }
 * `obj.entity` is a plain JS property (not userData) so it never leaks into exports as-is.
 *
 * Entities nest: a child entity is a descendant of its parent's object, either directly or, when `attach` names a
 * bone of the parent (e.g. "RightHand_Socket"), under that bone. Its transform is local to whichever it sits under.
 * Use parentEntity / childEntities / traverseOwn rather than obj.parent / obj.children.
 */

export const DEFAULT_MATERIAL = {
  color: '#c9c9c9', roughness: 0.8, metalness: 0, emissive: '#000000', emissiveIntensity: 1,
  opacity: 1, flatShading: false, doubleSided: false,
};

export const COLLIDERS = ['none', 'box', 'ramp', 'sphere', 'capsule', 'mesh', 'trigger'];

/** Primitives whose walkable surface is a slope rising toward local -Z. */
export const RAMP_PRIMITIVES = ['ramp', 'stairs'];

export function defaultCollider(kind, type) {
  if (kind === 'marker' || kind === 'group') return 'none';
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
    attach: spec.attach ?? null,
    params: {},
    material: null,
    props: { ...defaultProps(kind, spec.type), ...structuredClone(spec.props ?? {}) },
    shadow: { cast: kind !== 'marker' && kind !== 'group', receive: kind !== 'marker' && kind !== 'group', ...spec.shadow },
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
    // characters collide as upright capsules: cheap, and they don't block with a box around outstretched arms
    if (asset.rig && !spec.props?.collider) entity.props.collider = 'capsule';
    obj = new THREE.Group();
    obj.name = spec.name ?? asset.name;
    obj.add(assets.instantiate(spec.assetId));
  } else if (kind === 'marker') {
    const def = MARKERS[spec.type];
    if (!def) throw new Error(`Unknown marker "${spec.type}"`);
    entity.params = { ...markerDefaults(spec.type), ...spec.params };
    obj = buildMarker(spec.type);
    obj.name = spec.name ?? def.label;
  } else if (kind === 'group') {
    entity.type = 'group';
    obj = new THREE.Group();
    obj.name = spec.name ?? 'Empty';
    const axes = new THREE.AxesHelper(0.6); // something to see and click; stripped on export
    axes.userData.editorOnly = true;
    axes.material.depthTest = false;
    axes.renderOrder = 998;
    obj.add(axes);
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
    const inner = assetModel(obj);
    if (inner) {
      inner.position.copy(inner.__basePosition);
      if (e.params.centerPivot) inner.position.sub(inner.__pivotOffset);
    }
  } else if (e.kind === 'marker') {
    refreshMarker(obj, e.type, e.params);
  }
  applyShadows(obj);
}

/** The model instance inside an asset entity (its other children are child entities). */
export function assetModel(obj) {
  return obj.children.find((c) => c.__basePosition) ?? null;
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
  traverseOwn(obj, (o) => {
    if (o.isMesh && !isEditorOnly(o)) {
      o.castShadow = s.cast;
      o.receiveShadow = s.receive;
    }
  });
}

// ------------------------------------------------------------------ hierarchy

/** Visit obj and its descendants, skipping child entities (and everything under them). */
export function traverseOwn(obj, fn) {
  fn(obj);
  for (const c of obj.children) if (!c.entity) traverseOwn(c, fn);
}

/** First node of obj's own parts (not its child entities) with this name. */
export function findOwn(obj, name) {
  let found = null;
  traverseOwn(obj, (o) => { if (!found && o.name === name) found = o; });
  return found;
}

/** The entity this one is a child of, or null for a top-level entity. */
export function parentEntity(obj) {
  let p = obj.parent;
  while (p && !p.entity) p = p.parent;
  return p ?? null;
}

/** Direct child entities, wherever they sit inside obj (directly under it or under one of its bones). */
export function childEntities(obj) {
  const out = [];
  const visit = (o) => { for (const c of o.children) { if (c.entity) out.push(c); else visit(c); } };
  visit(obj);
  return out;
}

/** obj and every entity below it, parents before children. */
export function entitySubtree(obj, out = []) {
  out.push(obj);
  for (const c of childEntities(obj)) entitySubtree(c, out);
  return out;
}

/** True if obj is root or somewhere below it. */
export function isWithin(obj, root) {
  for (let o = obj; o; o = o.parent) if (o === root) return true;
  return false;
}

/** Visible and so are all its ancestors. */
export function isShown(obj) {
  for (let o = obj; o; o = o.parent) if (!o.visible) return false;
  return true;
}

export function isEditorOnly(o) {
  while (o) {
    if (o.userData.editorOnly) return true;
    o = o.parent;
  }
  return false;
}

const _box = new THREE.Box3();

/**
 * World bounds of an entity's own parts, ignoring helper parts flagged `userData.noBounds` (e.g. light range).
 * Child entities are left out, except for an Empty, whose bounds are its children's.
 */
export function entityBounds(obj, target = new THREE.Box3()) {
  target.makeEmpty();
  obj.updateWorldMatrix(true, true);
  const deep = obj.entity?.kind === 'group';
  const visit = (o) => {
    if (o.userData.noBounds || (!deep && o !== obj && o.entity)) return;
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
    parent: parentEntity(obj)?.entity.id ?? null,
    attach: e.attach,
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
  e.attach = s.attach ?? null;
  e.params = structuredClone(s.params);
  e.material = s.material ? { ...s.material } : null;
  e.props = structuredClone(s.props);
  e.shadow = { ...s.shadow };
  refreshEntity(obj);
}

/**
 * Build entities from serialized data (parents listed before their children). Children are placed under their
 * parent (or its `attach` bone); returns the created objects and the roots, whose parent wasn't in the list.
 * onError(data, err) is called for entries that can't be built (their children become roots).
 */
export function buildEntities(list, assets, onError = (d, err) => { throw err; }) {
  const byId = new Map(), objs = [], roots = [];
  for (const data of list) {
    let obj;
    try {
      obj = createEntity(data, assets);
    } catch (err) {
      onError(data, err);
      continue;
    }
    const parent = data.parent ? byId.get(data.parent) : null;
    if (parent) {
      const bone = obj.entity.attach ? findOwn(parent, obj.entity.attach) : null;
      if (!bone) obj.entity.attach = null;
      (bone ?? parent).add(obj);
    } else {
      obj.entity.attach = null;
      roots.push(obj);
    }
    byId.set(obj.entity.id, obj);
    objs.push(obj);
  }
  return { objs, roots };
}

/** Dispose an entity and every entity below it. */
export function disposeEntity(obj) {
  obj.traverse((o) => {
    if (o.isMesh || o.isLine) {
      // Asset geometry/materials are shared with the library source; only dispose our own.
      let owner = o;
      while (owner && !owner.entity) owner = owner.parent;
      if (owner?.entity?.kind !== 'asset' || isEditorOnly(o)) {
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
  if (e.kind === 'group') return 'Empty game object';
  return 'GLB asset';
}

export function entityIcon(obj) {
  const e = obj.entity;
  if (e.kind === 'primitive') return PRIMITIVES[e.type]?.icon ?? '■';
  if (e.kind === 'marker') return MARKERS[e.type]?.icon ?? '◆';
  if (e.kind === 'group') return '◇';
  return '⬢';
}
