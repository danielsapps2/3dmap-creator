import * as THREE from 'three';

/**
 * Markers are gameplay objects (spawn points, triggers, lights). Their visuals live in a child
 * group flagged `userData.editorOnly` which is stripped on export.
 */
export const MARKERS = {
  spawn: {
    label: 'Player Spawn', icon: '⚑', color: '#3ddc84',
    params: [{ key: 'team', label: 'Team / ID', type: 'text', default: 'player' }],
  },
  waypoint: {
    label: 'Waypoint', icon: '◆', color: '#ffcc33',
    params: [{ key: 'radius', label: 'Radius', default: 1, min: 0.1, max: 100, step: 0.1 }],
  },
  trigger: {
    label: 'Trigger Volume', icon: '⬚', color: '#ff5577',
    params: [
      { key: 'width', label: 'Width', default: 4, min: 0.1, max: 1000, step: 0.1 },
      { key: 'height', label: 'Height', default: 3, min: 0.1, max: 1000, step: 0.1 },
      { key: 'depth', label: 'Depth', default: 4, min: 0.1, max: 1000, step: 0.1 },
      { key: 'event', label: 'Event name', type: 'text', default: '' },
    ],
  },
  pointLight: {
    label: 'Point Light', icon: '✹', color: '#ffd27a',
    params: [
      { key: 'color', label: 'Color', type: 'color', default: '#ffd9a0' },
      { key: 'intensity', label: 'Intensity', default: 40, min: 0, max: 5000, step: 1 },
      { key: 'distance', label: 'Range', default: 25, min: 0, max: 1000, step: 0.5 },
      { key: 'decay', label: 'Decay', default: 2, min: 0, max: 4, step: 0.1 },
      { key: 'castShadow', label: 'Cast shadow', type: 'bool', default: false },
    ],
  },
};

export function markerDefaults(type) {
  return Object.fromEntries(MARKERS[type].params.map((p) => [p.key, p.default]));
}

export function buildMarker(type) {
  const obj = type === 'pointLight' ? new THREE.PointLight() : new THREE.Object3D();
  if (obj.isPointLight) obj.shadow.bias = -0.002;
  const helper = new THREE.Group();
  helper.name = '__helper';
  helper.userData.editorOnly = true;
  obj.add(helper);
  return obj;
}

const helperMat = (color, opacity = 0.65) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, fog: false });

export function refreshMarker(obj, type, params) {
  const helper = obj.children.find((c) => c.name === '__helper');
  for (const c of [...helper.children]) {
    c.geometry?.dispose();
    c.material?.dispose();
    helper.remove(c);
  }
  const color = MARKERS[type].color;

  switch (type) {
    case 'spawn': {
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.1, 4, 12), helperMat(color, 0.45));
      body.position.y = 0.9;
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 12).rotateX(-Math.PI / 2), helperMat(color, 0.9));
      arrow.position.set(0, 1.45, -0.55);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 32).rotateX(-Math.PI / 2), helperMat(color, 0.8));
      ring.position.y = 0.03;
      helper.add(body, arrow, ring);
      break;
    }
    case 'waypoint': {
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.35), helperMat(color, 0.9));
      gem.position.y = 0.6;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(Math.max(params.radius - 0.08, 0.01), params.radius, 48).rotateX(-Math.PI / 2),
        helperMat(color, 0.7),
      );
      ring.position.y = 0.03;
      helper.add(gem, ring);
      break;
    }
    case 'trigger': {
      const geo = new THREE.BoxGeometry(params.width, params.height, params.depth).translate(0, params.height / 2, 0);
      const vol = new THREE.Mesh(geo, helperMat(color, 0.12));
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, fog: false }));
      helper.add(vol, edges);
      break;
    }
    case 'pointLight': {
      obj.color.set(params.color);
      obj.intensity = params.intensity;
      obj.distance = params.distance;
      obj.decay = params.decay;
      obj.castShadow = !!params.castShadow;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 12), helperMat(params.color, 1));
      const range = new THREE.Mesh(
        new THREE.SphereGeometry(1, 24, 12),
        new THREE.MeshBasicMaterial({ color: params.color, wireframe: true, transparent: true, opacity: 0.08, depthWrite: false, fog: false }),
      );
      range.scale.setScalar(Math.max(params.distance, 0.01));
      range.raycast = () => {}; // don't pick the range sphere
      range.userData.noBounds = true;
      helper.add(bulb, range);
      break;
    }
  }
}
