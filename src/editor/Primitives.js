import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const num = (key, label, def, min = 0.01, max = 1000, step = 0.1) => ({ key, label, default: def, min, max, step });
const int = (key, label, def, min, max) => ({ key, label, default: def, min, max, step: 1, int: true });

/**
 * All primitives are built with their base resting on y = 0 so they sit on whatever they are placed on.
 * Defaults use whole 2 m footprints/heights so they line up with the default cube on a 1 m grid.
 */
export const PRIMITIVES = {
  box: { label: 'Box', icon: '■', params: [num('width', 'Width', 2), num('height', 'Height', 2), num('depth', 'Depth', 2)] },
  sphere: { label: 'Sphere', icon: '●', params: [num('radius', 'Radius', 1), int('widthSegments', 'Segments W', 32, 3, 128), int('heightSegments', 'Segments H', 16, 2, 64)] },
  cylinder: { label: 'Cylinder', icon: '▮', params: [num('radiusTop', 'Radius top', 1, 0), num('radiusBottom', 'Radius bottom', 1, 0), num('height', 'Height', 2), int('radialSegments', 'Segments', 24, 3, 128)] },
  cone: { label: 'Cone', icon: '▲', params: [num('radius', 'Radius', 1), num('height', 'Height', 2), int('radialSegments', 'Segments', 24, 3, 128)] },
  pyramid: { label: 'Pyramid', icon: '◭', params: [num('radius', 'Radius', Math.SQRT2), num('height', 'Height', 2), int('sides', 'Sides', 4, 3, 12)] },
  torus: { label: 'Torus', icon: '◯', params: [num('radius', 'Radius', 0.75), num('tube', 'Tube', 0.25), int('radialSegments', 'Segments', 16, 3, 64), int('tubularSegments', 'Tubular', 48, 3, 200)] },
  capsule: { label: 'Capsule', icon: '⬭', params: [num('radius', 'Radius', 0.5), num('length', 'Length', 1, 0), int('capSegments', 'Cap segs', 6, 1, 32), int('radialSegments', 'Segments', 16, 3, 64)] },
  plane: { label: 'Plane', icon: '▭', params: [num('width', 'Width', 4), num('depth', 'Depth', 4)] },
  ramp: { label: 'Ramp', icon: '◢', params: [num('width', 'Width', 2), num('height', 'Height', 2), num('depth', 'Depth', 4)] },
  stairs: { label: 'Stairs', icon: '⌸', params: [num('width', 'Width', 2), num('height', 'Height', 2), num('depth', 'Depth', 4), int('steps', 'Steps', 8, 1, 64)] },
};

export function primitiveDefaults(type) {
  return Object.fromEntries(PRIMITIVES[type].params.map((p) => [p.key, p.default]));
}

export function buildPrimitiveGeometry(type, p) {
  let g;
  switch (type) {
    case 'box':
      g = new THREE.BoxGeometry(p.width, p.height, p.depth).translate(0, p.height / 2, 0);
      break;
    case 'sphere':
      g = new THREE.SphereGeometry(p.radius, p.widthSegments, p.heightSegments).translate(0, p.radius, 0);
      break;
    case 'cylinder':
      g = new THREE.CylinderGeometry(p.radiusTop, p.radiusBottom, p.height, p.radialSegments).translate(0, p.height / 2, 0);
      break;
    case 'cone':
      g = new THREE.ConeGeometry(p.radius, p.height, p.radialSegments).translate(0, p.height / 2, 0);
      break;
    case 'pyramid': {
      const cone = new THREE.ConeGeometry(p.radius, p.height, p.sides, 1)
        .rotateY(p.sides === 4 ? Math.PI / 4 : 0)
        .translate(0, p.height / 2, 0);
      g = cone.toNonIndexed();
      cone.dispose();
      g.computeVertexNormals();
      break;
    }
    case 'torus':
      g = new THREE.TorusGeometry(p.radius, p.tube, p.radialSegments, p.tubularSegments)
        .rotateX(Math.PI / 2)
        .translate(0, p.tube, 0);
      break;
    case 'capsule':
      g = new THREE.CapsuleGeometry(p.radius, p.length, p.capSegments, p.radialSegments).translate(0, p.length / 2 + p.radius, 0);
      break;
    case 'plane':
      g = new THREE.PlaneGeometry(p.width, p.depth).rotateX(-Math.PI / 2);
      break;
    case 'ramp':
      g = rampGeometry(p.width, p.height, p.depth);
      break;
    case 'stairs':
      g = stairsGeometry(p.width, p.height, p.depth, p.steps);
      break;
    default:
      throw new Error(`Unknown primitive "${type}"`);
  }
  return g;
}

/** Wedge rising toward -Z. */
function rampGeometry(w, h, d) {
  const x = w / 2, z = d / 2;
  const A = [-x, 0, z], B = [x, 0, z], C = [x, 0, -z], D = [-x, 0, -z], E = [-x, h, -z], F = [x, h, -z];
  const tris = [
    [A, D, C], [A, C, B], // bottom
    [D, E, F], [D, F, C], // back
    [A, B, F], [A, F, E], // slope
    [A, E, D], // left
    [B, C, F], // right
  ];
  const uvs = [
    [0, 1, 0, 0, 1, 0], [0, 1, 1, 0, 1, 1],
    [0, 0, 0, 1, 1, 1], [0, 0, 1, 1, 1, 0],
    [0, 0, 1, 0, 1, 1], [0, 0, 1, 1, 0, 1],
    [1, 0, 0, 1, 0, 0],
    [0, 0, 1, 0, 1, 1],
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(2), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs.flat(), 2));
  g.computeVertexNormals();
  return g;
}

/** Staircase rising toward -Z. */
function stairsGeometry(w, h, d, steps) {
  const parts = [];
  const sd = d / steps;
  for (let i = 0; i < steps; i++) {
    const sh = (h * (i + 1)) / steps;
    parts.push(new THREE.BoxGeometry(w, sh, sd).translate(0, sh / 2, d / 2 - (i + 0.5) * sd));
  }
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return g;
}
