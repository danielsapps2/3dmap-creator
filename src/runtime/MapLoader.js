/**
 * MapLoader — drop this file into your three.js game to load maps exported by 3D Map Creator.
 * Depends only on `three` and its GLTFLoader addon.
 *
 *   import { loadMap, applyEnvironment } from './MapLoader.js';
 *   const map = await loadMap('/maps/level1.glb');
 *   scene.add(map.root);
 *   applyEnvironment(scene, map.environment, { renderer });
 *   const spawn = map.spawns[0];
 *   player.position.copy(spawn.position);
 *   const groundY = map.getHeightAt(x, z);
 *
 * Every exported node carries game data in `node.userData`:
 *   { mapType: 'primitive'|'asset'|'marker'|'group'|'terrain', id, collider, static, tags[], props{}, ... }
 * Objects can have child objects (nested nodes, `userData.parentId`). A child attached to one of its parent's bones,
 * like a prop held in a character's hand, is parented to that bone and has `userData.attachedTo` (the bone's name).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function loadMap(url, { loader = new GLTFLoader() } = {}) {
  const gltf = await loader.loadAsync(url);
  return createMap(gltf.scene, gltf);
}

export async function parseMap(arrayBuffer, { loader = new GLTFLoader() } = {}) {
  const gltf = await loader.parseAsync(arrayBuffer, '');
  return createMap(gltf.scene, gltf);
}

export function createMap(root, gltf = null) {
  root.updateMatrixWorld(true);
  const map = {
    root,
    gltf,
    name: root.userData.name ?? root.name,
    environment: root.userData.environment ?? null,
    terrain: null,
    objects: [],   // primitives + models
    markers: [],   // every marker node
    spawns: [],    // { node, position, rotationY, quaternion, params }
    triggers: [],  // { node, name, event, size, contains(point) }
    waypoints: [],
    lights: [],
    held: [],      // objects attached to a bone of their parent: { node, parent, bone, attachedTo, grip } — see hold.js
    colliders: [], // { node, type, box: Box3 (world AABB), isStatic, surfaceAt(), pushOut(), overlaps() } — see createCollider
    byId: new Map(),
    getHeightAt: () => 0,
    /** Highest walkable surface (terrain or collider top) at (x, z) that is not above maxY. */
    getSurfaceAt(x, z, maxY = Infinity, radius = 0) {
      let best = map.getHeightAt(x, z);
      for (const c of map.colliders) {
        if (c.type === 'trigger') continue;
        const y = c.surfaceAt(x, z, radius);
        if (y !== null && y <= maxY && y > best) best = y;
      }
      return best;
    },
    findByTag: (tag) => [...map.objects, ...map.markers].filter((n) => n.userData.tags?.includes(tag)),
    /** The map object a node is a child of (null for top-level objects). */
    parentOf: (node) => map.byId.get(node.userData.parentId) ?? null,
    /** A map object's child objects. */
    childrenOf: (node) => nodes.filter((n) => n.userData.parentId === node.userData.id),
    // GLTFLoader sanitizes node names ("Player Spawn" -> "Player_Spawn") and keeps the original in userData.name.
    findByName: (name) => root.getObjectByName(name) ?? findByOriginalName(root, name),
  };

  const nodes = [];
  root.traverse((n) => { if (n.userData?.mapType) nodes.push(n); });

  for (const node of nodes) {
    const ud = node.userData;
    if (ud.id) map.byId.set(ud.id, node);
    if (ud.castShadow !== undefined) {
      traverseOwn(node, (m) => {
        if (m.isMesh) { m.castShadow = !!ud.castShadow; m.receiveShadow = !!ud.receiveShadow; }
      });
    }
    if (ud.attachedTo) {
      map.held.push({ node, parent: map.byId.get(ud.parentId) ?? null, bone: node.parent, attachedTo: ud.attachedTo, grip: ud.grip ?? null });
    }

    switch (ud.mapType) {
      case 'terrain':
        map.terrain = node;
        map.getHeightAt = createHeightSampler(node);
        break;
      case 'group':
        map.objects.push(node);
        break;
      case 'primitive':
      case 'asset':
        map.objects.push(node);
        if (ud.collider && ud.collider !== 'none') {
          map.colliders.push(ud.collider === 'capsule' ? createCapsuleCollider(node) : createCollider(node));
        }
        break;
      case 'marker': {
        map.markers.push(node);
        const position = node.getWorldPosition(new THREE.Vector3());
        const quaternion = node.getWorldQuaternion(new THREE.Quaternion());
        if (ud.marker === 'spawn') {
          const rotationY = new THREE.Euler().setFromQuaternion(quaternion, 'YXZ').y;
          map.spawns.push({ node, position, quaternion, rotationY, params: ud.params ?? {} });
        } else if (ud.marker === 'trigger') {
          map.triggers.push(createTrigger(node));
        } else if (ud.marker === 'waypoint') {
          map.waypoints.push({ node, position, radius: ud.params?.radius ?? 1, params: ud.params ?? {} });
        } else if (ud.marker === 'pointLight') {
          // GLTFLoader recreates the light (KHR_lights_punctual) as a child or as the node itself.
          let light = node.isLight ? node : null;
          node.traverse((c) => { if (!light && c.isLight) light = c; });
          if (light) {
            light.castShadow = !!ud.params?.castShadow;
            map.lights.push(light);
          }
        }
        break;
      }
    }
  }
  return map;
}

const _p = new THREE.Vector3(), _up = new THREE.Vector3(), _n = new THREE.Vector3();

/**
 * Collider for a primitive/asset node, oriented with the node (rotation + scale), built from its local bounds.
 * Its walkable top surface is flat, except for type 'ramp': a slope rising from the local +Z edge (bottom)
 * toward -Z (top), like the editor's ramp and stairs primitives, so stairs can be walked up smoothly.
 *
 *   surfaceAt(x, z, radius = 0, normal?) → world Y of the top surface at (x, z), or null when (x, z) is more than
 *                                          `radius` outside the footprint. Writes the world surface normal to `normal`.
 *   overlaps(pos, radius)                → true when the circle (pos.x, pos.z, radius) touches the footprint.
 *   pushOut(pos, radius)                 → moves pos.x/pos.z to the nearest footprint edge (+radius); true if moved.
 * Type 'capsule' builds an upright capsule instead (createCapsuleCollider).
 */
export function createCollider(node) {
  const ud = node.userData;
  const type = ud.collider;
  const matrix = node.matrixWorld.clone();
  const inverse = matrix.clone().invert();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const local = localBounds(node, inverse);
  const { min, max } = local;
  const sx = new THREE.Vector3().setFromMatrixColumn(matrix, 0).length() || 1;
  const sz = new THREE.Vector3().setFromMatrixColumn(matrix, 2).length() || 1;

  // Ramp profile in local space: rises from min.y at the z = max.z edge to max.y at z = min.z, flat once it reaches
  // the top. Stairs get the line through the middle of each riser (half a step above the inner corners), so feet
  // stay within half a step of every tread.
  const isRamp = type === 'ramp';
  const steps = ud.primitive === 'stairs' ? Math.max(1, Math.round(ud.params?.steps ?? 1)) : 0;
  const rise = max.y - min.y, slope = rise / Math.max(max.z - min.z, 1e-6);
  const lip = steps ? rise / (2 * steps) : 0;
  const topZ = max.z - (rise - lip) / Math.max(slope, 1e-6); // where the slope meets the top
  const profile = (z) => (isRamp ? Math.min(max.y, min.y + lip + slope * (max.z - z)) : max.y);
  const slopeNormal = new THREE.Vector3(0, 1, slope).applyMatrix3(normalMatrix).normalize();
  const flatNormal = new THREE.Vector3(0, 1, 0).applyMatrix3(normalMatrix).normalize();

  const toLocal = (pos) => {
    _p.set(pos.x, 0, pos.z).applyMatrix4(inverse);
    // Slide along the world-vertical line to the top plane, so tilted objects use the right footprint point.
    _up.set(0, 1, 0).transformDirection(inverse);
    if (Math.abs(_up.y) > 1e-6) _p.addScaledVector(_up, (max.y - _p.y) / _up.y);
    return _p;
  };
  const inFootprint = (l, mx, mz) => l.x >= min.x - mx && l.x <= max.x + mx && l.z >= min.z - mz && l.z <= max.z + mz;

  return {
    node,
    type,
    isStatic: ud.static !== false,
    box: local.clone().applyMatrix4(matrix),
    localBox: local,
    matrix,
    inverse,
    surfaceAt(x, z, radius = 0, normal = null) {
      const l = toLocal(_n.set(x, 0, z));
      if (!inFootprint(l, radius / sx, radius / sz)) return null;
      const lz = THREE.MathUtils.clamp(l.z, min.z, max.z);
      l.set(THREE.MathUtils.clamp(l.x, min.x, max.x), profile(lz), lz);
      if (normal) normal.copy(isRamp && lz > topZ ? slopeNormal : flatNormal);
      return l.applyMatrix4(matrix).y;
    },
    overlaps(pos, radius = 0) {
      return inFootprint(toLocal(pos), radius / sx, radius / sz);
    },
    pushOut(pos, radius = 0) {
      const l = toLocal(pos);
      const mx = radius / sx + 1e-4, mz = radius / sz + 1e-4;
      if (!inFootprint(l, mx, mz)) return false;
      const d = [min.x - mx - l.x, max.x + mx - l.x, min.z - mz - l.z, max.z + mz - l.z];
      let i = 0;
      for (let k = 1; k < 4; k++) if (Math.abs(d[k]) < Math.abs(d[i])) i = k;
      if (i < 2) l.x += d[i]; else l.z += d[i];
      l.applyMatrix4(matrix);
      pos.x = l.x;
      pos.z = l.z;
      return true;
    },
  };
}

/**
 * Upright capsule collider for characters (the editor's default for rigged models): cheap to test however detailed
 * the model is, and the same shape as the player, so people bump into each other instead of into a box around
 * outstretched arms. Its foot is at the base of the node's bounds, its radius comes from the model's thickness
 * (0.12 m at least, 18% of its height at most). Same interface as createCollider, plus:
 *   rayDistance(origin, dir, far) → distance along the ray to the capsule (approximated as a cylinder), or Infinity.
 */
export function createCapsuleCollider(node) {
  const matrix = node.matrixWorld.clone();
  const local = localBounds(node, matrix.clone().invert());
  const world = local.clone().applyMatrix4(matrix);
  const sx = new THREE.Vector3().setFromMatrixColumn(matrix, 0).length() || 1;
  const sz = new THREE.Vector3().setFromMatrixColumn(matrix, 2).length() || 1;
  const bottom = world.min.y, top = world.max.y, height = top - bottom;
  const thickness = Math.min((local.max.x - local.min.x) * sx, (local.max.z - local.min.z) * sz);
  const radius = Math.max(0.12, Math.min(0.18 * height, thickness / 2));
  const c = local.getCenter(new THREE.Vector3()).applyMatrix4(matrix);
  const cx = c.x, cz = c.z;
  const up = new THREE.Vector3(0, 1, 0);
  return {
    node,
    type: 'capsule',
    isStatic: node.userData.static !== false,
    box: new THREE.Box3(new THREE.Vector3(cx - radius, bottom, cz - radius), new THREE.Vector3(cx + radius, top, cz + radius)),
    center: new THREE.Vector3(cx, bottom, cz),
    matrix, // the node's world matrix it was built from (scripts.js rebuilds it when the node moves)
    radius,
    height,
    surfaceAt(x, z, r = 0, normal = null) {
      if (Math.hypot(x - cx, z - cz) > radius + r) return null;
      if (normal) normal.copy(up);
      return top;
    },
    overlaps(pos, r = 0) {
      return Math.hypot(pos.x - cx, pos.z - cz) < radius + r;
    },
    pushOut(pos, r = 0) {
      const dx = pos.x - cx, dz = pos.z - cz, d = Math.hypot(dx, dz), min = radius + r + 1e-4;
      if (d >= min) return false;
      if (d < 1e-6) { pos.x = cx + min; return true; }
      pos.x = cx + (dx / d) * min;
      pos.z = cz + (dz / d) * min;
      return true;
    },
    rayDistance(o, d, far = Infinity) {
      // circle in XZ, then the hit's height must be within the capsule
      const ox = o.x - cx, oz = o.z - cz, a = d.x * d.x + d.z * d.z, b = ox * d.x + oz * d.z, k = ox * ox + oz * oz - radius * radius;
      let t;
      if (k <= 0) t = 0; // starts inside
      else {
        if (a < 1e-9 || b > 0) return Infinity;
        const disc = b * b - a * k;
        if (disc < 0) return Infinity;
        t = (-b - Math.sqrt(disc)) / a;
      }
      const y = o.y + d.y * t;
      return t <= far && y >= bottom && y <= top ? t : Infinity;
    },
  };
}

/** Visit node and its descendants, skipping child map objects (and everything under them). */
function traverseOwn(node, fn) {
  fn(node);
  for (const c of node.children) if (!c.userData?.mapType) traverseOwn(c, fn);
}

/** Bounds of every mesh of the node itself (not its child objects), in node-local space. */
function localBounds(node, inverse) {
  const box = new THREE.Box3(), tmp = new THREE.Box3(), m = new THREE.Matrix4();
  traverseOwn(node, (o) => {
    if (!o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    m.multiplyMatrices(inverse, o.matrixWorld);
    box.union(tmp.copy(o.geometry.boundingBox).applyMatrix4(m));
  });
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  return box;
}

function findByOriginalName(root, name) {
  let found;
  root.traverse((n) => { if (!found && n.userData?.name === name) found = n; });
  return found;
}

/** Bilinear height sampler built from the exported terrain grid. Returns world-space Y. */
export function createHeightSampler(terrainMesh) {
  const { size, segments } = terrainMesh.userData;
  const pos = terrainMesh.geometry.attributes.position;
  const n = segments + 1;
  if (pos.count !== n * n) {
    console.warn('MapLoader: terrain vertex count does not match grid; falling back to raycasting');
    return createRaycastSampler(terrainMesh);
  }
  const H = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) H[i] = pos.getY(i);
  terrainMesh.updateWorldMatrix(true, false);
  const inv = terrainMesh.matrixWorld.clone().invert();
  const m = terrainMesh.matrixWorld;
  const v = new THREE.Vector3();
  const half = size / 2, step = size / segments;
  return (x, z) => {
    v.set(x, 0, z).applyMatrix4(inv);
    const gx = Math.min(Math.max((v.x + half) / step, 0), segments);
    const gz = Math.min(Math.max((v.z + half) / step, 0), segments);
    const x0 = Math.min(Math.floor(gx), segments - 1), z0 = Math.min(Math.floor(gz), segments - 1);
    const fx = gx - x0, fz = gz - z0;
    const a = H[z0 * n + x0] + (H[z0 * n + x0 + 1] - H[z0 * n + x0]) * fx;
    const b = H[(z0 + 1) * n + x0] + (H[(z0 + 1) * n + x0 + 1] - H[(z0 + 1) * n + x0]) * fx;
    v.y = a + (b - a) * fz;
    return v.applyMatrix4(m).y;
  };
}

function createRaycastSampler(mesh) {
  const rc = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  return (x, z) => {
    rc.set(new THREE.Vector3(x, 1e5, z), down);
    return rc.intersectObject(mesh, false)[0]?.point.y ?? 0;
  };
}

function createTrigger(node) {
  const p = node.userData.params ?? {};
  const size = new THREE.Vector3(p.width ?? 1, p.height ?? 1, p.depth ?? 1);
  const inv = new THREE.Matrix4();
  const local = new THREE.Vector3();
  return {
    node,
    name: node.userData.name ?? node.name,
    event: p.event ?? '',
    size,
    /** True if a world-space point is inside the (possibly rotated/scaled) volume. Base sits at node origin. */
    contains(point) {
      inv.copy(node.matrixWorld).invert();
      local.copy(point).applyMatrix4(inv);
      return Math.abs(local.x) <= size.x / 2 && Math.abs(local.z) <= size.z / 2 && local.y >= 0 && local.y <= size.y;
    },
  };
}

/** Recreate the editor's sky, fog and lights. Returns the created lights. */
export function applyEnvironment(scene, env, { renderer = null, shadowExtent = 100, lights = true } = {}) {
  if (!env) return {};
  scene.background = new THREE.Color(env.background);
  scene.fog = env.fog ? new THREE.Fog(env.background, env.fogNear, env.fogFar) : null;
  if (!lights) return {};
  const hemi = new THREE.HemisphereLight(env.skyColor, env.groundColor, env.ambientIntensity);
  const sun = new THREE.DirectionalLight(env.sunColor, env.sunIntensity);
  const az = THREE.MathUtils.degToRad(env.sunAzimuth), el = THREE.MathUtils.degToRad(env.sunElevation);
  sun.position.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).multiplyScalar(shadowExtent * 1.5);
  if (env.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    const c = sun.shadow.camera;
    c.left = c.bottom = -shadowExtent;
    c.right = c.top = shadowExtent;
    c.near = 1;
    c.far = shadowExtent * 4;
    c.updateProjectionMatrix();
    if (renderer) renderer.shadowMap.enabled = true;
  }
  scene.add(hemi, sun, sun.target);
  return { hemi, sun };
}
