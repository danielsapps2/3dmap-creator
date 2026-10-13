// tinyimgen's humanoid skeleton (tools3d/rig.py): 22 body joints plus 15 finger joints per hand, Unity/Godot
// humanoid names. Every joint's rest rotation is identity and the Armature is unrotated, but the joints sit where
// each character's mesh put them, so bones point a little differently from one character to the next (arms held
// lower, wider hips…). A clip keeps the joint positions of the character it was made on (its `rest`), and plays on
// another character through restAlign(): each bone's rest direction lined up with the other's.
import * as THREE from 'three';

export const BODY = [
  'Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head',
  'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand',
  'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes',
];
export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
export const PHALANX = ['Proximal', 'Intermediate', 'Distal'];
export const BONES = [...BODY];
for (const side of ['Left', 'Right']) for (const f of FINGERS) for (const p of PHALANX) BONES.push(`${side}${f}${p}`);

/** The joint each bone points toward (its primary direction), for retargeting. Leaf bones reuse their parent's. */
export function childOf(bone) {
  const m = /^(Left|Right)(Thumb|Index|Middle|Ring|Little)(Proximal|Intermediate|Distal)$/.exec(bone);
  if (m) return m[3] === 'Distal' ? null : `${m[1]}${m[2]}${PHALANX[PHALANX.indexOf(m[3]) + 1]}`;
  const next = {
    Hips: 'Spine', Spine: 'Chest', Chest: 'UpperChest', UpperChest: 'Neck', Neck: 'Head', Head: null,
    Shoulder: 'UpperArm', UpperArm: 'LowerArm', LowerArm: 'Hand', Hand: 'MiddleProximal',
    UpperLeg: 'LowerLeg', LowerLeg: 'Foot', Foot: 'Toes', Toes: null,
  };
  const s = /^(Left|Right)(.*)$/.exec(bone);
  if (s) return next[s[2]] ? s[1] + next[s[2]] : null;
  return next[bone] ?? null;
}

export const PARENT = {
  Hips: null, Spine: 'Hips', Chest: 'Spine', UpperChest: 'Chest', Neck: 'UpperChest', Head: 'Neck',
};
for (const side of ['Left', 'Right']) {
  Object.assign(PARENT, {
    [`${side}Shoulder`]: 'UpperChest', [`${side}UpperArm`]: `${side}Shoulder`, [`${side}LowerArm`]: `${side}UpperArm`,
    [`${side}Hand`]: `${side}LowerArm`, [`${side}UpperLeg`]: 'Hips', [`${side}LowerLeg`]: `${side}UpperLeg`,
    [`${side}Foot`]: `${side}LowerLeg`, [`${side}Toes`]: `${side}Foot`,
  });
  for (const f of FINGERS) PHALANX.forEach((p, k) => { PARENT[`${side}${f}${p}`] = k ? `${side}${f}${PHALANX[k - 1]}` : `${side}Hand`; });
}

/** The same bone on the other side ("LeftHand" <-> "RightHand"); centre bones map to themselves. */
export const mirrorName = (bone) => bone.replace(/^(Left|Right)/, (s) => (s === 'Left' ? 'Right' : 'Left'));

/** Bone name as written in the file (GLTFLoader keeps the original in userData.name when it renames duplicates). */
const nameOf = (o) => o.userData?.name ?? o.name;

/** { boneName: Bone } of a model's tinyimgen skeleton, or null when it isn't one. */
export function findBones(root) {
  const bones = {};
  root.traverse((o) => { if (o.isBone && BONES.includes(nameOf(o)) && !bones[nameOf(o)]) bones[nameOf(o)] = o; });
  return bones.Hips && bones.LeftUpperArm && bones.RightHand && bones.LeftFoot ? bones : null;
}

export const isTinyimgenRig = (root) => !!findBones(root);

/** Joint positions of a rig in its rest pose ({ bone: Vector3 }, Armature space): rest rotations are identity, so
 * they're sums of the bones' local offsets (only the Hips move in a clip, so its rest position comes from the rig). */
export function restPositions(rig) {
  const pos = {};
  for (const b of BONES) {
    const bone = rig.bones[b];
    if (!bone) continue;
    pos[b] = b === 'Hips' ? rig.restHips.clone() : (pos[PARENT[b]] ?? new THREE.Vector3()).clone().add(bone.position);
  }
  return pos;
}

const AXIS_X = new THREE.Vector3(1, 0, 0), AXIS_Z = new THREE.Vector3(0, 0, 1);

/**
 * Rest frame of a bone from joint positions ({ bone: Vector3 }): x along the bone, z a second axis (across the palm
 * for hands and fingers, forward for arms, sideways for the rest), as a world rotation.
 */
export function restFrame(bone, pos) {
  const child = childOf(bone);
  const along = child && pos[child] ? pos[child].clone().sub(pos[bone]) : pos[bone].clone().sub(pos[PARENT[bone]] ?? new THREE.Vector3());
  const side = /^(Left|Right)/.exec(bone)?.[1];
  let second;
  if (side && /(Hand|Thumb|Index|Middle|Ring|Little)/.test(bone)) {
    const across = pos[`${side}IndexProximal`].clone().sub(pos[`${side}LittleProximal`]);
    if (/Thumb/.test(bone)) {
      const hand = pos[`${side}MiddleProximal`].clone().sub(pos[`${side}Hand`]);
      second = hand.cross(across); // the palm's normal: the thumb lies roughly along the across-palm line
    } else {
      second = across;
    }
  } else if (side && /(Shoulder|UpperArm|LowerArm)/.test(bone)) {
    second = AXIS_Z.clone();
  } else {
    second = AXIS_X.clone();
  }
  const x = along.normalize();
  const z = second.addScaledVector(x, -second.dot(x)).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/**
 * Per bone, the world rotation that turns the `to` skeleton's rest frame onto the `from` skeleton's (both
 * { bone: Vector3 }): a pose made on `from` plays on `to` as world = poseWorld * align. Identity when they match.
 */
export function restAlign(from, to) {
  const align = {};
  for (const b of BONES) if (from[b] && to[b]) align[b] = restFrame(b, from).multiply(restFrame(b, to).invert());
  return align;
}
