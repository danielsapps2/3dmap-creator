// Playable characters for the third-person playtest: rigged tinyimgen models, any GLB, or a plain capsule.
//
// Every character exposes the same animator interface as tinyimgen's Locomotion:
//   update(dt, input, running) -> local velocity { x: left, z: forward, speed } in m/s
// so movement speed always comes from the animation (feet stay planted) and the game only adds physics.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Locomotion } from './locomotion.js';
import { fetchTinyimgen } from '../core/tinyimgen.js';
import { heldProp, poseHeld, findNamed } from '../runtime/hold.js';

const DEFAULT_HEIGHT = 1.8;

let loader = null;
function getLoader(renderer) {
  if (!loader) {
    const base = import.meta.env.BASE_URL;
    loader = new GLTFLoader()
      .setDRACOLoader(new DRACOLoader().setDecoderPath(`${base}draco/`))
      .setKTX2Loader(new KTX2Loader().setTranscoderPath(`${base}basis/`).detectSupport(renderer))
      .setMeshoptDecoder(MeshoptDecoder);
  }
  return loader;
}

/**
 * spec: { kind: 'capsule' } | { kind: 'tinyimgen', id, name, url } | { kind: 'file', name, buffer }
 * Returns a Character whose `root` has its feet at the origin, facing +Z.
 */
export async function loadCharacter(spec, renderer) {
  if (spec.kind === 'capsule') return new Character(makeCapsule(), new SimpleAnimator(), { name: 'Capsule', kind: 'capsule' });
  let buffer = spec.buffer;
  if (spec.kind === 'tinyimgen') {
    buffer = await fetchTinyimgen(spec.url);
  }
  const gltf = await getLoader(renderer).parseAsync(buffer, '');
  const model = gltf.scene;
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = o.receiveShadow = true;
      if (o.isSkinnedMesh) o.frustumCulled = false; // bind-pose bounds don't follow the animation
    }
  });
  const scale = normalize(model);
  let animator, kind;
  try {
    animator = new Locomotion(gltf); // tinyimgen rig: mocap clips with speed/stride extras
    kind = 'locomotion';
  } catch {
    animator = new SimpleAnimator(gltf.animations, model);
    kind = gltf.animations.length ? 'clips' : 'static';
  }
  return new Character(model, animator, { name: spec.name, kind, speedScale: scale });
}

/** Feet at y = 0, centered on X/Z; rescale models that are clearly not in meters. Returns the scale applied. */
function normalize(model) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const h = box.max.y - box.min.y;
  const scale = h > 0.3 && h < 5 ? 1 : DEFAULT_HEIGHT / (h || DEFAULT_HEIGHT);
  if (scale !== 1) {
    model.scale.multiplyScalar(scale);
    model.updateMatrixWorld(true);
    box.setFromObject(model);
  }
  const c = box.getCenter(new THREE.Vector3());
  model.position.x -= c.x;
  model.position.z -= c.z;
  model.position.y -= box.min.y;
  return scale;
}

function makeCapsule() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.2, 6, 16), new THREE.MeshStandardMaterial({ color: 0x4f86e8, roughness: 0.6 }));
  body.position.y = 0.9;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, 0.12), new THREE.MeshStandardMaterial({ color: 0x1b2230, roughness: 0.3 }));
  visor.position.set(0, 1.5, 0.26); // shows which way it faces (+Z)
  g.add(body, visor);
  g.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  return g;
}

export class Character {
  constructor(model, animator, { name, kind, speedScale = 1 }) {
    this.root = new THREE.Group();
    this.root.name = `Character: ${name}`;
    this.root.add(model);
    this.model = model;
    this.held = [];             // props in its hands (hold.js), posed after every animation update
    this.borrowed = new Set();  // meshes copied from the map: their geometry/materials belong to the map
    this.animator = animator;
    this.name = name;
    this.kind = kind; // 'locomotion' | 'clips' | 'static' | 'capsule'
    this.speedScale = speedScale;
    this.height = new THREE.Box3().setFromObject(this.root).getSize(new THREE.Vector3()).y || DEFAULT_HEIGHT;
  }

  /** Resize to a height in metres (the model's height in the editor). Animation speed scales along with it. */
  setHeight(height) {
    if (!(height > 0)) return;
    const k = height / this.height;
    this.root.scale.multiplyScalar(k);
    this.height = height;
    this.speedScale *= k;
  }

  /**
   * Hold copies of map objects (what the character holds in the editor): each node goes under the bone named by its
   * `userData.attachedTo` (e.g. "RightHand_Socket"), or under the root, with the same local transform. Props in a
   * hand socket get their grip pose (finger curls, support hand, carry pose) every frame.
   */
  equip(nodes) {
    for (const node of nodes) {
      const bone = node.userData.attachedTo ? findNamed(this.model, node.userData.attachedTo) : null;
      const copy = node.clone();
      copy.visible = true;
      copy.traverse((o) => { if (o.isMesh) { this.borrowed.add(o); o.castShadow = true; } });
      (bone ?? this.root).add(copy);
      const held = bone && heldProp(copy, bone, node.userData.grip);
      if (held) this.held.push(held);
    }
  }

  /** input: { x: left(+)/right(-), z: forward(+)/back(-) }. Returns local velocity in m/s. */
  update(dt, input, running) {
    const v = this.animator.update(dt, input, running);
    // carry poses are in character heights, measured in the model's own units
    for (const held of this.held) poseHeld(this.model, held, this.height / this.speedScale);
    return { x: v.x * this.speedScale, z: v.z * this.speedScale, speed: v.speed * this.speedScale };
  }

  dispose() {
    this.animator.mixer?.stopAllAction();
    this.root.traverse((o) => {
      if (!o.isMesh || this.borrowed.has(o)) return;
      o.geometry.dispose();
      for (const m of [o.material].flat()) {
        for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
        m.dispose();
      }
    });
  }
}

/**
 * Fallback for GLBs without tinyimgen's clip extras: picks Idle / Walk / Run clips by name and crossfades them by
 * speed. Speeds are game-feel defaults since the clips don't say how fast they move.
 */
export class SimpleAnimator {
  constructor(clips = [], root = null, { walk = 2.2, run = 5.5, accel = 8 } = {}) {
    this.walk = walk;
    this.run = run;
    this.accel = accel;
    this.velocity = new THREE.Vector2();
    this.weights = {};
    this.mixer = clips.length ? new THREE.AnimationMixer(root) : null;
    const find = (re, not) => clips.find((c) => re.test(c.name) && !(not && not.test(c.name)));
    const pick = { Idle: find(/idle|stand|breath/i), Walk: find(/walk/i, /back/i), Run: find(/run|jog|sprint/i) };
    if (this.mixer && !pick.Idle && !pick.Walk && !pick.Run) pick.Idle = clips[0]; // at least play something
    this.actions = {};
    for (const [k, clip] of Object.entries(pick)) {
      if (!clip) continue;
      const a = this.mixer.clipAction(clip);
      a.play();
      a.setEffectiveWeight(0);
      this.actions[k] = a;
    }
  }

  update(dt, input = { x: 0, z: 0 }, running = false) {
    const mag = Math.min(1, Math.hypot(input.x, input.z));
    const target = new THREE.Vector2();
    if (mag > 1e-3) {
      const dx = input.x / Math.hypot(input.x, input.z), dz = input.z / Math.hypot(input.x, input.z);
      const top = (running && dz > 0 ? this.run : this.walk) * (dz < 0 ? 0.7 : 1) * (1 - 0.3 * Math.abs(dx));
      target.set(dx, dz).multiplyScalar(top * mag);
    }
    this.velocity.lerp(target, 1 - Math.exp(-this.accel * dt));
    const s = this.velocity.length();

    if (this.mixer) {
      const { Idle, Walk, Run } = this.actions;
      const runT = Run ? THREE.MathUtils.clamp((s - this.walk) / (this.run - this.walk), 0, 1) : 0;
      const move = THREE.MathUtils.clamp(s / (0.25 * this.walk), 0, 1);
      const w = { Idle: Idle ? 1 - move : 0, Walk: Walk ? move * (1 - runT) : 0, Run: Run ? move * runT : 0 };
      if (!Walk && Run) w.Run = move; // only a run clip: use it for all movement
      if (!Idle) { const sum = w.Walk + w.Run; if (sum > 0) { w.Walk /= sum; w.Run /= sum; } }
      for (const [k, a] of Object.entries(this.actions)) {
        a.setEffectiveWeight(w[k]);
        if (k !== 'Idle') a.timeScale = THREE.MathUtils.clamp(s / (k === 'Run' ? this.run : this.walk), 0.5, 2);
      }
      this.weights = w;
      this.mixer.update(dt);
    }
    return { x: this.velocity.x, z: this.velocity.y, speed: s };
  }
}
