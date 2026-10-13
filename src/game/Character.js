// Playable characters for the third-person playtest: rigged tinyimgen models, any GLB, or a plain capsule.
//
// Every character exposes the same animator interface as tinyimgen's Locomotion:
//   update(dt, input, running) -> local velocity { x: left, z: forward, speed } in m/s
// so movement speed always comes from the animation (feet stay planted) and the game only adds physics.
//
// A tinyimgen character has no animation of its own here: the player controller script picks library clips for
// idle, walk, run, backwards and strafing (useLocomotion, from game.player.locomotion). Other GLBs play their own
// Idle / Walk / Run clips by name, since library clips only fit tinyimgen's skeleton.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { fetchTinyimgen } from '../core/tinyimgen.js';
import { fetchEngineModel } from '../core/engine.js';
import { heldProp, poseHeld, findNamed } from '../runtime/hold.js';
import { rigOf, sampleLocal, hipsOffset } from '../anim/clips.js';
import { clipLocomotion, locomotionClipNames } from '../runtime/clipLocomotion.js';

const DEFAULT_HEIGHT = 1.8;
const ACTION_FADE = 0.2; // s to blend into and out of a library clip
const STILL = { x: 0, z: 0 };
const _q = new THREE.Quaternion(), _v = new THREE.Vector3();

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
 * spec: { kind: 'capsule' } | { kind: 'engine', file, name } | { kind: 'tinyimgen', id, name, url } | { kind: 'file', name, buffer }
 * clips: the animation library (anim/clips.js). A tinyimgen character walks with the clips the player controller
 * picks from it (useLocomotion); the library's other clips are actions (playAction) that scripts play (player.playClip).
 * Returns a Character whose `root` has its feet at the origin, facing +Z.
 */
export async function loadCharacter(spec, renderer, { clips = null } = {}) {
  if (spec.kind === 'capsule') return new Character(makeCapsule(), new SimpleAnimator(), { name: 'Capsule', kind: 'capsule' });
  let buffer = spec.buffer;
  if (spec.kind === 'engine') buffer = await fetchEngineModel(spec.file); // a character in the engine's models
  else if (spec.kind === 'tinyimgen') buffer = await fetchTinyimgen(spec.url);
  const gltf = await getLoader(renderer).parseAsync(buffer, '');
  const model = gltf.scene;
  model.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = o.receiveShadow = true;
      if (o.isSkinnedMesh) o.frustumCulled = false; // bind-pose bounds don't follow the animation
    }
  });
  const rig = rigOf(model); // a tinyimgen skeleton (read before anything poses it), or null
  const scale = normalize(model);
  let animator = null, kind = 'rig'; // a tinyimgen character waits for the controller's clips
  if (!rig) {
    animator = new SimpleAnimator(gltf.animations, model);
    kind = gltf.animations.length ? 'clips' : 'static';
  }
  const character = new Character(model, animator, { name: spec.name, kind, speedScale: scale });
  if (rig) {
    character.rig = rig;
    character.library = clips ?? [];
    character.actions = character.library;
  }
  return character;
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
    this.kind = kind; // 'locomotion' (clips picked) | 'rig' (none yet) | 'clips' | 'static' | 'capsule'
    this.speedScale = speedScale;
    this.height = new THREE.Box3().setFromObject(this.root).getSize(new THREE.Vector3()).y || DEFAULT_HEIGHT;
    this.rig = null;        // tinyimgen skeleton (anim/clips.js rigOf), when library clips apply
    this.library = [];      // the animation library's clips
    this.states = null;     // the clip per movement state, once the controller picked them ({ idle, walk, … })
    this.actions = [];      // library clips scripts can play (playAction)
    this.acting = null;     // the action playing: { clip, time, weight, ending }
    this.unanimated = false; // a tinyimgen character was asked to move before the controller picked its clips
    this.speeds = null;     // { walk, run } in m/s, when the controller sets them (setSpeeds)
    this.settings = {};     // player controller fields this character plays with (its model meta's `controller`)
  }

  /**
   * Move at these speeds (m/s; walk also sets walking backwards and strafing, in proportion) instead of the clips'
   * own. The walk and run clips play faster or slower to match: same stride, quicker or slower steps, so the feet
   * stay planted. Null or 0 keeps a clip's own speed.
   */
  setSpeeds({ walk = 0, run = 0 } = {}) {
    this.speeds = { walk, run };
    const a = this.animator;
    if (!a) return;
    if (!a.setRate) { // other GLBs and the capsule: their game-feel speeds
      if (walk > 0) a.walk = walk / this.speedScale;
      if (run > 0) a.run = run / this.speedScale;
      return;
    }
    const rate = (name, target) => {
      const c = a.clips[name];
      if (c?.speed > 0) a.setRate(name, target > 0 ? c.baked * (target / this.speedScale) / c.speed : c.baked);
    };
    const k = walk > 0 && a.clips.Walk?.speed > 0 ? walk / this.speedScale / a.clips.Walk.speed : 0;
    rate('Walk', walk);
    for (const name of ['WalkBackward', 'StrafeLeft', 'StrafeRight']) {
      const c = a.clips[name];
      if (c?.speed > 0) a.setRate(name, c.baked * (k || 1));
    }
    rate('Run', run);
  }

  /**
   * Walk with library clips: states { idle, walk, run, back, left, right } name a clip each (idle and walk needed).
   * rates { idle, walk, … } play a state's clip faster or slower (× 1; see clipLocomotion). The rest of the library
   * can be played as actions (playAction). Other characters keep their own clips; returns the animator.
   */
  useLocomotion(states, rates) {
    if (!this.rig) return this.animator;
    const next = clipLocomotion(this.model, this.rig, this.library, states, { rates });
    this.animator?.mixer?.stopAllAction();
    this.animator = next;
    this.kind = 'locomotion';
    this.states = { ...states };
    this.unanimated = false;
    if (this.speeds) this.setSpeeds(this.speeds); // new clips, same speeds
    const used = new Set(locomotionClipNames(states));
    this.actions = this.library.filter((c) => !used.has(c.name));
    return next;
  }

  /**
   * Play action i (a library clip) over the locomotion: the character stands still while it plays. A one-shot
   * clip fades out at its end; a looping one plays until the character moves or the same key is pressed again.
   * Returns the clip, or null if there's none on that key.
   */
  playAction(i) {
    const clip = this.actions[i];
    if (!clip) return null;
    if (this.acting?.clip === clip && !this.acting.ending) this.acting.ending = true;
    else this.acting = { clip, time: 0, weight: this.acting?.weight ?? 0, ending: false };
    return clip;
  }

  _blendAction(dt) {
    const a = this.acting;
    a.time += dt;
    if (!a.clip.loop && a.time >= a.clip.duration - ACTION_FADE) a.ending = true;
    a.weight = THREE.MathUtils.clamp(a.weight + (a.ending ? -dt : dt) / ACTION_FADE, 0, 1);
    if (a.ending && a.weight <= 0) { this.acting = null; return; }
    const t = a.clip.loop ? a.time % a.clip.duration : Math.min(a.time, a.clip.duration);
    const pose = sampleLocal(a.clip, t, this.rig, (this._pose ??= {})); // fitted to this character's skeleton
    for (const [name, bone] of Object.entries(this.rig.bones)) bone.quaternion.slerp(pose[name], a.weight);
    hipsOffset(a.clip, t, _v).multiplyScalar(this.rig.hipsHeight).add(this.rig.restHips);
    this.rig.bones.Hips.position.lerp(_v, a.weight);
  }

  /** Resize to a height in metres (the model's height in the editor). Animation speed scales along with it. */
  setHeight(height) {
    if (!(height > 0)) return;
    const k = height / this.height;
    this.root.scale.multiplyScalar(k);
    this.height = height;
    this.speedScale *= k;
    if (this.speeds) this.setSpeeds(this.speeds); // set speeds are in m/s, whatever the size
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
    const act = this.acting;
    if (act?.clip.loop && !act.ending && (input.x || input.z)) act.ending = true; // walking off ends a looping clip
    let v = STILL;
    if (this.animator) v = this.animator.update(dt, act && !act.ending ? STILL : input, running);
    else this.unanimated = true; // stands in its rest pose: nothing to walk with
    if (this.acting) this._blendAction(dt);
    // carry poses are in character heights, measured in the model's own units; during an action the clip has the arms
    const arms = !this.acting || this.acting.weight < 0.5;
    for (const held of this.held) poseHeld(this.model, held, this.height / this.speedScale, { arms });
    return { x: v.x * this.speedScale, z: v.z * this.speedScale, speed: (v.speed ?? 0) * this.speedScale };
  }

  dispose() {
    this.animator?.mixer?.stopAllAction();
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
