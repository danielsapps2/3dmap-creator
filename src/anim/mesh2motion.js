// Mesh2Motion's human animation library (github.com/Mesh2Motion/mesh2motion-app, animations CC0) retargeted onto
// tinyimgen's skeleton, as starting points for library clips.
//
// Both skeletons have the same 52 joints (Unreal-style names there, Unity-style here) but different rest poses and
// bone axes. Each bone is retargeted in world space: its rotation away from the source's rest pose is applied to the
// target bone after lining the two rest poses up, using two directions per bone (along the bone, and a second axis:
// across the palm for hands and fingers, forward for arms, sideways for the rest), so an A-pose source drives a
// T-pose target and the hands keep their roll. Hips motion is carried over in hip heights.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BONES, PARENT, restPositions, restFrame } from './skeleton.js';
import { createClip, FPS, restArrays } from './clips.js';
import { idbGet, idbSet } from '../core/storage.js';

const COMMIT = '653a9698f5f315523072f1c3ff3496100401317b'; // pinned, so a pack can't change under saved clips
export const PACKS = [
  { id: 'human-base-animations', label: 'Base' },
  { id: 'human-addon-animations', label: 'Add-on' },
  { id: 'human-mocap-animations', label: 'Mocap' },
];
const packUrl = (id) => `https://raw.githubusercontent.com/Mesh2Motion/mesh2motion-app/${COMMIT}/static/animations/${id}.glb`;

/** tinyimgen bone -> Mesh2Motion bone. */
export const BONE_MAP = { Hips: 'pelvis', Spine: 'spine_01', Chest: 'spine_02', UpperChest: 'spine_03', Neck: 'neck_01', Head: 'head' };
for (const [side, s] of [['Left', 'l'], ['Right', 'r']]) {
  Object.assign(BONE_MAP, {
    [`${side}Shoulder`]: `clavicle_${s}`, [`${side}UpperArm`]: `upperarm_${s}`, [`${side}LowerArm`]: `lowerarm_${s}`,
    [`${side}Hand`]: `hand_${s}`, [`${side}UpperLeg`]: `thigh_${s}`, [`${side}LowerLeg`]: `calf_${s}`,
    [`${side}Foot`]: `foot_${s}`, [`${side}Toes`]: `ball_${s}`,
  });
  for (const [f, m] of [['Thumb', 'thumb'], ['Index', 'index'], ['Middle', 'middle'], ['Ring', 'ring'], ['Little', 'pinky']]) {
    ['Proximal', 'Intermediate', 'Distal'].forEach((p, k) => { BONE_MAP[`${side}${f}${p}`] = `${m}_0${k + 1}_${s}`; });
  }
}

/** Clips that are usually played on repeat (the rest play once). Only a default: the editor can change it. */
const LOOPING = /idle|walk|run|jog|sprint|crawl|swim|dance|climb|flying|glide|shiver|sleep|meditate|pushup|jumping jacks|levitate|driving|_air|reel|talking|carry/i;

const packs = new Map();

/** Load a pack (downloaded once, then kept in IndexedDB). Resolves { names: [clip names] }. */
export function loadPack(id) {
  if (!packs.has(id)) {
    const p = (async () => {
      const key = `mesh2motion:${COMMIT}:${id}`;
      let buffer = await idbGet(key).catch(() => null);
      if (!buffer) {
        const res = await fetch(packUrl(id));
        if (!res.ok) throw new Error(`Couldn't download ${id} from GitHub (HTTP ${res.status})`);
        buffer = await res.arrayBuffer();
        idbSet(key, buffer).catch(() => {});
      }
      const gltf = await new GLTFLoader().parseAsync(buffer, '');
      return new Source(gltf);
    })();
    p.catch(() => packs.delete(id)); // let a failed download be retried
    packs.set(id, p);
  }
  return packs.get(id);
}

class Source {
  constructor(gltf) {
    this.scene = gltf.scene;
    this.clips = gltf.animations;
    this.names = gltf.animations.map((c) => c.name);
    this.bones = {};
    this.scene.traverse((o) => { if (o.isBone) this.bones[o.userData?.name ?? o.name] = o; });
    const missing = Object.values(BONE_MAP).filter((n) => !this.bones[n]);
    if (missing.length) throw new Error(`Unexpected Mesh2Motion skeleton (missing ${missing.slice(0, 3).join(', ')})`);
    this.rest = [];
    this.scene.traverse((o) => this.rest.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  }

  restore() {
    for (const [o, p, q, s] of this.rest) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
    this.scene.updateMatrixWorld(true);
  }

  /** World position and rotation of every mapped bone in the current pose, turned to face +Z (see facing). */
  snapshot(turn) {
    this.scene.updateMatrixWorld(true);
    const pos = {}, rot = {};
    for (const [t, s] of Object.entries(BONE_MAP)) {
      const b = this.bones[s];
      pos[t] = b.getWorldPosition(new THREE.Vector3()).applyQuaternion(turn);
      rot[t] = turn.clone().multiply(b.getWorldQuaternion(new THREE.Quaternion()));
    }
    return { pos, rot };
  }
}

/**
 * Retarget one clip of a pack to tinyimgen's skeleton as a library clip (its motion becomes the clip's base).
 * rig: rigOf() of a tinyimgen character in its rest pose, whose joint positions define the target rest frames.
 */
export async function importMesh2Motion(packId, clipName, rig) {
  const src = await loadPack(packId);
  const anim = src.clips.find((c) => c.name === clipName);
  if (!anim) throw new Error(`"${clipName}" isn't in that pack`);

  // Target rest: every rotation identity (tinyimgen convention), so joint positions are sums of local offsets.
  const tpos = restPositions(rig);

  // Source rest, turned so the character faces +Z like tinyimgen's (the feet point forward).
  src.restore();
  const raw = src.snapshot(new THREE.Quaternion());
  const fwd = ['Left', 'Right'].reduce((v, s) => v.add(raw.pos[`${s}Toes`].clone().sub(raw.pos[`${s}Foot`])), new THREE.Vector3());
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-fwd.x, fwd.z));
  const rest = src.snapshot(turn);
  if (rest.pos.LeftShoulder.x < rest.pos.RightShoulder.x) console.warn('Mesh2Motion import: left/right look swapped');
  const srcHips = Math.max(rest.pos.Hips.y - Math.min(rest.pos.LeftToes.y, rest.pos.RightToes.y), 0.05);

  // align[b]: rotates the target's rest frame onto the source's, both in the same world
  const align = {}, restInv = {};
  for (const b of BONES) {
    align[b] = restFrame(b, rest.pos).multiply(restFrame(b, tpos).invert());
    restInv[b] = rest.rot[b].clone().invert();
  }

  const mixer = new THREE.AnimationMixer(src.scene);
  const action = mixer.clipAction(anim);
  action.play();
  const duration = anim.duration;
  const frames = Math.max(2, Math.round(duration * FPS) + 1);
  const rot = Object.fromEntries(BONES.map((b) => [b, new Float32Array(frames * 4)]));
  const hips = new Float32Array(frames * 3);
  const world = {}, q = new THREE.Quaternion(), v = new THREE.Vector3();
  try {
    for (let i = 0; i < frames; i++) {
      mixer.setTime(Math.min(i / FPS, duration));
      const pose = src.snapshot(turn);
      for (const b of BONES) {
        // world rotation of the target bone: the source bone's change from rest, applied to the aligned rest frame
        world[b] = pose.rot[b].clone().multiply(restInv[b]).multiply(align[b]);
        const parent = PARENT[b];
        q.copy(parent ? world[parent] : new THREE.Quaternion()).invert().multiply(world[b]);
        if (i && q.x * rot[b][i * 4 - 4] + q.y * rot[b][i * 4 - 3] + q.z * rot[b][i * 4 - 2] + q.w * rot[b][i * 4 - 1] < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        q.toArray(rot[b], i * 4);
      }
      v.copy(pose.pos.Hips).sub(rest.pos.Hips).divideScalar(srcHips).toArray(hips, i * 3);
    }
  } finally {
    action.stop();
    mixer.uncacheRoot(src.scene);
    src.restore();
  }
  return createClip({
    name: clipName.replace(/_/g, ' '), duration, loop: LOOPING.test(clipName), source: `mesh2motion:${packId}/${clipName}`,
    base: { fps: FPS, frames, rot, hips },
    rest: restArrays(tpos), // made for this skeleton: other characters get it retargeted (clips.js)
  });
}
