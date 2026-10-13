import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Terrain } from './Terrain.js';
import { History } from './History.js';
import { AssetLibrary } from './AssetLibrary.js';
import {
  createEntity, serializeEntity, applyEntityState, disposeEntity, isEditorOnly, entityBounds, buildEntities,
  childEntities, entitySubtree, parentEntity, findOwn, isWithin, isShown, assetModel, refreshEntity,
} from './Entities.js';
import { poseCharacter, gripTransform, entityRig, entityProp, socketForHand, isHandSocket } from './Rig.js';
import { uid } from '../core/utils.js';

export const DEFAULT_ENV = {
  background: '#9cc3e6',
  fog: true,
  fogNear: 120,
  fogFar: 520,
  skyColor: '#dcecff',
  groundColor: '#5a4d38',
  ambientIntensity: 1.4,
  sunColor: '#fff3df',
  sunIntensity: 2.6,
  sunAzimuth: 40,
  sunElevation: 55,
  shadows: true,
  showGrid: true,
};

/** Fly-camera keys (KeyboardEvent.code) → [forward, right, up]. Letter keys need the right mouse button held. */
const FLY_KEYS = {
  KeyW: [1, 0, 0], KeyS: [-1, 0, 0], KeyA: [0, -1, 0], KeyD: [0, 1, 0], KeyE: [0, 0, 1], KeyQ: [0, 0, -1],
  ArrowUp: [1, 0, 0], ArrowDown: [-1, 0, 0], ArrowLeft: [0, -1, 0], ArrowRight: [0, 1, 0], PageUp: [0, 0, 1], PageDown: [0, 0, -1],
};
const isTextField = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
/** Pivot coordinate nearest `value` that puts the bounds edge (pivot + minOffset) on a grid line. */
const alignToGrid = (value, minOffset, step) => Math.round((value + minOffset) / step) * step - minOffset;
const toList = (objs) => (Array.isArray(objs) ? objs : objs ? [objs] : []);
const _flyFwd = new THREE.Vector3(), _flyRight = new THREE.Vector3(), _flyMove = new THREE.Vector3();

const BRUSH_COLORS = {
  raise: 0x7dff9b, lower: 0xff8a7d, smooth: 0x7dc8ff, flatten: 0xffe07d, noise: 0xd07dff, paint: 0xffffff,
};

export class Editor extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.mapName = 'Untitled Map';

    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
    this.camera.position.set(70, 60, 90);

    const orbit = (this.orbit = new OrbitControls(this.camera, renderer.domElement));
    orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.15;
    orbit.screenSpacePanning = false;
    orbit.zoomToCursor = true;
    orbit.maxDistance = 3000;

    this.hemi = new THREE.HemisphereLight();
    this.sun = new THREE.DirectionalLight();
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.terrain = new Terrain({ size: 128, segments: 128 });
    this.scene.add(this.terrain.mesh);

    this.objectsRoot = new THREE.Group();
    this.objectsRoot.name = 'Objects';
    this.ghostRoot = new THREE.Group();
    this.overlay = new THREE.Group();
    this.scene.add(this.objectsRoot, this.ghostRoot, this.overlay);

    this._selectionBoxes = []; // one Box3Helper per selected object, pooled
    this.brushCursor = this._makeBrushCursor();
    this.overlay.add(this.brushCursor);

    const tc = (this.transform = new TransformControls(this.camera, renderer.domElement));
    tc.setSize(0.9);
    this.scene.add(tc.getHelper());
    tc.addEventListener('dragging-changed', (e) => {
      orbit.enabled = !e.value;
      if (!tc.object) return;
      if (e.value) this._beginGizmoDrag();
      else this._endGizmoDrag();
    });
    tc.addEventListener('objectChange', () => {
      this._applyGizmoDrag();
      this.emit('objectTransformed', tc.object);
    });

    // With several objects selected the gizmo drives this pivot, and every selected object follows it.
    this.pivot = new THREE.Object3D();
    this.pivot.name = 'Selection pivot';
    this.scene.add(this.pivot);

    this.history = new History(80);
    this.history.onChange = () => {
      this.emit('historyChanged');
      this.emit('changed');
    };
    this.assets = new AssetLibrary(renderer);

    this.env = { ...DEFAULT_ENV };
    this.mode = 'select'; // select | sculpt | place
    this.selection = []; // selected entities; the last one is the primary (`selected`)
    this.brush = { mode: 'raise', radius: 8, strength: 0.5, color: '#4f7a35', flattenTarget: null, flattenAuto: true };
    this.placeOptions = { randomRotation: false, scaleMin: 1, scaleMax: 1, alignToNormal: false, stamp: false };
    this.snap = { enabled: false, translate: 1, rotate: 15, scale: 0.1 };
    this._snapInvert = false;
    this._shiftHeld = false;
    this._altHeld = false;
    this.fly = { speed: 15, keys: new Set(), boost: false, looking: false, rmb: false, orbitDistance: 50 };

    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = 0.15;
    this.pointer = new THREE.Vector2();
    this._pointerInside = false;
    this._pointerDirty = false;
    this._stroke = null;
    this._ghost = null;
    this._placeSpec = null;

    // Rigged models are re-posed (idle frame + the props they hold) on the next frame after anything changes.
    this._posesDirty = true;
    for (const ev of ['sceneChanged', 'objectChanged', 'objectTransformed']) this.addEventListener(ev, () => { this._posesDirty = true; });

    this.applyEnvironment();
    this._bindEvents();
    new ResizeObserver(() => this._resize()).observe(container);
    this._resize();
    this.timer = new THREE.Timer();
    this.timer.connect(document);
    renderer.setAnimationLoop((t) => this._tick(t));
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) { this.addEventListener(type, (e) => fn(e.detail)); }

  // ---------------------------------------------------------------- environment

  applyEnvironment() {
    const env = this.env, size = this.terrain.size;
    this.scene.background = new THREE.Color(env.background);
    this.scene.fog = env.fog ? new THREE.Fog(env.background, env.fogNear, env.fogFar) : null;
    this.hemi.color.set(env.skyColor);
    this.hemi.groundColor.set(env.groundColor);
    this.hemi.intensity = env.ambientIntensity;
    this.sun.color.set(env.sunColor);
    this.sun.intensity = env.sunIntensity;
    const az = THREE.MathUtils.degToRad(env.sunAzimuth), el = THREE.MathUtils.degToRad(env.sunElevation);
    const dir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    this.sun.position.copy(dir.multiplyScalar(size));
    this.sun.target.position.set(0, 0, 0);
    this.sun.castShadow = env.shadows;
    const cam = this.sun.shadow.camera;
    const ext = size * 0.75;
    cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
    cam.near = 1; cam.far = size * 3;
    cam.updateProjectionMatrix();
    this._updateGrid();
  }

  setEnvironment(patch) {
    Object.assign(this.env, patch);
    this.applyEnvironment();
    this.emit('changed');
  }

  /** The grid is drawn on the terrain surface with the move-snap cell size. */
  _updateGrid() {
    const u = this.terrain.gridUniforms;
    u.uGridSize.value = this.snap.translate;
    u.uGridOpacity.value = this.env.showGrid ? (this.snapActive ? 0.5 : 0.22) : 0;
  }

  onTerrainResized() {
    this.applyEnvironment();
    this.emit('terrainChanged');
  }

  // ---------------------------------------------------------------- modes & tools

  setMode(mode) {
    if (this.mode === mode) return;
    if (this.mode === 'place') this._clearGhost();
    if (this._stroke) this._endStroke();
    this.mode = mode;
    this.brushCursor.visible = false;
    this._attachGizmo();
    this.emit('modeChanged', mode);
  }

  setTransformMode(m) {
    this.transform.setMode(m);
    if (this.mode !== 'select') this.setMode('select');
    this.emit('transformModeChanged', m);
  }

  setSpace(space) {
    this.transform.setSpace(space);
    this.emit('transformModeChanged', this.transform.mode);
  }

  /** Snapping is on when enabled XOR the temporary override (holding Ctrl) is active. */
  get snapActive() { return this.snap.enabled !== this._snapInvert; }

  setSnap(patch) {
    Object.assign(this.snap, patch);
    this._applySnap();
  }

  setSnapOverride(invert) {
    if (this._snapInvert === invert) return;
    this._snapInvert = invert;
    this._applySnap();
  }

  _applySnap() {
    const s = this.snap, on = this.snapActive;
    this.transform.setTranslationSnap(on ? s.translate : null);
    this.transform.setRotationSnap(on ? THREE.MathUtils.degToRad(s.rotate) : null);
    this.transform.setScaleSnap(on ? s.scale : null);
    this._updateGrid();
    if (this.mode === 'place') this._updateGhost();
    this.emit('snapChanged');
  }

  /** Round X/Z position (in the world), rotation and scale of the selected (or given) objects to the snap steps. */
  snapToGrid(objs = this.selection) {
    this.batchEdit(this.topmost(objs).filter((o) => !o.entity.attach), 'Snap', (obj) => {
      const { translate: t, rotate, scale: sc } = this.snap;
      const r = THREE.MathUtils.degToRad(rotate);
      const round = (v, step) => Math.round(v / step) * step;
      obj.rotation.set(round(obj.rotation.x, r), round(obj.rotation.y, r), round(obj.rotation.z, r));
      obj.scale.set(
        Math.max(sc, round(obj.scale.x, sc)), Math.max(sc, round(obj.scale.y, sc)), Math.max(sc, round(obj.scale.z, sc)),
      );
      const p = obj.getWorldPosition(new THREE.Vector3()), off = this._gridOffset([obj], p);
      p.x = alignToGrid(p.x, off.x, t);
      p.z = alignToGrid(p.z, off.z, t);
      obj.position.copy(obj.parent.worldToLocal(p));
    });
  }

  // ---------------------------------------------------------------- objects

  /** Top-level entities. */
  get roots() { return this.objectsRoot.children; }

  /** Every entity, parents before their children. */
  get objects() {
    const out = [];
    for (const r of this.roots) entitySubtree(r, out);
    return out;
  }

  /** In the scene (not deleted, not a placement ghost). */
  inScene(obj) { return isWithin(obj, this.objectsRoot); }

  /** The objects without those that have an ancestor among them (moving a parent moves its children). */
  topmost(objs = this.selection) {
    objs = toList(objs);
    return objs.filter((o) => !objs.some((p) => p !== o && isWithin(o, p)));
  }

  uniqueName(base, taken = new Set(this.objects.map((o) => o.name))) {
    base = base.replace(/\s\d+$/, '');
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
  }

  createEntity(spec) {
    const obj = createEntity(spec, this.assets);
    if (!spec.name) obj.name = this.uniqueName(obj.name);
    return obj;
  }

  addObject(obj, opts) {
    this.addObjects([obj], opts);
  }

  /** Add entities (with their children) at the top level, or under `obj.__home` when that is set (copies, held props). */
  addObjects(objs, { select = true, record = true } = {}) {
    if (!objs.length) return;
    const homes = objs.map((o) => {
      const home = o.__home ?? this.objectsRoot;
      delete o.__home;
      return home;
    });
    objs.forEach((o, i) => this._attach(o, homes[i]));
    if (record) {
      this.history.push({
        label: objs.length === 1 ? `Add ${objs[0].name}` : `Add ${objs.length} objects`,
        undo: () => objs.forEach((o) => this._detach(o)),
        redo: () => objs.forEach((o, i) => this._attach(o, homes[i])),
      });
    }
    if (select) this.setSelection(objs);
  }

  removeObject(obj) {
    if (obj) this.removeObjects([obj]);
  }

  /** Delete entities and everything below them. */
  removeObjects(objs) {
    objs = this.topmost(objs).filter((o) => this.inScene(o));
    if (!objs.length) return;
    // Re-inserting in ascending index order on undo puts every object back exactly where it was.
    const entries = objs.map((o) => ({ o, parent: o.parent, index: o.parent.children.indexOf(o) })).sort((a, b) => a.index - b.index);
    entries.forEach((e) => this._detach(e.o));
    this.history.push({
      label: objs.length === 1 ? `Delete ${objs[0].name}` : `Delete ${objs.length} objects`,
      undo: () => entries.forEach((e) => this._attach(e.o, e.parent, e.index)),
      redo: () => entries.forEach((e) => this._detach(e.o)),
    });
  }

  _attach(obj, parent = this.objectsRoot, index = -1) {
    parent.add(obj);
    if (index >= 0) {
      const arr = parent.children;
      arr.splice(arr.indexOf(obj), 1);
      arr.splice(Math.min(index, arr.length), 0, obj);
    }
    this.emit('sceneChanged');
  }

  _detach(obj) {
    if (this.selection.some((o) => isWithin(o, obj))) this.setSelection(this.selection.filter((o) => !isWithin(o, obj)));
    obj.removeFromParent();
    this.emit('sceneChanged');
  }

  deleteSelected() {
    this.removeObjects([...this.selection]);
  }

  duplicateSelected() {
    if (!this.selection.length) return null;
    const copies = this._cloneEntities(this.selection);
    copies.forEach((c) => { c.position.x += this.snapActive ? this.snap.translate : 1; });
    this.addObjects(copies);
    return copies[copies.length - 1];
  }

  /**
   * Copies of entities and everything below them, with new ids and unique names, not yet added to the scene. Each
   * copy's `__home` is where its original sits, so addObjects puts it next to it.
   */
  _cloneEntities(objs) {
    const taken = new Set(this.objects.map((o) => o.name));
    return this.topmost(objs).map((src) => {
      const list = entitySubtree(src).map(serializeEntity);
      const ids = new Map(list.map((d) => [d.id, uid()]));
      for (const d of list) {
        d.id = ids.get(d.id);
        d.parent = ids.get(d.parent) ?? null;
        d.name = this.uniqueName(d.name, taken);
        taken.add(d.name);
      }
      const copy = buildEntities(list, this.assets).roots[0];
      copy.entity.attach = src.entity.attach;
      copy.__home = src.parent;
      return copy;
    });
  }

  /** Push an undoable state change for an entity (before = serializeEntity() taken earlier). */
  recordState(obj, before, label = 'Edit') {
    this.recordStates([obj], [before], label);
  }

  /** One undo step for several entities; befores[i] = serializeEntity(objs[i]) taken earlier. */
  recordStates(objs, befores, label = 'Edit') {
    const afters = objs.map(serializeEntity);
    if (objs.every((o, i) => JSON.stringify(befores[i]) === JSON.stringify(afters[i]))) return;
    const apply = (states) => {
      objs.forEach((o, i) => applyEntityState(o, states[i]));
      this._statesChanged(objs);
    };
    this.history.push({
      label: objs.length === 1 ? `${label} ${objs[0].name}` : `${label} ${objs.length} objects`,
      undo: () => apply(befores),
      redo: () => apply(afters),
    });
    this._statesChanged(objs);
  }

  /** Mutate several entities with fn(obj) and record it as one undo step. */
  batchEdit(objs, label, fn) {
    objs = toList(objs);
    if (!objs.length) return;
    const befores = objs.map(serializeEntity);
    objs.forEach(fn);
    this.recordStates(objs, befores, label);
  }

  _statesChanged(objs) {
    objs.forEach((o) => this.emit('objectChanged', o));
    if (this.selection.length > 1 && !this._drag) this._attachGizmo();
  }

  // ---------------------------------------------------------------- hierarchy

  /**
   * Make objs children of `parent` (null = top level), keeping where they are in the world. A holdable prop given
   * to a character with hand sockets goes into a free hand instead, its grip on the socket (hold: false to just
   * parent it).
   */
  setParent(objs, parent, { hold = true } = {}) {
    objs = this.topmost(objs).filter((o) => this.inScene(o) && o !== parent && !(parent && isWithin(parent, o)) && parentEntity(o) !== parent);
    if (!objs.length) return;
    const rig = entityRig(parent, this.assets);
    this._restructure(objs, parent ? `Parent to ${parent.name}` : 'Unparent', (o) => {
      const prop = hold && entityProp(o, this.assets);
      o.entity.attach = null;
      (parent ?? this.objectsRoot).attach(o);
      const hand = prop && rig && this.freeHand(parent, prop.hand);
      if (hand && rig.sockets.includes(socketForHand(hand))) this._attachTo(o, socketForHand(hand), true);
    });
  }

  /** Attach a child entity to one of its parent's bones (null: back onto the parent itself) as one undo step. */
  attachTo(obj, bone, { snap = false } = {}) {
    if (!parentEntity(obj)) return;
    this._restructure([obj], bone ? `Attach to ${bone}` : 'Detach from bone', (o) => this._attachTo(o, bone, snap));
  }

  /** Put a held prop's grip back on its hand socket. */
  snapToGrip(obj) {
    this.batchEdit(obj, 'Snap grip', (o) => this._snapGrip(o));
  }

  /** Give a character a new copy of a prop asset, held in its hand. */
  holdProp(character, assetId, hand, { select = true } = {}) {
    const socket = findOwn(character, socketForHand(hand));
    if (!socket) return null;
    const prop = this.createEntity({ kind: 'asset', assetId, attach: socket.name, props: { collider: 'none' } });
    this._snapGrip(prop);
    prop.__home = socket;
    this.addObjects([prop], { select });
    return prop;
  }

  /** The rigged model that plays the player under a Player Spawn (the first one among its children), if any. */
  playerModel(spawn) {
    return childEntities(spawn).find((o) => entityRig(o, this.assets)) ?? null;
  }

  /**
   * Make a rigged asset the player under a spawn, as one undo step. A model already there is replaced and hands
   * over its children: whatever it holds goes into the new model's same socket (grip re-snapped).
   */
  setPlayerModel(spawn, assetId) {
    const old = this.playerModel(spawn);
    const model = this.createEntity({ kind: 'asset', assetId, rotation: [0, Math.PI, 0] }); // characters face +Z, spawns −Z
    if (old) {
      model.position.copy(old.position);
      model.quaternion.copy(old.quaternion);
    }
    const kids = old ? childEntities(old) : [];
    const where = (o) => ({ parent: o.parent, index: o.parent.children.indexOf(o), state: serializeEntity(o) });
    const before = kids.map(where), oldAt = old && { parent: old.parent, index: old.parent.children.indexOf(old) };
    spawn.add(model);
    model.updateMatrixWorld(true);
    for (const k of kids) {
      const socket = k.entity.attach ? findOwn(model, k.entity.attach) : null;
      if (!socket) k.entity.attach = null;
      (socket ?? model).add(k); // same local transform on the new model
      if (socket && entityProp(k, this.assets)) this._snapGrip(k);
    }
    const after = kids.map(where);
    if (old) this._detach(old);
    const swap = (list, add, remove, at) => {
      if (remove) this._detach(remove);
      if (add) this._place(add, at.parent, at.index);
      kids.forEach((k, i) => { this._place(k, list[i].parent, list[i].index); applyEntityState(k, list[i].state); });
      this.emit('sceneChanged');
    };
    const modelAt = { parent: spawn, index: spawn.children.indexOf(model) };
    this.history.push({
      label: old ? `Replace player model with ${model.name}` : `Player model ${model.name}`,
      undo: () => swap(before, old, model, oldAt),
      redo: () => swap(after, model, old, modelAt),
    });
    this.emit('sceneChanged');
    return model;
  }

  /**
   * Load a new version of an asset (a prop re-saved in tinyimgen's Prop Editor) into the library and every placed
   * copy, keeping their transforms and children. Held props that sat on their old grip are snapped onto the new
   * one; ones moved off it by hand stay where they are. Not an undo step: it's the source file that changed.
   */
  async reloadAsset(id, buffer, meta) {
    const users = this.objects.filter((o) => o.entity.kind === 'asset' && o.entity.assetId === id);
    const onGrip = new Set(users.filter((o) => {
      if (!isHandSocket(o.entity.attach)) return false;
      const t = gripTransform(o);
      return t && t.position.distanceTo(o.position) < 1e-3 && t.quaternion.angleTo(o.quaternion) < 1e-3;
    }));
    await this.assets.replace(id, buffer, meta);
    for (const o of users) {
      const old = assetModel(o);
      const model = this.assets.instantiate(id);
      o.add(model);
      if (old) {
        this._place(model, o, o.children.indexOf(old));
        o.remove(old);
      }
      refreshEntity(o);
      if (onGrip.has(o)) this._snapGrip(o);
    }
    this.emit('sceneChanged');
    this._statesChanged(users);
    return users.length;
  }

  /** Re-pose characters on the next frame (live previews of hold edits that aren't committed yet). */
  requestPose() { this._posesDirty = true; }

  _place(obj, parent, index) {
    parent.add(obj);
    const arr = parent.children;
    arr.splice(arr.indexOf(obj), 1);
    arr.splice(Math.min(index, arr.length), 0, obj);
  }

  /** The hand to put a prop in: `preferred`, unless it already holds something and the other hand doesn't. */
  freeHand(character, preferred = 'Right') {
    const holding = new Set(childEntities(character).map((c) => c.entity.attach));
    const other = preferred === 'Left' ? 'Right' : 'Left';
    return holding.has(socketForHand(preferred)) && !holding.has(socketForHand(other)) ? other : preferred;
  }

  _attachTo(obj, bone, snap) {
    const parent = parentEntity(obj), node = bone ? findOwn(parent, bone) : null;
    obj.entity.attach = node ? bone : null;
    (node ?? parent).attach(obj); // keeps its world transform
    if (node && snap) {
      this._snapGrip(obj);
      if (obj.entity.props.collider === 'box') obj.entity.props.collider = 'none'; // a held prop shouldn't block its holder
    }
  }

  _snapGrip(obj) {
    const t = gripTransform(obj);
    if (!t) return;
    obj.position.copy(t.position);
    obj.quaternion.copy(t.quaternion);
    obj.scale.setScalar(t.scale);
  }

  /** Move entities around the hierarchy as one undo step; fn(obj) re-parents each one (and may edit it). */
  _restructure(objs, label, fn) {
    const where = (o) => ({ parent: o.parent, index: o.parent.children.indexOf(o), state: serializeEntity(o) });
    const befores = objs.map(where);
    objs.forEach(fn);
    const afters = objs.map(where);
    const apply = (list) => {
      // ascending index order, so siblings land back exactly where they were
      [...objs.keys()].sort((a, b) => list[a].index - list[b].index).forEach((i) => {
        const o = objs[i], { parent, index, state } = list[i];
        this._place(o, parent, index);
        applyEntityState(o, state);
      });
      this.emit('sceneChanged');
      this._statesChanged(objs);
    };
    this.history.push({
      label: objs.length === 1 ? `${label}: ${objs[0].name}` : `${label}: ${objs.length} objects`,
      undo: () => apply(befores),
      redo: () => apply(afters),
    });
    this.emit('sceneChanged');
    this._statesChanged(objs);
  }

  /** Re-pose rigged models (first Idle frame, then the props in their hands) if anything changed since. */
  updatePoses() {
    if (!this._posesDirty) return;
    this._posesDirty = false;
    for (const o of this.objects) if (entityRig(o, this.assets)) poseCharacter(o, this.assets);
  }

  // ---------------------------------------------------------------- selection

  get selected() { return this.selection[this.selection.length - 1] ?? null; }

  isSelected(obj) { return this.selection.includes(obj); }

  select(obj) {
    this.setSelection(obj ? [obj] : []);
  }

  /** Add or remove one object from the selection (an added object becomes the primary). */
  toggleSelect(obj) {
    if (!obj) return;
    this.setSelection(this.isSelected(obj) ? this.selection.filter((o) => o !== obj) : [...this.selection, obj]);
  }

  selectAll() {
    this.setSelection(this.objects.filter(isShown));
  }

  setSelection(objs) {
    objs = [...new Set(objs.filter(Boolean))];
    const prev = this.selection;
    if (objs.length === prev.length && objs.every((o, i) => o === prev[i])) return;
    this.selection = objs;
    this._attachGizmo();
    this._updateSelectionBoxes();
    this.emit('selectionChanged', this.selected);
  }

  _attachGizmo() {
    const sel = this.selection;
    if (this.mode !== 'select' || !sel.length) this.transform.detach();
    else if (sel.length === 1) this.transform.attach(sel[0]);
    else {
      // Pivot at the base-center of the whole selection, world-aligned.
      const box = this.selectionBounds();
      this.pivot.position.set((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
      this.pivot.quaternion.identity();
      this.pivot.scale.set(1, 1, 1);
      this.pivot.updateMatrixWorld();
      this.transform.attach(this.pivot);
    }
  }

  /** World bounds of all selected (or given) objects. */
  selectionBounds(objs = this.selection) {
    const box = new THREE.Box3(), tmp = new THREE.Box3();
    for (const o of toList(objs)) box.union(entityBounds(o, tmp));
    return box;
  }

  _updateSelectionBoxes() {
    const sel = this.selection, pool = this._selectionBoxes;
    while (pool.length < sel.length) {
      const helper = new THREE.Box3Helper(new THREE.Box3(), 0xffc233);
      helper.material.depthTest = false;
      helper.material.transparent = true;
      helper.renderOrder = 999;
      this.overlay.add(helper);
      pool.push(helper);
    }
    pool.forEach((helper, i) => {
      helper.visible = i < sel.length;
      if (!helper.visible) return;
      entityBounds(sel[i], helper.box);
      helper.material.color.setHex(i === sel.length - 1 ? 0xffc233 : 0xff8a3d);
    });
  }

  /** Select objects whose bounds center falls inside a screen rectangle (client pixels). */
  selectInRect(x0, y0, x1, y1, additive) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const [minX, maxX] = [Math.min(x0, x1), Math.max(x0, x1)], [minY, maxY] = [Math.min(y0, y1), Math.max(y0, y1)];
    const v = new THREE.Vector3(), box = new THREE.Box3();
    const hits = this.objects.filter((o) => {
      if (!isShown(o)) return false;
      entityBounds(o, box).getCenter(v).project(this.camera);
      if (v.z < -1 || v.z > 1) return false; // behind the camera
      const sx = r.left + ((v.x + 1) / 2) * r.width, sy = r.top + ((1 - v.y) / 2) * r.height;
      return sx >= minX && sx <= maxX && sy >= minY && sy <= maxY;
    });
    this.setSelection(additive ? [...this.selection, ...hits] : hits);
  }

  // ---------------------------------------------------------------- gizmo drags

  _beginGizmoDrag() {
    const tc = this.transform;
    let objs = this.topmost(this.selection), duplicated = null;
    if (this._altHeld && objs.length) {
      // Alt+drag: leave the originals in place and drag copies of them instead. The copies have identical transforms,
      // so swapping the gizmo onto them mid-press keeps the drag's start state valid.
      const copies = this._cloneEntities(objs);
      const homes = copies.map((c) => c.__home);
      copies.forEach((c, i) => { delete c.__home; this._attach(c, homes[i]); });
      duplicated = { originals: objs, copies, homes };
      this.setSelection(copies);
      objs = copies;
    }
    const target = tc.object;
    const d = (this._drag = {
      target,
      objs,
      duplicated,
      befores: objs.map(serializeEntity),
      startPos: target.position.clone(),
      startInverse: target.matrixWorld.clone().invert(),
      objStarts: objs.map((o) => o.matrixWorld.clone()),
      anchorLocal: null,
      anchorWorld: null,
      // Bounds-edge grid snapping works in world X/Z, so only for top-level objects (and the multi-selection pivot).
      gridOffset: tc.mode === 'translate' && (target === this.pivot || target.parent === this.objectsRoot)
        ? this._gridOffset(objs, target.position) : null,
    });
    if (tc.mode === 'scale' && tc.axis) {
      // One-sided scaling (hold Shift): the face opposite the grabbed handle stays put.
      const box = this._boundsIn(target, objs);
      const grabbed = tc.pointStart.clone().applyQuaternion(target.getWorldQuaternion(new THREE.Quaternion()).invert());
      d.anchorLocal = new THREE.Vector3();
      for (const ax of ['x', 'y', 'z']) {
        if (tc.axis.includes(ax.toUpperCase())) d.anchorLocal[ax] = grabbed[ax] >= 0 ? box.min[ax] : box.max[ax];
      }
      d.anchorWorld = target.localToWorld(d.anchorLocal.clone());
    }
  }

  _applyGizmoDrag() {
    const d = this._drag;
    if (!d) return;
    const t = d.target;
    if (d.anchorLocal) {
      t.position.copy(d.startPos);
      if (this._shiftHeld) {
        t.updateMatrixWorld();
        const want = t.parent.worldToLocal(d.anchorWorld.clone());
        t.position.add(want.sub(t.parent.worldToLocal(t.localToWorld(d.anchorLocal.clone()))));
      }
    }
    if (d.gridOffset && this.snapActive) {
      // The gizmo snaps the pivot; shift it so the bounds edges sit on grid lines instead.
      const step = this.snap.translate;
      for (const ax of ['x', 'z']) {
        if (Math.abs(t.position[ax] - d.startPos[ax]) > 1e-9) t.position[ax] = alignToGrid(t.position[ax], d.gridOffset[ax], step);
      }
    }
    t.updateMatrixWorld();
    if (t === this.pivot) {
      const delta = new THREE.Matrix4().multiplyMatrices(t.matrixWorld, d.startInverse);
      const m = new THREE.Matrix4(), toParent = new THREE.Matrix4();
      d.objs.forEach((o, i) => {
        o.parent.updateWorldMatrix(true, false);
        toParent.copy(o.parent.matrixWorld).invert();
        m.multiplyMatrices(delta, d.objStarts[i]).premultiply(toParent).decompose(o.position, o.quaternion, o.scale);
      });
    }
  }

  _endGizmoDrag() {
    const d = this._drag;
    this._drag = null;
    if (!d) return;
    if (d.duplicated) this._finishDuplicateDrag(d);
    else this.recordStates(d.objs, d.befores, 'Transform');
    if (d.target === this.pivot) this._attachGizmo();
  }

  /** Alt+drag result: one undo step that adds the moved copies (or nothing if they never moved). */
  _finishDuplicateDrag(d) {
    const { originals, copies, homes } = d.duplicated;
    const moved = copies.some((c, i) => JSON.stringify(serializeEntity(c)) !== JSON.stringify(d.befores[i]));
    if (!moved) {
      copies.forEach((c) => { this._detach(c); disposeEntity(c); });
      this.setSelection(originals);
      return;
    }
    this.history.push({
      label: copies.length === 1 ? `Duplicate ${originals[0].name}` : `Duplicate ${copies.length} objects`,
      undo: () => { copies.forEach((c) => this._detach(c)); this.setSelection(originals.filter((o) => this.inScene(o))); },
      redo: () => { copies.forEach((c, i) => this._attach(c, homes[i])); this.setSelection(copies); },
    });
    this._statesChanged(copies);
  }

  _setShiftHeld(held) {
    if (this._shiftHeld === held) return;
    this._shiftHeld = held;
    if (this._drag?.anchorLocal) {
      this._applyGizmoDrag();
      this.emit('objectTransformed', this.transform.object);
    }
  }

  /**
   * Offset from `origin` to the min X/Z corner of the objects' world bounds, used to snap bounds edges (not pivots)
   * to the grid so objects of any size line up. Markers snap by their pivot.
   */
  _gridOffset(objs, origin) {
    const solid = toList(objs).filter((o) => o.entity?.kind !== 'marker');
    if (!solid.length) return { x: 0, z: 0 };
    const box = this.selectionBounds(solid);
    if (box.isEmpty()) return { x: 0, z: 0 };
    return { x: box.min.x - origin.x, z: box.min.z - origin.z };
  }

  /** Bounds of objs expressed in target's local space (their own parts, like entityBounds). */
  _boundsIn(target, objs) {
    const inv = target.matrixWorld.clone().invert();
    const box = new THREE.Box3(), tmp = new THREE.Box3(), m = new THREE.Matrix4();
    const visit = (o, root) => {
      if (o.userData.noBounds || (o !== root && o.entity && root.entity?.kind !== 'group')) return;
      if (o.geometry) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        box.union(tmp.copy(o.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(inv, o.matrixWorld)));
      }
      o.children.forEach((c) => visit(c, root));
    };
    objs.forEach((o) => { o.updateWorldMatrix(true, true); visit(o, o); });
    if (box.isEmpty()) box.set(new THREE.Vector3(), new THREE.Vector3());
    return box;
  }

  focus(objs = this.selection) {
    objs = toList(objs);
    const box = objs.length ? this.selectionBounds(objs) : new THREE.Box3().setFromObject(this.terrain.mesh);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, radius * 2.6);
  }

  /** Drop objects so their bounding-box bottom rests on the surface below them (children follow their parent). */
  dropToGround(objs = this.selection) {
    this.batchEdit(this.topmost(objs).filter((o) => !o.entity.attach), 'Drop', (obj) => {
      const box = entityBounds(obj);
      if (box.isEmpty()) return;
      const p = obj.getWorldPosition(new THREE.Vector3());
      this.raycaster.set(new THREE.Vector3(p.x, box.min.y + 0.01, p.z), new THREE.Vector3(0, -1, 0));
      const hit = this._firstValidHit(this.raycaster.intersectObjects([this.terrain.mesh, ...this.roots], true), false, obj);
      const groundY = hit ? hit.point.y : this.terrain.contains(p.x, p.z) ? this.terrain.getHeightAt(p.x, p.z) : 0;
      p.y += groundY - box.min.y;
      obj.position.copy(obj.parent.worldToLocal(p));
      obj.updateMatrixWorld(true);
    });
  }

  setVisible(obj, visible) {
    const before = serializeEntity(obj);
    obj.visible = visible;
    this.recordState(obj, before, visible ? 'Show' : 'Hide');
  }

  /** Remove everything and reset to a blank map. */
  clearAll() {
    this.setMode('select');
    this.select(null);
    for (const obj of [...this.roots]) {
      this.objectsRoot.remove(obj);
      disposeEntity(obj);
    }
    this.assets.clear();
    this.scripts?.clear();
    this.terrain.restore(Terrain.blankSnapshot(128, 128));
    this.terrain.material.roughness = 0.95;
    this.terrain.setFlatShading(false);
    this.env = { ...DEFAULT_ENV };
    this.mapName = 'Untitled Map';
    this.applyEnvironment();
    this.camera.position.set(70, 60, 90);
    this.orbit.target.set(0, 0, 0);
    this.history.clear();
    this.emit('sceneChanged');
    this.emit('terrainChanged');
    this.emit('envChanged');
  }

  // ---------------------------------------------------------------- terrain commands

  /** Run a terrain mutation as one undoable step. */
  terrainCommand(label, fn) {
    const before = this.terrain.snapshot();
    fn(this.terrain);
    const after = this.terrain.snapshot();
    const apply = (s) => {
      const resized = s.size !== this.terrain.size || s.segments !== this.terrain.segments;
      this.terrain.restore(s);
      if (resized) this.onTerrainResized();
      else this.emit('terrainChanged');
    };
    this.history.push({ label, undo: () => apply(before), redo: () => apply(after) });
    if (before.size !== after.size || before.segments !== after.segments) this.onTerrainResized();
    else this.emit('terrainChanged');
  }

  // ---------------------------------------------------------------- placement

  startPlacement(spec) {
    this.setMode('place');
    this._clearGhost();
    this._placeSpec = spec;
    this._spawnGhost();
    this.emit('placementChanged', spec);
  }

  cancelPlacement() {
    if (this.mode === 'place') this.setMode('select');
  }

  _spawnGhost() {
    const obj = this.createEntity(this._placeSpec);
    const o = this.placeOptions;
    this._ghostYaw = o.randomRotation ? Math.random() * Math.PI * 2 : 0;
    const s = o.scaleMin + Math.random() * Math.max(0, o.scaleMax - o.scaleMin);
    obj.scale.setScalar(s || 1);
    obj.rotation.y = this._ghostYaw;
    obj.visible = false;
    if (entityRig(obj, this.assets)) poseCharacter(obj, this.assets);
    this._ghost = obj;
    this.ghostRoot.add(obj);
    this._updateGhost();
  }

  _clearGhost() {
    if (this._ghost) {
      this.ghostRoot.remove(this._ghost);
      disposeEntity(this._ghost);
      this._ghost = null;
    }
    this._placeSpec = null;
  }

  _updateGhost() {
    const g = this._ghost;
    if (!g) return;
    const hit = this._pointerInside ? this.raycastPlacement() : null;
    if (!hit) { g.visible = false; return; }
    g.visible = true;
    const p = hit.point.clone();
    g.position.copy(p);
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this._ghostYaw);
    if (this.placeOptions.alignToNormal && hit.face) {
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n).multiply(yaw);
    } else {
      g.quaternion.copy(yaw);
    }
    if (this.snapActive) {
      const s = this.snap.translate, off = this._gridOffset([g], g.position);
      p.x = alignToGrid(p.x, off.x, s);
      p.z = alignToGrid(p.z, off.z, s);
      p.y = this.surfaceHeightAt(p.x, p.z) ?? p.y;
      g.position.copy(p);
    }
  }

  _commitPlacement(keepPlacing) {
    const g = this._ghost;
    if (!g || !g.visible) return;
    this.ghostRoot.remove(g);
    this._ghost = null;
    this.addObject(g, { select: !keepPlacing });
    if (keepPlacing) {
      this._spawnGhost();
    } else {
      this.setMode('select');
    }
  }

  // ---------------------------------------------------------------- raycasting

  _setRayFromPointer() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  /** First hit on something visible, optionally skipping editor-only helpers and anything within `exclude`. */
  _firstValidHit(hits, allowEditorOnly, exclude = null) {
    for (const h of hits) {
      if (exclude && isWithin(h.object, exclude)) continue;
      let o = h.object, ok = true;
      while (o) { if (!o.visible) { ok = false; break; } o = o.parent; }
      if (!ok) continue;
      if (!allowEditorOnly && isEditorOnly(h.object)) continue;
      return h;
    }
    return null;
  }

  raycastTerrain() {
    this._setRayFromPointer();
    return this.raycaster.intersectObject(this.terrain.mesh, false)[0] ?? null;
  }

  raycastPlacement() {
    this._setRayFromPointer();
    const hit = this._firstValidHit(this.raycaster.intersectObjects([this.terrain.mesh, ...this.roots], true), false);
    if (hit) return hit;
    const p = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p)) return { point: p, face: null, object: null };
    return null;
  }

  /** Highest surface (terrain or object) at x,z. */
  surfaceHeightAt(x, z, exclude = null) {
    this.raycaster.set(new THREE.Vector3(x, 10000, z), new THREE.Vector3(0, -1, 0));
    const hit = this._firstValidHit(this.raycaster.intersectObjects([this.terrain.mesh, ...this.roots], true), false, exclude);
    return hit ? hit.point.y : null;
  }

  /** The object under a screen point (e.g. where something was dropped). */
  pickAt(event) {
    this._updatePointer(event);
    return this.pickObject();
  }

  pickObject() {
    this._setRayFromPointer();
    const hit = this._firstValidHit(this.raycaster.intersectObjects(this.roots, true), true);
    let o = hit?.object;
    while (o && !o.entity) o = o.parent; // the innermost entity: clicking a held sword selects the sword
    return o ?? null;
  }

  // ---------------------------------------------------------------- input

  _bindEvents() {
    const el = this.renderer.domElement;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerenter', () => { this._pointerInside = true; });
    el.addEventListener('pointerleave', () => {
      this._pointerInside = false;
      this._pointerDirty = true;
      this.emit('cursor', null);
    });
    el.addEventListener('pointermove', (e) => {
      this._updatePointer(e);
      this._pointerInside = true;
      this._pointerDirty = true;
    });
    el.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    el.addEventListener('pointerup', (e) => this._onPointerUp(e));
    el.addEventListener('dblclick', () => { if (this.mode === 'select' && this.selected) this.focus(); });
    const modState = (e) => {
      this.setSnapOverride(e.ctrlKey || e.metaKey);
      this._setShiftHeld(e.shiftKey);
      this._altHeld = e.altKey;
    };
    window.addEventListener('keydown', modState);
    window.addEventListener('keyup', modState);
    window.addEventListener('blur', () => { this.setSnapOverride(false); this._setShiftHeld(false); this._altHeld = false; });
    el.addEventListener('pointerdown', modState, { capture: true }); // before TransformControls reads the press
    window.addEventListener('keyup', (e) => { if (e.key === 'Alt') e.preventDefault(); }); // keep focus off browser menus
    el.addEventListener('pointermove', modState);
    el.addEventListener('pointermove', (e) => this._updateMarquee(e));

    this._marqueeEl = document.createElement('div');
    this._marqueeEl.className = 'marquee';
    this._marqueeEl.hidden = true;
    this.container.appendChild(this._marqueeEl);

    // Fly camera: hold right mouse + WASD/QE (or arrows/PageUp/PageDown anytime). Capture phase so held-RMB
    // WASD doesn't also trigger the W/E/Q gizmo shortcuts.
    el.addEventListener('pointerdown', (e) => { if (e.button === 2) this.fly.rmb = true; });
    window.addEventListener('pointerup', (e) => { if (e.button === 2) this._endFlyLook(); });
    window.addEventListener('keydown', (e) => this._onFlyKey(e, true), { capture: true });
    window.addEventListener('keyup', (e) => this._onFlyKey(e, false), { capture: true });
    window.addEventListener('blur', () => { this.fly.keys.clear(); this._endFlyLook(); });
    el.addEventListener('wheel', (e) => {
      if (!this.fly.rmb) return;
      e.preventDefault();
      this.setFlySpeed(this.fly.speed * (e.deltaY < 0 ? 1.25 : 0.8));
    }, { passive: false });
  }

  setFlySpeed(speed) {
    this.fly.speed = THREE.MathUtils.clamp(speed, 1, 500);
    this.emit('flySpeed', this.fly.speed);
  }

  _onFlyKey(e, down) {
    if (this.paused) return;
    this.fly.boost = e.shiftKey;
    if (!down) { this.fly.keys.delete(e.code); return; }
    const dir = FLY_KEYS[e.code];
    if (!dir || e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target)) return;
    const letter = e.code.startsWith('Key');
    if (letter && !this.fly.rmb) return;
    // Arrow keys only fly when they wouldn't be scrolling/operating some focused panel control.
    if (!letter && !this.fly.rmb && !this._pointerInside && e.target !== document.body && e.target !== this.renderer.domElement) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.fly.keys.add(e.code);
    if (letter) this._beginFlyLook();
  }

  /** While flying with the right button held, orbit around a point just in front of the camera = mouse-look. */
  _beginFlyLook() {
    const f = this.fly;
    if (f.looking) return;
    f.looking = true;
    f.orbitDistance = this.camera.position.distanceTo(this.orbit.target);
    this.camera.getWorldDirection(_flyFwd);
    this.orbit.target.copy(this.camera.position).addScaledVector(_flyFwd, 0.01);
  }

  _endFlyLook() {
    const f = this.fly;
    f.rmb = false;
    for (const code of [...f.keys]) if (code.startsWith('Key')) f.keys.delete(code);
    if (!f.looking) return;
    f.looking = false;
    // Finish any damped look rotation now, or it would carry on as an orbit around the relocated pivot.
    const damping = this.orbit.enableDamping;
    this.orbit.enableDamping = false;
    this.orbit.update();
    this.orbit.enableDamping = damping;
    // Put the orbit pivot back on whatever we're looking at, so orbit/zoom feel natural again.
    this.camera.getWorldDirection(_flyFwd);
    this.raycaster.set(this.camera.position, _flyFwd);
    const hit = this._firstValidHit(this.raycaster.intersectObjects([this.terrain.mesh, ...this.roots], true), false);
    const dist = hit && hit.distance < 1000 ? hit.distance : THREE.MathUtils.clamp(f.orbitDistance, 5, 200);
    this.orbit.target.copy(this.camera.position).addScaledVector(_flyFwd, dist);
  }

  _updateFly(dt) {
    const f = this.fly;
    if (!f.keys.size) return;
    let fw = 0, rt = 0, up = 0;
    for (const code of f.keys) {
      const d = FLY_KEYS[code];
      fw += d[0]; rt += d[1]; up += d[2];
    }
    this.camera.getWorldDirection(_flyFwd);
    _flyRight.crossVectors(_flyFwd, this.camera.up).normalize();
    _flyMove.set(0, 0, 0).addScaledVector(_flyFwd, fw).addScaledVector(_flyRight, rt);
    _flyMove.y += up;
    if (_flyMove.lengthSq() === 0) return;
    _flyMove.normalize().multiplyScalar(f.speed * (f.boost ? 3 : 1) * dt);
    this.camera.position.add(_flyMove);
    this.orbit.target.add(_flyMove);
  }

  _updatePointer(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  _onPointerDown(e) {
    if (e.button !== 0) return;
    this._updatePointer(e);
    if (this.transform.dragging) return;
    if (this.mode === 'sculpt') {
      const hit = this.raycastTerrain();
      if (!hit) return;
      this.renderer.domElement.setPointerCapture(e.pointerId);
      if (this.brush.mode === 'flatten' && this.brush.flattenAuto) {
        this.brush.flattenTarget = this.terrain.getHeightAt(hit.point.x, hit.point.z);
        this.emit('brushChanged');
      }
      this._stroke = { before: this.terrain.snapshot(), changed: false };
    } else if (this.mode === 'place') {
      this._commitPlacement(e.shiftKey !== this.placeOptions.stamp);
    } else {
      this._down = { x: e.clientX, y: e.clientY, additive: e.shiftKey || e.ctrlKey || e.metaKey, marquee: false };
      this.renderer.domElement.setPointerCapture(e.pointerId);
    }
  }

  _updateMarquee(e) {
    const d = this._down;
    if (!d || this.transform.dragging) return;
    if (!d.marquee && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
    d.marquee = true;
    const r = this.container.getBoundingClientRect(), st = this._marqueeEl.style;
    st.left = `${Math.min(d.x, e.clientX) - r.left}px`;
    st.top = `${Math.min(d.y, e.clientY) - r.top}px`;
    st.width = `${Math.abs(e.clientX - d.x)}px`;
    st.height = `${Math.abs(e.clientY - d.y)}px`;
    this._marqueeEl.hidden = false;
  }

  _onPointerUp(e) {
    if (e.button !== 0) return;
    if (this._stroke) {
      this._endStroke();
      return;
    }
    if (this.mode === 'select' && this._down) {
      const d = this._down;
      this._down = null;
      this._marqueeEl.hidden = true;
      if (this.transform.dragging) return;
      if (d.marquee) {
        this.selectInRect(d.x, d.y, e.clientX, e.clientY, d.additive);
      } else {
        const hit = this.pickObject();
        if (d.additive) this.toggleSelect(hit);
        else this.select(hit);
      }
    }
  }

  _endStroke() {
    const stroke = this._stroke;
    this._stroke = null;
    if (!stroke.changed) return;
    const before = stroke.before, after = this.terrain.snapshot();
    const label = `Terrain ${this.brush.mode}`;
    this.history.push({
      label,
      undo: () => { this.terrain.restore(before); this.emit('terrainChanged'); },
      redo: () => { this.terrain.restore(after); this.emit('terrainChanged'); },
    });
    this.emit('terrainChanged');
  }

  // ---------------------------------------------------------------- loop

  _makeBrushCursor() {
    const N = 64;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const ring = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }));
    ring.renderOrder = 1000;
    ring.visible = false;
    ring.userData.N = N;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    dot.renderOrder = 1000;
    ring.add(dot);
    return ring;
  }

  _updateBrushCursor(point) {
    const c = this.brushCursor, N = c.userData.N, r = this.brush.radius;
    const pos = c.geometry.attributes.position.array;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const x = point.x + Math.cos(a) * r, z = point.z + Math.sin(a) * r;
      pos[i * 3] = x;
      pos[i * 3 + 1] = this.terrain.getHeightAt(x, z) + 0.15;
      pos[i * 3 + 2] = z;
    }
    c.geometry.attributes.position.needsUpdate = true;
    c.geometry.computeBoundingSphere();
    c.children[0].position.copy(point);
    const col = BRUSH_COLORS[this.brush.mode] ?? 0xffffff;
    c.material.color.setHex(this.brush.mode === 'paint' ? new THREE.Color(this.brush.color).getHex() : col);
    c.children[0].material.color.copy(c.material.color);
    c.visible = true;
  }

  _tick(time) {
    this.timer.update(time);
    const dt = Math.min(this.timer.getDelta(), 0.05);
    this._updateFly(dt);
    this.orbit.update();

    if (this.mode === 'sculpt') {
      const hit = this._pointerInside ? this.raycastTerrain() : null;
      if (hit) {
        if (this._stroke) {
          this.terrain.applyBrush(hit.point, this.brush, dt);
          this._stroke.changed = true;
        }
        this._updateBrushCursor(hit.point);
        if (this._pointerDirty) this.emit('cursor', hit.point);
      } else {
        this.brushCursor.visible = false;
      }
    } else if (this.mode === 'place') {
      if (this._pointerDirty) {
        this._updateGhost();
        if (this._ghost?.visible) this.emit('cursor', this._ghost.position);
      }
    } else if (this._pointerDirty && this._pointerInside) {
      const hit = this.raycastTerrain();
      this.emit('cursor', hit ? hit.point : null);
    }
    this._pointerDirty = false;

    this.updatePoses();
    if (this.selection.length) this._updateSelectionBoxes();
    this.renderer.render(this.scene, this.camera);
  }

  /** Stop drawing (and flying) while another full-screen view, like the animation editor, covers the viewport. */
  setPaused(paused) {
    this.paused = paused;
    this.fly.keys.clear();
    this.renderer.setAnimationLoop(paused ? null : (t) => this._tick(t));
  }

  _resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
