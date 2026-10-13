/**
 * Walking, running and strafing from library clips, for any tinyimgen character: pick a clip for each movement
 * state and it blends them by the character's velocity, like tinyimgen's own locomotion (src/game/locomotion.js),
 * with the feet planted. Each clip's gait (speed, stride, phase sync; clips.js gaitFor) is fitted to the
 * character's leg length, so one set of clips works on every body.
 *
 *   const loco = clipLocomotion(model, rigOf(model), clips, { idle: 'Idle', walk: 'Walk', run: 'Run',
 *     back: 'WalkBackward', left: 'StrafeLeft', right: 'StrafeRight' });
 *   // every frame: input.x = left(+)/right(-), input.z = forward(+)/back(-), |input| <= 1
 *   const v = loco.update(dt, input, running);   // local velocity (m/s, model units): v.x left, v.z forward
 *
 * idle and walk are required; the others fall back the way Locomotion does (no run: walking only, and so on).
 * options.rates { idle, walk, … } plays a state's clip faster (> 1) or slower (< 1) than it would otherwise: Idle
 * plays at that rate; a moving clip takes quicker, shorter steps (or slower, longer ones) at the same movement speed,
 * so anything but 1 slides the feet a little. Other options go to Locomotion.
 * Depends on `three`, ../anim/clips.js and ../game/locomotion.js.
 */
import { Locomotion } from '../game/locomotion.js';
import { bakeClip, gaitFor } from '../anim/clips.js';

/** Movement state -> the clip name Locomotion blends it as. */
export const LOCOMOTION_STATES = { idle: 'Idle', walk: 'Walk', run: 'Run', back: 'WalkBackward', left: 'StrafeLeft', right: 'StrafeRight' };

/** The clip names a states object picks ({ idle: 'Idle', … }), without empty ones. */
export const locomotionClipNames = (states) => Object.keys(LOCOMOTION_STATES).map((k) => states?.[k]).filter(Boolean);

export function clipLocomotion(model, rig, clips, states, { rates, ...options } = {}) {
  if (!states?.idle || !states?.walk) throw new Error('locomotion needs at least an idle and a walk clip');
  const byName = new Map(clips.map((c) => [c.name, c]));
  const animations = [], extras = [];
  for (const [state, as] of Object.entries(LOCOMOTION_STATES)) {
    const name = states[state];
    if (!name) continue;
    const clip = byName.get(name);
    if (!clip) throw new Error(`no clip named "${name}" for ${state} (have: ${[...byName.keys()].join(', ') || 'none'})`);
    const baked = bakeClip(clip, rig);
    baked.name = as;
    animations.push(baked);
    const gait = gaitFor(clip, rig);
    if (!gait && state !== 'idle') console.warn(`"${name}" has no gait (speed, stride): its feet may slide. Locomotion clips imported from a tinyimgen character have one.`);
    const rate = rateOf(rates, state);
    // the shared gait phase advances by distance / stride: a shorter stride steps quicker at the same speed
    extras.push({ name: as, extras: state === 'idle' || rate === 1 ? gait ?? {} : { ...gait, stride: (gait?.stride || 1) / rate } });
  }
  const loco = new Locomotion({ scene: model, animations, parser: { json: { animations: extras } } }, options);
  const idle = rateOf(rates, 'idle');
  if (idle !== 1) loco.setRate('Idle', loco.clips.Idle.baked * idle);
  return loco;
}

const rateOf = (rates, state) => (rates?.[state] > 0 ? rates[state] : 1);
