// Animation clips for tinyimgen characters, stored independently of any one character (see skeleton.js).
//
// A clip is an optional dense *base* motion (a tinyimgen mocap clip or a retargeted Mesh2Motion clip) plus sparse
// *keys* on top of it, one channel per bone:
//
//   { id, name, loop, duration, interp: 'smooth' | 'linear', source,
//     base: null | { fps, frames, rot: { bone: Float32Array(frames * 4) }, hips: Float32Array(frames * 3) | null },
//     keys: { bone: [{ t, q: [x, y, z, w] }] },  // rotation offsets: final = offset * base
//     hipKeys: [{ t, p: [x, y, z] }],            // Hips offset, added to the base's
//     rest: { bone: [x, y, z] } | null }         // joint positions of the skeleton it was made for (see below)
//
// Without a base the rest pose (identity) is the base, so keys are plain poses: that's a new clip made from scratch.
// Hips positions are offsets from the rest position in units of the character's hip height, so a clip carries over
// to taller and shorter characters. Between keys the offsets follow a Catmull-Rom curve ('smooth') or a straight
// slerp ('linear'); looping clips wrap around, and outside the keyed range a non-looping clip holds its end keys.
//
// Rotations are made for one character's skeleton (`rest`). Baked for another character (bakeClip, sampleLocal),
// each bone is retargeted: its pose in the world, applied to that character's bone after lining up the two rest
// directions (skeleton.js restAlign). Clips without a `rest` (older ones) play their rotations as they are.
import * as THREE from 'three';
import { BONES, PARENT, findBones, restPositions, restAlign } from './skeleton.js';
import { uid } from '../core/utils.js';
import { fileStem, stemOf, dirName, uniquePath } from '../core/paths.js';

export const FPS = 30;
/** Clips with these names replace the character's own locomotion clip in the playtest. */
export const LOCOMOTION = ['Idle', 'Walk', 'Run', 'WalkBackward', 'StrafeLeft', 'StrafeRight'];
export const isLocomotion = (clip) => LOCOMOTION.includes(clip.name);

export function createClip({ name = 'New clip', duration = 2, loop = true, source = 'new', base = null, rest = null } = {}) {
  return { id: uid(), name, loop, duration, interp: 'smooth', source, base, keys: {}, hipKeys: [], rest };
}

/** A rig's rest joint positions as plain arrays, for a clip's `rest`. */
export const restArrays = (positions) => Object.fromEntries(Object.entries(positions).map(([b, v]) => [b, v.toArray().map((x) => +x.toFixed(5))]));
const restVectors = (rest) => Object.fromEntries(Object.entries(rest).map(([b, a]) => [b, new THREE.Vector3().fromArray(a)]));

/**
 * How a clip maps onto a rig: null when it plays as is (no `rest`, or the same skeleton), else per-bone alignments.
 * Cached per rig.
 */
export function retargetFor(clip, rig) {
  if (!clip.rest || !rig) return null;
  rig._retarget ??= new WeakMap();
  if (rig._retarget.has(clip.rest)) return rig._retarget.get(clip.rest);
  const target = restPositions(rig), source = restVectors(clip.rest);
  const align = restAlign(source, target);
  const same = Object.values(align).every((q) => Math.abs(q.w) > 0.99999);
  const rt = same ? null : align;
  rig._retarget.set(clip.rest, rt);
  return rt;
}

const _w = {}, _qa = new THREE.Quaternion();
/**
 * The clip's local rotation for every bone of a rig at time t, into out[bone] (Quaternions), retargeted when the
 * clip was made for another skeleton.
 */
export function sampleLocal(clip, t, rig, out) {
  const rt = retargetFor(clip, rig);
  for (const b of BONES) {
    if (!rig.bones[b]) continue;
    out[b] ??= new THREE.Quaternion();
    boneRotation(clip, b, t, out[b]);
  }
  if (!rt) return out;
  // world rotations on the clip's own skeleton (rest rotations are identity, so world = product of locals)
  for (const b of BONES) {
    if (!out[b]) continue;
    const p = PARENT[b];
    _w[b] ??= new THREE.Quaternion();
    _w[b].copy(p && _w[p] ? _w[p] : _qa.identity()).multiply(out[b]);
  }
  // the same world pose on this rig's bones, back to locals
  for (const b of BONES) {
    if (!out[b]) continue;
    const p = PARENT[b];
    const world = (_w[`$${b}`] ??= new THREE.Quaternion()).copy(_w[b]).multiply(rt[b] ?? _qa.identity());
    out[b].copy(p ? _w[`$${p}`] : _qa.identity()).invert().multiply(world);
  }
  return out;
}

/** A copy with its own keys (the base is never edited, so it's shared). */
export function duplicateClip(clip, name = `${clip.name} copy`) {
  return { ...clip, ...structuredClone(editState(clip)), id: uid(), name };
}

/** The editable part of a clip, for undo. */
export const editState = (clip) => ({
  name: clip.name, loop: clip.loop, duration: clip.duration, interp: clip.interp,
  keys: structuredClone(clip.keys), hipKeys: structuredClone(clip.hipKeys),
});
export const applyEditState = (clip, s) => Object.assign(clip, structuredClone(s));

/** Number of frames a clip shows: a loop's last frame is its first, so it isn't one of them. */
export const frameCount = (clip) => Math.max(1, Math.round(clip.duration * FPS) + (clip.loop ? 0 : 1));
export const snapTime = (t) => Math.round(t * FPS) / FPS;

// ------------------------------------------------------------------ rig of a model

/**
 * What a clip needs to know about a model to play on it: its bones and the Hips' rest position (the model must be
 * in its rest pose when this is called). Null if it isn't a tinyimgen skeleton.
 */
export function rigOf(model) {
  const bones = findBones(model);
  if (!bones) return null;
  const restHips = bones.Hips.position.clone();
  return { bones, restHips, hipsHeight: restHips.y > 0.05 ? restHips.y : 1 };
}

// ------------------------------------------------------------------ evaluation

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3();

/** Keys of a channel around time t: { k0, k1, k2, k3 } (times t0..t3, adjusted across a loop) and u in [0, 1]. */
function around(keys, t, duration, loop) {
  const n = keys.length;
  if (loop) {
    const span = duration > 0 ? duration : 1;
    const first = keys[0].t;
    t = first + ((((t - first) % span) + span) % span);
    let i = n - 1;
    while (i > 0 && keys[i].t > t) i--;
    const at = (j) => ({ key: keys[((j % n) + n) % n], t: keys[((j % n) + n) % n].t + Math.floor(j / n) * span });
    const k0 = at(i - 1), k1 = at(i), k2 = at(i + 1), k3 = at(i + 2);
    const len = k2.t - k1.t;
    return { k0, k1, k2, k3, u: len > 1e-9 ? (t - k1.t) / len : 0 };
  }
  if (t <= keys[0].t) return { hold: keys[0] };
  if (t >= keys[n - 1].t) return { hold: keys[n - 1] };
  let i = 0;
  while (keys[i + 1].t <= t) i++;
  const k1 = { key: keys[i], t: keys[i].t }, k2 = { key: keys[i + 1], t: keys[i + 1].t };
  const k0 = i > 0 ? { key: keys[i - 1], t: keys[i - 1].t } : { key: keys[i], t: k1.t - (k2.t - k1.t) };
  const k3 = i + 2 < n ? { key: keys[i + 2], t: keys[i + 2].t } : { key: keys[i + 1], t: k2.t + (k2.t - k1.t) };
  return { k0, k1, k2, k3, u: (t - k1.t) / (k2.t - k1.t) };
}

/** Cubic Hermite through p1..p2 with Catmull-Rom tangents scaled for uneven key spacing. */
function catmull(p0, p1, p2, p3, t0, t1, t2, t3, u, out) {
  const d = t2 - t1;
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  for (let c = 0; c < p1.length; c++) {
    const m1 = t2 > t0 ? ((p2[c] - p0[c]) / (t2 - t0)) * d : 0;
    const m2 = t3 > t1 ? ((p3[c] - p1[c]) / (t3 - t1)) * d : 0;
    out[c] = h00 * p1[c] + h10 * m1 + h01 * p2[c] + h11 * m2;
  }
  return out;
}

const flipTo = (q, ref) => (q[0] * ref[0] + q[1] * ref[1] + q[2] * ref[2] + q[3] * ref[3] < 0 ? q.map((v) => -v) : q);
const _arr = [0, 0, 0, 0];

/** A loop's keys must lie inside one cycle; keys left past the end after shortening a clip are ignored. */
const usable = (keys, clip) => (keys?.length && clip.loop && keys[keys.length - 1].t >= clip.duration - 1e-6
  ? keys.filter((k) => k.t < clip.duration - 1e-6) : keys);

/** The keyed rotation offset of one channel at time t (identity when it has no keys). */
export function keyedRotation(keys, t, clip, out = new THREE.Quaternion()) {
  keys = usable(keys, clip);
  if (!keys?.length) return out.identity();
  const s = around(keys, t, clip.duration, clip.loop);
  if (s.hold) return out.fromArray(s.hold.q);
  if (clip.interp === 'linear') return out.fromArray(s.k1.key.q).slerp(_q2.fromArray(s.k2.key.q), s.u);
  const p1 = s.k1.key.q, p2 = flipTo(s.k2.key.q, p1), p3 = flipTo(s.k3.key.q, p2), p0 = flipTo(s.k0.key.q, p1);
  return out.fromArray(catmull(p0, p1, p2, p3, s.k0.t, s.k1.t, s.k2.t, s.k3.t, s.u, _arr)).normalize();
}

/** The keyed Hips offset at time t (zero when there are no hip keys). */
export function keyedHips(clip, t, out = new THREE.Vector3()) {
  const keys = usable(clip.hipKeys, clip);
  if (!keys?.length) return out.set(0, 0, 0);
  const s = around(keys, t, clip.duration, clip.loop);
  if (s.hold) return out.fromArray(s.hold.p);
  if (clip.interp === 'linear') return out.fromArray(s.k1.key.p).lerp(_v.fromArray(s.k2.key.p), s.u);
  return out.fromArray(catmull(s.k0.key.p, s.k1.key.p, s.k2.key.p, s.k3.key.p, s.k0.t, s.k1.t, s.k2.t, s.k3.t, s.u, [0, 0, 0]));
}

function baseFrame(base, t, clip) {
  const last = base.frames - 1;
  let f = t * base.fps;
  if (clip.loop && last > 0) f = ((f % last) + last) % last;
  f = Math.min(Math.max(f, 0), last);
  const i = Math.min(Math.floor(f), Math.max(last - 1, 0));
  return { i, u: last > 0 ? f - i : 0 };
}

/** The base rotation of a bone at time t (identity without a base). */
export function baseRotation(clip, bone, t, out = new THREE.Quaternion()) {
  const rot = clip.base?.rot[bone];
  if (!rot) return out.identity();
  const { i, u } = baseFrame(clip.base, t, clip);
  out.fromArray(rot, i * 4);
  return u > 0 && i + 1 < clip.base.frames ? out.slerp(_q.fromArray(rot, (i + 1) * 4), u) : out;
}

/** The base Hips offset (hip heights) at time t. */
export function baseHips(clip, t, out = new THREE.Vector3()) {
  const h = clip.base?.hips;
  if (!h) return out.set(0, 0, 0);
  const { i, u } = baseFrame(clip.base, t, clip);
  out.fromArray(h, i * 3);
  return u > 0 && i + 1 < clip.base.frames ? out.lerp(_v.fromArray(h, (i + 1) * 3), u) : out;
}

/** Final local rotation of a bone at time t: its keyed offset times its base rotation. */
export function boneRotation(clip, bone, t, out = new THREE.Quaternion()) {
  baseRotation(clip, bone, t, _q2);
  return keyedRotation(clip.keys[bone], t, clip, out).multiply(_q2);
}

/** Final Hips offset (hip heights) at time t. */
export function hipsOffset(clip, t, out = new THREE.Vector3()) {
  return keyedHips(clip, t, out).add(baseHips(clip, t, _v));
}

/** Pose a model (its rig, from rigOf) as the clip is at time t. */
export function applyPose(clip, t, rig) {
  for (const [name, bone] of Object.entries(rig.bones)) boneRotation(clip, name, t, bone.quaternion);
  hipsOffset(clip, t, _v);
  rig.bones.Hips.position.copy(rig.restHips).addScaledVector(_v, rig.hipsHeight);
}

// ------------------------------------------------------------------ to / from three.js clips

/** A three.js AnimationClip of the clip for one model, sampled at FPS (every bone keyed, so it fully poses it). */
export function bakeClip(clip, rig) {
  const n = Math.max(2, Math.round(clip.duration * FPS) + 1);
  const times = new Float32Array(n);
  for (let i = 0; i < n; i++) times[i] = Math.min(i / FPS, clip.duration);
  const tracks = [];
  const v = new THREE.Vector3();
  const frames = [];
  for (let i = 0; i < n; i++) frames.push(Object.fromEntries(Object.entries(sampleLocal(clip, times[i], rig, {})).map(([b, q]) => [b, q.clone()])));
  for (const [name, bone] of Object.entries(rig.bones)) {
    const values = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      frames[i][name].toArray(values, i * 4);
      if (i && values[i * 4] * values[i * 4 - 4] + values[i * 4 + 1] * values[i * 4 - 3] + values[i * 4 + 2] * values[i * 4 - 2] + values[i * 4 + 3] * values[i * 4 - 1] < 0) {
        for (let c = 0; c < 4; c++) values[i * 4 + c] *= -1; // stay in one hemisphere so the slerp takes the short way
      }
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, values));
  }
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    hipsOffset(clip, times[i], v);
    v.multiplyScalar(rig.hipsHeight).add(rig.restHips).toArray(pos, i * 3);
  }
  tracks.push(new THREE.VectorKeyframeTrack(`${rig.bones.Hips.name}.position`, times, pos));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/** Import a model's own clip (a tinyimgen locomotion clip) as a library clip, with the motion as its base. */
export function clipFromThree(threeClip, rig, { source = `character:${threeClip.name}`, loop = true } = {}) {
  const byNode = new Map();
  for (const track of threeClip.tracks) {
    const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(track.name);
    byNode.set(`${nodeName}.${propertyName}`, track);
  }
  const duration = threeClip.duration;
  const frames = Math.max(2, Math.round(duration * FPS) + 1);
  const rot = {};
  for (const [name, bone] of Object.entries(rig.bones)) {
    const track = byNode.get(`${bone.name}.quaternion`) ?? byNode.get(`${name}.quaternion`);
    if (!track) continue;
    const interp = track.createInterpolant();
    const arr = new Float32Array(frames * 4);
    for (let i = 0; i < frames; i++) {
      const r = interp.evaluate(Math.min(i / FPS, duration));
      _q.fromArray(r).normalize().toArray(arr, i * 4);
    }
    rot[name] = arr;
  }
  let hips = null;
  const hipTrack = byNode.get(`${rig.bones.Hips.name}.position`) ?? byNode.get('Hips.position');
  if (hipTrack) {
    const interp = hipTrack.createInterpolant();
    hips = new Float32Array(frames * 3);
    for (let i = 0; i < frames; i++) {
      _v.fromArray(interp.evaluate(Math.min(i / FPS, duration))).sub(rig.restHips).divideScalar(rig.hipsHeight).toArray(hips, i * 3);
    }
  }
  return createClip({ name: threeClip.name, duration, loop, source, base: { fps: FPS, frames, rot, hips }, rest: restArrays(restPositions(rig)) });
}

// ------------------------------------------------------------------ library

/**
 * The shared clip library: one list of clips for every tinyimgen character. It lives in the browser (IndexedDB),
 * travels inside saved projects, and the playtest gets a copy on ▶ Play. Emits 'changed'.
 */
export class ClipLibrary extends EventTarget {
  constructor() {
    super();
    this.clips = [];
  }

  get(id) { return this.clips.find((c) => c.id === id) ?? null; }
  byPath(path) { return this.clips.find((c) => c.path?.toLowerCase() === path.toLowerCase()) ?? null; }

  changed() {
    this._paths();
    this.dispatchEvent(new Event('changed'));
  }

  /** Every clip is a file, clips/<name>.clip.json: give new ones a path, and move renamed ones (same folder). */
  _paths() {
    const taken = [];
    for (const c of this.clips) {
      if (!c.path || stemOf(c.path) !== fileStem(c.name) || taken.some((p) => p.toLowerCase() === c.path.toLowerCase())) c.path = uniquePath(c.path ? dirName(c.path) : 'clips', fileStem(c.name), '.clip.json', taken);
      taken.push(c.path);
    }
  }

  add(clip, index = this.clips.length) {
    clip.name = this.uniqueName(clip.name, clip);
    this.clips.splice(index, 0, clip);
    this.changed();
    return clip;
  }

  remove(id) {
    this.clips = this.clips.filter((c) => c.id !== id);
    this.changed();
  }

  move(id, delta) {
    const i = this.clips.findIndex((c) => c.id === id), j = i + delta;
    if (i < 0 || j < 0 || j >= this.clips.length) return;
    [this.clips[i], this.clips[j]] = [this.clips[j], this.clips[i]];
    this.changed();
  }

  uniqueName(base, self = null) {
    const taken = new Set(this.clips.filter((c) => c !== self).map((c) => c.name));
    if (!taken.has(base)) return base;
    const stem = base.replace(/ \d+$/, '');
    for (let i = 2; ; i++) if (!taken.has(`${stem} ${i}`)) return `${stem} ${i}`;
  }

  /** Clips the playtest plays on the number keys: everything that isn't a locomotion clip, in library order. */
  actions() { return this.clips.filter((c) => !isLocomotion(c)).slice(0, 9); }

  toJSON() { return this.clips; }

  /** Replace the library (null/undefined: keep it). */
  load(list) {
    if (!Array.isArray(list)) return;
    this.clips = list.filter(validClip);
    this.changed();
  }

  /** Add or replace clips by id (a project's clips joining the library). Returns how many came in. */
  merge(list) {
    let n = 0;
    for (const clip of (Array.isArray(list) ? list : []).filter(validClip)) {
      const i = this.clips.findIndex((c) => c.id === clip.id);
      if (i >= 0) this.clips[i] = clip; else this.clips.push(clip);
      n++;
    }
    if (n) this.changed();
    return n;
  }
}

const validClip = (c) => c && typeof c.id === 'string' && typeof c.name === 'string' && c.duration > 0 && c.keys && Array.isArray(c.hipKeys);

/** Every bone name a clip touches (keys or base), in skeleton order. */
export const clipBones = (clip) => BONES.filter((b) => clip.keys[b]?.length || clip.base?.rot[b]);
