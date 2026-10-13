/**
 * Animation for characters in a map exported by 3D Map Creator, driven from code: an Animator per character
 * (play / crossfade clips) and a small state machine on top. scripts.js gives scripts these as
 * `this.game.animator(object)` and `this.game.stateMachine({...})`; your game can use them directly.
 * Depends on `three`, ../anim/clips.js and ../anim/skeleton.js (clip evaluation for tinyimgen's skeleton).
 *
 *   const anim = new Animator(characterNode, clips);   // clips: the map's clip library (decodeClips(root.userData.clips))
 *   anim.play('Wave', { fade: 0.25 }).then(() => anim.play('Idle'));
 *   // every frame: anim.update(dt)
 *
 *   const fsm = createStateMachine({ animator: anim, initial: 'idle', states: {
 *     idle:  { clip: 'Idle', update: () => (playerIsNear() ? 'greet' : null) },  // return a state name to switch
 *     greet: { clip: 'Wave', loop: false, next: 'idle' },                       // next: when the one-shot ends
 *   } });
 *   // every frame: fsm.update(dt) (before anim.update)
 */
import * as THREE from 'three';
import { rigOf, bakeClip } from '../anim/clips.js';
import { FINGERS, PHALANX } from '../anim/skeleton.js';

/** The clip library as exported in the map (base64 Float32Arrays) back to clips. */
export function decodeClips(list) {
  if (!Array.isArray(list)) return [];
  const revive = (v) => {
    if (Array.isArray(v)) return v.map(revive);
    if (v && typeof v === 'object') {
      if (typeof v.$f32 === 'string') {
        const s = atob(v.$f32), bytes = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
        return new Float32Array(bytes.buffer);
      }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
    }
    return v;
  };
  return list.map(revive);
}

const handFingers = (side) => FINGERS.flatMap((f) => PHALANX.map((p) => `${side}${f}${p}`));

export class Animator {
  /**
   * node: a character in the map (a tinyimgen skeleton). clips: library clips ({ name, loop, … }, anim/clips.js).
   * holding: hand sides holding a prop ('Left' / 'Right'): those fingers keep their grip instead of animating.
   */
  constructor(node, clips, { holding = [] } = {}) {
    // the library's clips, then this character's own (marked with its model's name) for names the library lacks
    const mine = clips.filter((c) => !c.owner);
    for (const c of clips) if (c.owner && c.owner === node.userData.asset && !mine.some((m) => m.name === c.name)) mine.push(c);
    clips = mine;
    const rig = rigOf(node);
    if (!rig) throw new Error(`"${node.userData?.name ?? node.name}" isn't a tinyimgen character`);
    const rest = node.userData.rig?.restHips; // the exported pose isn't the rest pose: the export records the hips' rest
    if (Array.isArray(rest)) { rig.restHips.fromArray(rest); rig.hipsHeight = rest[1] > 0.05 ? rest[1] : 1; }
    this.node = node;
    this.rig = rig;
    this.library = new Map(clips.map((c) => [c.name, c]));
    this.mixer = new THREE.AnimationMixer(node);
    this.baked = new Map();
    this.keep = new Set(holding.flatMap(handFingers));
    this.current = null;
    this.listeners = new Set();
    this.speed = 1;
    this.mixer.addEventListener('finished', (e) => {
      const cur = this.current;
      if (!cur || e.action !== cur.action) return;
      cur.finished = true;
      cur.resolve(cur.name);
      for (const fn of [...this.listeners]) fn(cur.name);
    });
  }

  /** Names of the clips it can play. */
  get clips() { return [...this.library.keys()]; }
  /** The clip playing (or holding its last frame), or null. */
  get state() { return this.current?.name ?? null; }
  /** Seconds into the current clip. */
  get time() { return this.current?.action.time ?? 0; }
  has(name) { return this.library.has(name); }

  _clip(name) {
    if (!this.baked.has(name)) {
      const src = this.library.get(name);
      if (!src) return null;
      const clip = bakeClip(src, this.rig);
      if (this.keep.size) clip.tracks = clip.tracks.filter((t) => !this.keep.has(t.name.slice(0, t.name.lastIndexOf('.')).replace(/_\d+$/, '')));
      this.baked.set(name, clip);
    }
    return this.baked.get(name);
  }

  /**
   * Crossfade to a clip. loop defaults to the clip's own setting; a one-shot holds its last frame when it ends.
   * Returns a promise that resolves (with the name) when a one-shot ends. Playing the clip that's already on does
   * nothing unless restart is true.
   */
  play(name, { fade = 0.25, loop, speed = 1, restart = false } = {}) {
    if (this.current?.name === name && !restart && !this.current.finished) return this.current.done;
    const clip = this._clip(name);
    if (!clip) {
      console.warn(`Animator: no clip named "${name}" (have: ${this.clips.join(', ')})`);
      return Promise.resolve(null);
    }
    const action = this.mixer.clipAction(clip);
    const repeat = loop ?? !!this.library.get(name).loop;
    const prev = this.current;
    action.reset();
    action.setLoop(repeat ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !repeat;
    action.timeScale = speed;
    action.play();
    if (prev && prev.action !== action) action.crossFadeFrom(prev.action, fade, false);
    else if (!prev) action.fadeIn(fade);
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    this.current = { name, action, done, resolve, finished: false };
    return done;
  }

  /** Fade the clip out (the character eases back to its exported pose). */
  stop(fade = 0.25) {
    if (!this.current) return;
    this.current.action.fadeOut(fade);
    this.current = null;
  }

  /** fn(name) whenever a one-shot clip ends. Returns an unsubscribe function. */
  onFinished(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(dt) { this.mixer.update(dt * this.speed); }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.node);
    this.listeners.clear();
  }
}

/**
 * A finite state machine for a character (or anything else). states: { name: {
 *   clip, loop, fade, speed   — played on the animator when the state starts (optional)
 *   enter(sm, data), exit(sm) — called on the way in and out
 *   update(dt, sm)            — every frame; return a state name to switch to it
 *   next, duration            — switch to `next` when the one-shot clip ends, or after `duration` seconds
 * } }
 * The machine: sm.state, sm.previous, sm.time (seconds in the state), sm.go(name, data), sm.update(dt).
 * Callbacks are plain functions: use arrow functions to keep your script's `this`.
 */
export function createStateMachine({ animator = null, states, initial }) {
  if (!states || !states[initial]) throw new Error(`stateMachine: initial state "${initial}" isn't in states`);
  let token = 0;
  const sm = {
    state: null,
    previous: null,
    time: 0,
    animator,
    go(name, data) {
      const s = states[name];
      if (!s) { console.warn(`stateMachine: no state "${name}"`); return; }
      if (sm.state) states[sm.state].exit?.(sm);
      sm.previous = sm.state;
      sm.state = name;
      sm.time = 0;
      const mine = ++token;
      if (animator && s.clip) {
        const done = animator.play(s.clip, { fade: s.fade, loop: s.loop, speed: s.speed, restart: true });
        if (s.next && !s.duration) done.then((ok) => { if (ok && token === mine) sm.go(s.next); });
      }
      s.enter?.(sm, data);
    },
    update(dt) {
      if (!sm.state) return;
      sm.time += dt;
      const s = states[sm.state];
      const to = s.update?.(dt, sm);
      if (typeof to === 'string' && to !== sm.state) sm.go(to);
      else if (s.duration && s.next && sm.time >= s.duration) sm.go(s.next);
    },
  };
  sm.go(initial);
  return sm;
}
