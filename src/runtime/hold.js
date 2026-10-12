/**
 * Props held in a character's hand, the way tinyimgen's Play page holds them (see props.js, a copy of tinyimgen's
 * static/props.js). Used by the editor's preview pose and the playtest. Depends only on `three` and props.js.
 *
 * In an exported map a held prop is a node parented to the hand socket ("RightHand_Socket" / "LeftHand_Socket")
 * with `userData.attachedTo` set to the socket name and `userData.grip` holding the prop's grip.json data. After
 * your animation update each frame:
 *
 *   const held = heldProp(propNode, socketNode, propNode.userData.grip);
 *   poseHeld(characterModel, held);
 */
import { readyPose, solveSupportHand, setFingers, carryPose } from './props.js';

export const HAND_SOCKET = /^(Left|Right)Hand_Socket$/;

/** Used when a prop has no saved finger curls (a prop.glb without its grip.json): a loose fist. */
export const DEFAULT_FINGERS = { Thumb: [0.15, 0.5, 0.5], Index: 0.7, Middle: 0.75, Ring: 0.75, Little: 0.75 };

/** A node's name as written in the file. GLTFLoader renames duplicates ("Grip_Primary_1") and keeps the original in userData.name. */
export const originalName = (o) => o.userData?.name ?? o.name;

/** First node under root (root included) with this original name. */
export function findNamed(root, name) {
  let found = null;
  root.traverse((o) => { if (!found && originalName(o) === name) found = o; });
  return found;
}

/**
 * Describe a prop held in a hand socket for props.js. `holder` is the node parented to the socket, with a prop
 * (a "Prop" root with Grip_Primary, and Grip_Secondary for two hands) under it. `data` is the prop's grip.json
 * (hold, arms, carry, fingers). Returns null when socket isn't a hand socket or the prop has no grip.
 */
export function heldProp(holder, socket, data = null) {
  const m = HAND_SOCKET.exec(originalName(socket));
  const grip = m && findNamed(holder, 'Grip_Primary');
  if (!grip) return null;
  const hand = m[1];
  return {
    holder, root: grip.parent, grip, socket, hand, other: hand === 'Right' ? 'Left' : 'Right',
    secondary: findNamed(holder, 'Grip_Secondary'), data: data ?? {},
  };
}

/**
 * Apply the saved hold to `character` (the model with the bones) after its animation update: the static carry
 * pose, or the ready pose for two-handed props, then the support hand on the second grip and the finger curls.
 * `height` is the character's height in its model units (carry poses are stored in character heights).
 */
export function poseHeld(character, held, height) {
  const d = held.data;
  if (d.arms === 'static' && d.carry) carryPose(character, held, d.carry, height);
  else if (held.secondary) readyPose(character, held, d.hold ?? held.root.userData?.hold ?? 'upright');
  if (held.secondary) solveSupportHand(character, held);
  setFingers(character, held.hand, d.fingers?.primary ?? DEFAULT_FINGERS);
  if (held.secondary) setFingers(character, held.other, d.fingers?.secondary ?? DEFAULT_FINGERS);
}
