// Player controller: how the player moves, looks around and switches views. Attach it to the Player Spawn (the
// editor does that from the spawn's Inspector) and change anything here: speeds, jumping, the camera, the keys.
// Without one, the playtest runs this script with the spawn's settings. It's an ordinary script, plus:
//   this.game.player   position (feet), velocity, onGround, groundNormal, character (its .settings: fields of this
//                      script the character plays with, from its model meta), spawn, respawn(), teleport(),
//                      locomotion({ idle, walk, run, back, left, right }, { walk, run }, rates): walk the character
//                      with these library clips, at these speeds (m/s); rates { idle, walk, … }: each clip's
//                      playback speed (× 1)
//   this.game.physics  move(dt, { radius, height, step, maxSlope }): walk the player by its velocity, with collisions
//                      cameraClearance(origin, dir, max): how far a camera can sit along a ray before hitting the map
//   this.game.view     mode ('first' | 'third'), facing ('free' | 'strafe'), set(mode), setFacing(facing)
//   this.game.input    isDown(code), pressed(code), mouse { dx, dy, wheel } this frame, active (the game has the
//                      keyboard: focused, menu closed), locked (the mouse is captured: click the game to capture it)
export const controlsPlayer = true;

// a moving clip's playback speed: the cadence changes, the movement speed doesn't
const STEPS = 'Quicker, shorter steps (above 1) or slower, longer ones (below 1) at the same movement speed. 1 keeps the feet planted.';

export const params = {
  walkSpeed: { type: 'number', default: 1.6, min: 0.1, step: 0.1, label: 'Walk speed (m/s)', title: 'Both views. In third person the walk clips play faster or slower to match (walking back and strafing scale with it), so the feet stay planted.' },
  runSpeed: { type: 'number', default: 4, min: 0.1, step: 0.1, label: 'Run speed (m/s)', title: 'With Shift, in both views. The run clip plays faster or slower to match.' },
  jump: { type: 'number', default: 8, min: 0, step: 0.1, label: 'Jump speed', title: 'Upward speed when jumping (m/s). Jump height ≈ speed² / (2 × gravity).' },
  gravity: { type: 'number', default: 24, min: 0.1, step: 0.5, label: 'Gravity (m/s²)' },
  airControl: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.05, label: 'Air control' },
  stepHeight: { type: 'number', default: 0.45, min: 0, step: 0.05, label: 'Step height (m)', title: 'Tallest ledge walked up without jumping' },
  maxSlope: { type: 'number', default: 50, min: 1, max: 89, step: 1, label: 'Max slope (°)', title: 'Steeper surfaces can\'t be climbed; the player slides off them' },
  radius: { type: 'number', default: 0.35, min: 0.05, step: 0.05, label: 'Radius (m)' },
  height: { type: 'number', default: 1.8, min: 0.2, step: 0.05, label: 'Body height (m)', title: 'The player can walk under things taller than this' },
  eyeHeight: { type: 'number', default: 1.6, min: 0.2, step: 0.05, label: 'Eye height (m)' },
  view: { type: 'select', options: [['', 'Player\'s choice'], ['first', 'First person'], ['third', 'Third person']], default: '', label: 'Start in' },
  facing: { type: 'select', options: [['', 'Player\'s choice'], ['free', 'Turns to move'], ['strafe', 'Strafe (faces camera)']], default: '', label: 'Facing' },
  cameraDistance: { type: 'number', default: 4.5, min: 1.2, max: 14, step: 0.1, label: '3rd-person distance' },
  mouseSensitivity: { type: 'number', default: 1, min: 0.1, max: 5, step: 0.1, label: 'Mouse sensitivity' },
  // the character's movement animation: clips from the engine's library, blended by speed and direction
  idleClip: { type: 'clip', default: 'Idle', label: 'Idle clip' },
  idleRate: { type: 'number', default: 1, min: 0.05, max: 5, step: 0.05, label: 'Idle clip speed (×)', title: 'Plays the idle clip faster or slower' },
  walkClip: { type: 'clip', default: 'Walk', label: 'Walk clip' },
  walkRate: { type: 'number', default: 1, min: 0.05, max: 5, step: 0.05, label: 'Walk clip speed (×)', title: STEPS },
  runClip: { type: 'clip', default: 'Run', label: 'Run clip', title: 'Shift. None: it only walks' },
  runRate: { type: 'number', default: 1, min: 0.05, max: 5, step: 0.05, label: 'Run clip speed (×)', title: STEPS },
  backClip: { type: 'clip', default: 'WalkBackward', label: 'Walk back clip', title: 'S, when facing the camera (strafe)' },
  backRate: { type: 'number', default: 1, min: 0.05, max: 5, step: 0.05, label: 'Walk back clip speed (×)', title: STEPS },
  leftClip: { type: 'clip', default: 'StrafeLeft', label: 'Strafe left clip', title: 'A, when facing the camera (strafe)' },
  leftRate: { type: 'number', default: 1, min: 0.05, max: 5, step: 0.05, label: 'Strafe left clip speed (×)', title: STEPS },
  rightClip: { type: 'clip', default: 'StrafeRight', label: 'Strafe right clip', title: 'D, when facing the camera (strafe)' },
  rightRate: { type: 'number', default: 1, min: 0.05, max: 5, step: 0.05, label: 'Strafe right clip speed (×)', title: STEPS },
};

const angleTo = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

export default class PlayerController {
  start() {
    const { game, params: p } = this;
    // first person: where the eyes look. third person: the camera orbit (yaw/pitch/distance) and the body's heading.
    this.look = { yaw: 0, pitch: 0 };
    this.orbit = { yaw: Math.PI, pitch: 0.3, dist: p.cameraDistance, curDist: p.cameraDistance, body: Math.PI };
    this.slide = new this.THREE.Vector2(); // sliding down ground too steep to stand on (third person)
    this.target = new this.THREE.Vector3();
    this.dir = new this.THREE.Vector3();
    if (p.view) game.view.set(p.view, { sticky: true });
    if (p.facing) game.view.setFacing(p.facing);
    this.faceSpawn();
    this.useClips();
    game.on('respawn', () => this.faceSpawn());
    game.on('viewChanged', ({ mode }) => this.keepLooking(mode));
    game.on('characterChanged', () => this.useClips()); // a character picked in the menu walks with them too
  }

  /**
   * The character's movement animation: these clips, blended by speed and direction like tinyimgen's own
   * locomotion (the feet stay planted, on any tinyimgen body), sped up or slowed down to the walk and run speeds,
   * then by each clip's own speed. A character with its own settings (Mechanic's walk and run speeds, say) plays
   * with those instead of these fields, in both views.
   */
  useClips() {
    const p = this.settings = { ...this.params, ...this.game.player.character?.settings };
    try {
      this.game.player.locomotion(
        { idle: p.idleClip, walk: p.walkClip, run: p.runClip, back: p.backClip, left: p.leftClip, right: p.rightClip },
        { walk: p.walkSpeed, run: p.runSpeed },
        { idle: p.idleRate, walk: p.walkRate, run: p.runRate, back: p.backRate, left: p.leftRate, right: p.rightRate },
      );
    } catch (err) {
      this.game.message(`Player animation: ${err.message}`, 6);
    }
  }

  /** Spawns face -Z like a camera; characters face +Z, so the body turns around. */
  faceSpawn() {
    const yaw = this.game.player.spawn?.rotationY ?? 0;
    this.look.yaw = yaw;
    this.look.pitch = 0;
    this.orbit.yaw = this.orbit.body = yaw + Math.PI;
    this.slide.set(0, 0);
  }

  /** Switching views keeps looking the same way. */
  keepLooking(mode) {
    if (mode === 'third') {
      this.orbit.yaw = this.orbit.body = this.look.yaw + Math.PI;
      this.orbit.curDist = 0.5; // zoom out from the eye
    } else {
      this.look.yaw = this.orbit.yaw + Math.PI;
      this.look.pitch = -this.orbit.pitch * 0.5;
    }
  }

  update(dt) {
    const { game, settings: p, THREE } = this;
    const { input, player, view } = game;
    const active = input.active;  // the game has the keyboard
    const looking = input.locked; // the mouse is captured, so moving it looks around
    const held = (...codes) => active && codes.some((c) => input.isDown(c));
    const third = view.mode === 'third' && !!player.character;

    if (active && input.pressed('KeyV')) view.set(view.mode === 'third' ? 'first' : 'third');
    if (active && input.pressed('KeyT') && view.mode === 'third') view.setFacing(view.facing === 'free' ? 'strafe' : 'free');
    if (active && input.pressed('KeyR')) player.respawn();
    if (active && input.pressed('Space') && player.onGround) { player.velocity.y = p.jump; player.onGround = false; }

    // mouse look and zoom
    const sens = 0.0025 * p.mouseSensitivity, m = input.mouse;
    if (looking) {
      if (third) {
        this.orbit.yaw -= m.dx * sens;
        this.orbit.pitch = THREE.MathUtils.clamp(this.orbit.pitch + m.dy * sens, -0.5, 1.25);
      } else {
        this.look.yaw -= m.dx * sens;
        this.look.pitch = THREE.MathUtils.clamp(this.look.pitch - m.dy * sens, -1.55, 1.55);
      }
    }
    if (third && m.wheel) this.orbit.dist = THREE.MathUtils.clamp(this.orbit.dist * Math.exp(m.wheel * 0.001), 1.2, 14);

    const ix = (held('KeyA', 'ArrowLeft') ? 1 : 0) - (held('KeyD', 'ArrowRight') ? 1 : 0); // +1 = left
    const iz = (held('KeyW', 'ArrowUp') ? 1 : 0) - (held('KeyS', 'ArrowDown') ? 1 : 0);  // +1 = forward
    const running = held('ShiftLeft', 'ShiftRight');
    const n = player.groundNormal;
    const steep = player.onGround && n.y < Math.cos(THREE.MathUtils.degToRad(p.maxSlope));
    const v = player.velocity;

    if (third) this.moveThirdPerson(dt, ix, iz, running, steep);
    else {
      // first person: accelerate toward where the keys point, relative to the view
      const s = Math.sin(this.look.yaw), c = Math.cos(this.look.yaw);
      let wx = -s * iz - c * ix, wz = -c * iz + s * ix;
      const len = Math.hypot(wx, wz), speed = running ? p.runSpeed : p.walkSpeed;
      if (len > 0) { wx = (wx / len) * speed; wz = (wz / len) * speed; }
      const accel = player.onGround && !steep ? 12 : 3 * Math.max(p.airControl, 0.05) / 0.3; // little grip on steep slopes / in the air
      v.x += (wx - v.x) * Math.min(1, accel * dt);
      v.z += (wz - v.z) * Math.min(1, accel * dt);
      if (steep) { v.x += n.x * p.gravity * dt; v.z += n.z * p.gravity * dt; } // slide down it
    }
    v.y -= p.gravity * dt;
    game.physics.move(dt, { radius: p.radius, height: p.height, step: p.stepHeight, maxSlope: p.maxSlope });

    if (third) {
      player.character.root.position.copy(player.position);
      player.character.root.rotation.y = this.orbit.body;
      this.thirdPersonCamera(dt);
    } else {
      game.camera.position.set(player.position.x, player.position.y + p.eyeHeight, player.position.z);
      game.camera.quaternion.setFromEuler(new THREE.Euler(this.look.pitch, this.look.yaw, 0, 'YXZ'));
    }
  }

  /** The character's animation moves it, at the walk and run speeds (feet stay planted); this steers it. */
  moveThirdPerson(dt, ix, iz, running, steep) {
    const { game, settings: p, orbit } = this;
    const { player, view } = game;
    let move;
    if (view.facing === 'strafe') {
      // the body turns to the camera's heading; A/D strafe and S walks backwards
      if (ix || iz) orbit.body += angleTo(orbit.body, orbit.yaw) * (1 - Math.exp(-10 * dt));
      const d = angleTo(orbit.body, orbit.yaw), c = Math.cos(d), s = Math.sin(d);
      move = { x: ix * c + iz * s, z: iz * c - ix * s };
    } else {
      // the body turns toward where it's going and always walks forward
      if (ix || iz) orbit.body += angleTo(orbit.body, orbit.yaw + Math.atan2(ix, iz)) * (1 - Math.exp(-8 * dt));
      move = { x: 0, z: ix || iz ? 1 : 0 };
    }
    if (!player.onGround) move = { x: move.x * p.airControl, z: move.z * p.airControl };
    const lv = player.character.update(dt, move, running); // local velocity from the animation
    const n = player.groundNormal;
    if (steep) { this.slide.x += n.x * p.gravity * dt; this.slide.y += n.z * p.gravity * dt; }
    else this.slide.multiplyScalar(Math.exp(-10 * dt));
    const c = Math.cos(orbit.body), s = Math.sin(orbit.body);
    player.velocity.x = lv.z * s + lv.x * c + this.slide.x;
    player.velocity.z = lv.z * c - lv.x * s + this.slide.y;
  }

  /** Orbit camera that pulls in instead of clipping through walls, and eases back out. */
  thirdPersonCamera(dt) {
    const { game, orbit, target, dir } = this;
    const pos = game.player.position;
    target.set(pos.x, pos.y + game.player.character.height * 0.85, pos.z);
    dir.set(-Math.sin(orbit.yaw) * Math.cos(orbit.pitch), Math.sin(orbit.pitch), -Math.cos(orbit.yaw) * Math.cos(orbit.pitch));
    const free = Math.max(0.4, game.physics.cameraClearance(target, dir, orbit.dist) - 0.25);
    orbit.curDist = free < orbit.curDist ? free : orbit.curDist + (Math.min(free, orbit.dist) - orbit.curDist) * (1 - Math.exp(-4 * dt));
    game.camera.position.copy(target).addScaledVector(dir, orbit.curDist);
    game.camera.lookAt(target);
  }
}
