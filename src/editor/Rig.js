import * as THREE from 'three';
import { assetModel, childEntities, findOwn, traverseOwn } from './Entities.js';
import { HAND_SOCKET, heldProp, poseHeld } from '../runtime/hold.js';

/**
 * Rigged models (characters) and the props they hold. A prop is held by making it a child entity of the
 * character attached to a hand socket ("RightHand_Socket" / "LeftHand_Socket", from tinyimgen's rig), with its
 * Grip_Primary node on the socket (see gripTransform).
 */

export const isHandSocket = (name) => HAND_SOCKET.test(name ?? '');
export const socketForHand = (hand) => `${hand === 'Left' ? 'Left' : 'Right'}Hand_Socket`;

/** The rig of an entity's model, if it is a rigged asset. */
export function entityRig(obj, assets) {
  return obj?.entity.kind === 'asset' ? assets.get(obj.entity.assetId)?.rig ?? null : null;
}

/** Prop info ({ hands, hold, hand, grip }) of an entity, if it is a holdable prop asset. */
export function entityProp(obj, assets) {
  return obj?.entity.kind === 'asset' ? assets.get(obj.entity.assetId)?.prop ?? null : null;
}

/**
 * How a prop entity is held: its tinyimgen grip.json (hands, hold, arms, carry, fingers) with this instance's edits
 * (`params.hold`, from the Inspector) on top. Finger curls are replaced per hand ("primary" = the holding hand,
 * "secondary" = the support hand of a two-handed prop). Null if it isn't a holdable prop.
 */
export function holdData(obj, assets) {
  const prop = entityProp(obj, assets);
  if (!prop) return null;
  const base = prop.grip ?? { hands: prop.hands, hold: prop.hold, arms: 'animated', carry: null };
  const edits = obj.entity.params.hold ?? {};
  const data = { ...base, ...edits, fingers: { ...base.fingers, ...edits.fingers } };
  if (!data.carry) data.arms = 'animated'; // a static hold needs a carry pose, which only the Prop Editor makes
  return data;
}

/**
 * The editor's preview pose for a rigged entity: the first frame of its Idle clip (the bind pose if it has none),
 * then the hold of each prop in its hands (carry / ready pose, support hand, finger curls), as the playtest
 * applies it every frame. Re-run whenever the character or anything it holds changes.
 */
export function poseCharacter(obj, assets) {
  const asset = assets.get(obj.entity.assetId), model = assetModel(obj);
  if (!asset?.rig || !model) return;
  let pose = model.__pose;
  if (!pose) {
    const rest = [];
    traverseOwn(model, (o) => { if (o.isBone) rest.push([o, o.position.clone(), o.quaternion.clone()]); });
    // The clip's first keyframe per track, set directly: an AnimationMixer skips writing values that didn't change
    // since its last update, so it can't re-apply the same frame after the rest pose is restored.
    const idle = asset.animations.find((c) => /^idle$/i.test(c.name)) ?? asset.animations.find((c) => /idle/i.test(c.name));
    const keys = [];
    for (const track of idle?.tracks ?? []) {
      const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(track.name);
      const node = findOwn(model, nodeName), target = node?.[propertyName];
      if (target?.fromArray) keys.push([target, track.values.slice(0, track.getValueSize())]);
    }
    pose = model.__pose = { rest, keys };
  }
  for (const [bone, p, q] of pose.rest) { bone.position.copy(p); bone.quaternion.copy(q); }
  for (const [target, values] of pose.keys) target.fromArray(values);
  for (const child of childEntities(obj)) {
    if (!child.visible || !isHandSocket(child.entity.attach)) continue;
    const held = heldProp(child, child.parent, holdData(child, assets));
    if (held) poseHeld(model, held, asset.size.y);
  }
  model.updateMatrixWorld(true);
}

/**
 * Local transform (relative to its socket) that puts a prop entity's Grip_Primary exactly on the socket, keeping
 * the entity's uniform scale. Null if it has no grip.
 */
export function gripTransform(obj) {
  const grip = findOwn(obj, 'Grip_Primary');
  if (!grip) return null;
  obj.updateWorldMatrix(true, true);
  const rel = obj.matrixWorld.clone().invert().multiply(grip.matrixWorld); // the grip in the entity's frame
  const t = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  rel.decompose(t, q, s);
  const scale = obj.scale.x;
  q.invert();
  return { position: t.multiplyScalar(-scale).applyQuaternion(q), quaternion: q, scale };
}
