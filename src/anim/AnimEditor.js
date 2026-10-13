// The animation editor: a full-screen workspace over the map editor for the shared clip library (clips.js).
//
// Pick a clip, scrub the timeline, click a joint and rotate it with the gizmo: that keys the bone at the current
// frame (auto-key). On a clip with a base motion (a tinyimgen or Mesh2Motion clip) keys are corrections on top of it;
// on a new clip they're the pose. Keys can be dragged along the timeline, deleted, copied as whole poses, mirrored.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { h, button, toast, modal, numberInput, checkbox, select, textInput, row, section } from '../ui/dom.js';
import { BONES, mirrorName, findBones, restPositions } from './skeleton.js';
import {
  FPS, isLocomotion, createClip, duplicateClip, editState, applyEditState, frameCount, rigOf, applyPose,
  boneRotation, baseRotation, baseHips, hipsOffset, clipFromThree, restArrays, retargetFor,
} from './clips.js';
import { PACKS, loadPack, importMesh2Motion } from './mesh2motion.js';
import { tinyimgenCatalog, importTinyimgen } from '../editor/Tinyimgen.js';

const HIPS_POS = '$hips';          // the Hips position channel (bone names are the rotation channels)
const POSE_ROW = '$pose';          // the timeline's summary row
const DEG = 180 / Math.PI;
const LABEL_W = 150, RULER_H = 22, ROW_H = 20;

const frameOf = (t) => Math.round(t * FPS);
const keyId = (channel, frame) => `${channel}@${frame}`;
const parseKeyId = (id) => { const i = id.lastIndexOf('@'); return [id.slice(0, i), +id.slice(i + 1)]; };
const channelLabel = (ch) => (ch === HIPS_POS ? 'Hips position' : ch.replace(/([a-z])([A-Z])/g, '$1 $2'));

function channelKeys(clip, ch, create = false) {
  if (ch === HIPS_POS) return clip.hipKeys;
  if (!clip.keys[ch] && create) clip.keys[ch] = [];
  return clip.keys[ch] ?? [];
}

function setKey(clip, ch, frame, value) {
  const list = channelKeys(clip, ch, true), t = frame / FPS;
  const entry = ch === HIPS_POS ? { t, p: value } : { t, q: value };
  const i = list.findIndex((k) => frameOf(k.t) === frame);
  if (i >= 0) list[i] = entry;
  else { list.push(entry); list.sort((a, b) => a.t - b.t); }
}

function deleteKey(clip, ch, frame) {
  const list = channelKeys(clip, ch);
  const i = list.findIndex((k) => frameOf(k.t) === frame);
  if (i >= 0) list.splice(i, 1);
  if (ch !== HIPS_POS && !list.length) delete clip.keys[ch];
}

const allChannels = (clip) => [...BONES.filter((b) => clip.keys[b]?.length), ...(clip.hipKeys.length ? [HIPS_POS] : [])];

/** Small dropdown under an element. items: [[label, fn] | '-'] */
function popup(anchor, items) {
  document.querySelectorAll('.anim-popup').forEach((p) => p.remove());
  const r = anchor.getBoundingClientRect();
  const menu = h('div', { class: 'anim-popup menu-dd', style: { display: 'block', position: 'fixed', left: `${r.left}px`, top: `${r.bottom + 4}px` } },
    ...items.map((it) => (it === '-' ? h('hr') : h('button', { class: 'menu-item', disabled: !!it[2], onclick: () => { menu.remove(); it[1](); } }, h('span', {}, it[0])))));
  document.body.append(menu);
  const away = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', away, true); } };
  setTimeout(() => document.addEventListener('pointerdown', away, true));
  return menu;
}

export class AnimEditor {
  /** onClose({ changed }) runs when the workspace closes. */
  constructor(editor, library, { onClose } = {}) {
    this.editor = editor;
    this.library = library;
    this.onClose = onClose;
    this.isOpen = false;
    this.clip = null;
    this.time = 0;
    this.playing = false;
    this.speed = 1;
    this.bone = null;           // selected channel: a bone name
    this.sel = new Set();       // selected keys, keyId(channel, frame)
    this.undos = [];
    this.redos = [];
    this.changedSinceOpen = false;
    this.asset = null;
    this.rig = null;
    this.clipboard = null;
    this.showBones = true;
    library.addEventListener('changed', () => {
      if (!this.isOpen) return;
      if (this.clip && !library.get(this.clip.id)) this.selectClip(null);
      else { this._renderClips(); this._syncHelpers(); }
    });
  }

  // ---------------------------------------------------------------- open / close

  async open() {
    if (!this.root) this._build();
    this.root.hidden = false;
    this.isOpen = true;
    this.changedSinceOpen = false;
    this.editor.setPaused(true);
    this._resize();
    this.timer.reset?.();
    this.renderer.setAnimationLoop((t) => this._frame(t));
    this._renderClips();
    this._renderInspector();
    if (!this.asset || !this.editor.assets.get(this.asset.id)) await this._pickDefaultCharacter();
    else this._renderCharacterPicker();
    if (!this.clip && this.library.clips.length) this.selectClip(this.library.clips[0].id);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.playing = false;
    this.root.hidden = true;
    this.renderer.setAnimationLoop(null);
    this.editor.setPaused(false);
    this.onClose?.({ changed: this.changedSinceOpen });
  }

  // ---------------------------------------------------------------- DOM + scene

  _build() {
    const root = (this.root = h('div', { class: 'anim', hidden: true }));
    this.topbar = h('header', { class: 'anim-top' });
    this.clipsEl = h('aside', { class: 'anim-left' });
    this.view = h('main', { class: 'anim-view' });
    this.inspectorEl = h('aside', { class: 'anim-right' });
    this.timelineEl = h('footer', { class: 'anim-tl' });
    root.append(this.topbar, this.clipsEl, this.view, this.inspectorEl, this.timelineEl);
    document.body.append(root);

    // top bar
    this.charPicker = h('select', { class: 'anim-char', title: 'Character to preview on (every tinyimgen character shares the skeleton)' });
    this.charPicker.addEventListener('change', () => this._onCharacterPicked(this.charPicker.value));
    this.undoBtn = button('↶', () => this.undo(), { cls: 'btn-icon', title: 'Undo (Ctrl+Z)' });
    this.redoBtn = button('↷', () => this.redo(), { cls: 'btn-icon', title: 'Redo (Ctrl+Shift+Z)' });
    this.modeBtns = [['rotate', '⟳', 'Rotate the bone (E)'], ['translate', '✥', 'Move the hips (W)']].map(([m, icon, title]) => {
      const b = button(icon, () => this._setGizmoMode(m), { cls: 'btn-icon', title });
      b.mode = m;
      return b;
    });
    this.topbar.append(
      h('div', { class: 'brand' }, '🎬 ', h('span', {}, 'Animation Editor')),
      h('div', { class: 'sep' }),
      this.undoBtn, this.redoBtn,
      h('div', { class: 'sep' }),
      ...this.modeBtns,
      h('div', { class: 'sep' }),
      checkbox({ value: this.showBones, label: 'Joints', onChange: (v) => { this.showBones = v; this._syncHelpers(); } }),
      h('div', { class: 'spacer' }),
      h('span', { class: 'muted' }, 'Preview on'), this.charPicker,
      button('Done', () => this.close(), { cls: 'btn-primary', title: 'Back to the map (Esc)' }),
    );

    // timeline
    this.playBtn = button('▶', () => this.togglePlay(), { cls: 'btn-icon', title: 'Play / pause (Space)' });
    this.timeLabel = h('span', { class: 'anim-time' });
    const speed = select({ value: '1', options: [['0.25', '¼×'], ['0.5', '½×'], ['1', '1×'], ['2', '2×']], onChange: (v) => { this.speed = +v; } });
    speed.title = 'Preview speed';
    this.keyBtn = button('◆ Key', () => this.keyBone(), { cls: 'btn-sm', title: 'Key the selected bone at this frame (K)' });
    this.tlCanvas = h('canvas', { class: 'anim-tl-canvas' });
    this.tlScroll = h('div', { class: 'anim-tl-scroll' }, this.tlCanvas);
    this.timelineEl.append(
      h('div', { class: 'anim-transport' },
        button('⏮', () => this.setTime(0), { cls: 'btn-icon', title: 'First frame (Home)' }),
        button('◀◆', () => this.jumpKey(-1), { cls: 'btn-icon', title: 'Previous key (,)' }),
        this.playBtn,
        button('◆▶', () => this.jumpKey(1), { cls: 'btn-icon', title: 'Next key (.)' }),
        button('⏭', () => this.setTime(this.clip?.duration ?? 0), { cls: 'btn-icon', title: 'Last frame (End)' }),
        this.timeLabel, speed,
        h('div', { class: 'spacer' }),
        this.keyBtn,
        button('◆ Pose', () => this.keyPose(), { cls: 'btn-sm', title: 'Key every bone at this frame (Shift+K)' }),
        button('✕ Key', () => this.deleteSelectedKeys(), { cls: 'btn-sm', title: 'Delete the selected keys (Delete)' }),
      ),
      this.tlScroll,
    );
    this._bindTimeline();

    // three.js
    const renderer = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    this.view.append(renderer.domElement, this.hint = h('div', { class: 'anim-hint' }));
    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color('#1d2229');
    scene.add(new THREE.HemisphereLight('#e4ecff', '#3a3226', 1.6));
    const sun = new THREE.DirectionalLight('#fff4e6', 2.4);
    sun.position.set(2.5, 5, 3.5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 15 });
    scene.add(sun);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(5, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#2a313b', roughness: 1 }));
    ground.receiveShadow = true;
    scene.add(ground, new THREE.GridHelper(10, 20, '#46505f', '#353d49'));
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
    this.camera.position.set(2.4, 1.6, 3.4);
    this.orbit = new OrbitControls(this.camera, renderer.domElement);
    this.orbit.target.set(0, 0.9, 0);
    this.orbit.enableDamping = true;
    this.handles = new THREE.Group();
    scene.add(this.handles);

    const tc = (this.transform = new TransformControls(this.camera, renderer.domElement));
    tc.setSpace('local');
    tc.setSize(0.75);
    scene.add(tc.getHelper());
    tc.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      if (e.value) this._gizmoStart(); else this._gizmoEnd();
    });
    tc.addEventListener('objectChange', () => this._gizmoMove());

    this.timer = new THREE.Timer();
    this.timer.connect(document);
    this.raycaster = new THREE.Raycaster();
    let down = null;
    renderer.domElement.addEventListener('pointerdown', (e) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; });
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || this.transform.dragging) return;
      if (this.transform.axis) return; // released on the gizmo
      this._pick(e);
    });

    new ResizeObserver(() => this._resize()).observe(this.view);
    new ResizeObserver(() => this._drawTimeline()).observe(this.tlScroll);
    window.addEventListener('keydown', (e) => this._onKey(e), { capture: true });
  }

  _resize() {
    const w = this.view.clientWidth, hgt = this.view.clientHeight;
    if (!w || !hgt) return;
    this.renderer.setSize(w, hgt);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- character

  _rigged() {
    return this.editor.assets.list().filter((a) => a.rig && findBones(a.scene));
  }

  async _pickDefaultCharacter() {
    const ed = this.editor;
    const spawn = ed.objects.find((o) => o.entity.kind === 'marker' && o.entity.type === 'spawn' && ed.playerModel(o));
    const player = spawn && ed.assets.get(ed.playerModel(spawn).entity.assetId);
    const asset = (player && findBones(player.scene) ? player : null) ?? this._rigged()[0];
    if (asset) { this._setCharacter(asset); return; }
    this._renderCharacterPicker();
    try {
      const { characters } = await tinyimgenCatalog();
      if (characters[0]) { this._setCharacter(await importTinyimgen(ed, characters[0])); return; }
    } catch { /* tinyimgen not running */ }
    this._hint('No rigged character to preview on: start tinyimgen, or import a tinyimgen character in the Models tab.');
  }

  _renderCharacterPicker() {
    const opts = this._rigged().map((a) => h('option', { value: a.id, selected: a === this.asset }, a.name));
    this.charPicker.replaceChildren(...opts);
    tinyimgenCatalog().then(({ characters }) => {
      for (const c of characters) {
        if (this.editor.assets.findTinyimgen(c.id, 'character')) continue;
        this.charPicker.append(h('option', { value: `tiny:${c.id}` }, `${c.name} (tinyimgen)`));
      }
    }).catch(() => {});
  }

  async _onCharacterPicked(value) {
    try {
      if (value.startsWith('tiny:')) {
        const { characters } = await tinyimgenCatalog();
        const item = characters.find((c) => `tiny:${c.id}` === value);
        if (item) this._setCharacter(await importTinyimgen(this.editor, item));
      } else {
        const asset = this.editor.assets.get(value);
        if (asset) this._setCharacter(asset);
      }
    } catch (err) {
      toast(`Couldn't load that character: ${err.message}`, { type: 'error', timeout: 6000 });
    }
  }

  _setCharacter(asset) {
    const rest = rigOf(asset.scene);
    if (!rest) { toast(`${asset.name} isn't a tinyimgen skeleton`, { type: 'error' }); return; }
    if (this.model) { this.transform.detach(); this.scene.remove(this.model, this.skelHelper); }
    const model = (this.model = skeletonClone(asset.scene));
    model.traverse((o) => { if (o.isMesh) { o.castShadow = true; if (o.isSkinnedMesh) o.frustumCulled = false; } });
    this.scene.add(model);
    this.asset = asset;
    this.rig = { bones: findBones(model), restHips: rest.restHips.clone(), hipsHeight: rest.hipsHeight };
    this.skelHelper = new THREE.SkeletonHelper(model);
    this.skelHelper.material.depthTest = false;
    this.skelHelper.material.transparent = true;
    this.skelHelper.material.opacity = 0.55;
    this.skelHelper.renderOrder = 998;
    this.scene.add(this.skelHelper);
    this.handles.clear();
    for (const name of BONES) {
      const bone = this.rig.bones[name];
      if (!bone) continue;
      const finger = /(Thumb|Index|Middle|Ring|Little)/.test(name);
      const m = new THREE.Mesh(new THREE.SphereGeometry(finger ? 0.007 : 0.022, 10, 8), new THREE.MeshBasicMaterial({ color: '#9fb4d0', depthTest: false, transparent: true, opacity: 0.9 }));
      m.renderOrder = 999;
      m.userData.bone = name;
      this.handles.add(m);
    }
    const height = asset.size.y || 1.8;
    this.orbit.target.set(0, height * 0.5, 0);
    this.camera.position.set(height * 1.35, height * 0.85, height * 1.9);
    this._renderCharacterPicker();
    this._renderClips();
    this._applyPose();
    if (this.bone) this._attachGizmo();
    this._syncHelpers();
    this._hint('');
  }

  _syncHelpers() {
    if (this.skelHelper) this.skelHelper.visible = this.showBones;
    this.handles.visible = this.showBones;
    this.handles.children.forEach((m) => m.material.color.set(m.userData.bone === this.bone ? '#ffb02e' : this.clip?.keys[m.userData.bone]?.length ? '#7fd1ff' : '#9fb4d0'));
  }

  _hint(text) {
    this.hint.textContent = text;
    this.hint.hidden = !text;
  }

  // ---------------------------------------------------------------- clips list

  selectClip(id) {
    this.clip = id ? this.library.get(id) : null;
    this.sel.clear();
    this.playing = false;
    this.time = Math.min(this.time, this.clip?.duration ?? 0);
    this.setTime(this.time);
    this._renderClips();
    this._renderInspector();
    this._syncHelpers();
  }

  _renderClips() {
    if (!this.root) return;
    const actions = this.library.actions();
    const items = this.library.clips.map((c) => {
      const slot = actions.indexOf(c);
      const role = isLocomotion(c) ? `replaces ${c.name}` : slot >= 0 ? `key ${slot + 1}` : '';
      const kind = c.base ? (c.source.startsWith('mesh2motion') ? 'Mesh2Motion' : 'character') : 'keyframed';
      return h('div', { class: `anim-clip${c === this.clip ? ' active' : ''}`, onclick: () => this.selectClip(c.id), title: c.source },
        h('div', { class: 'anim-clip-name' }, h('span', {}, c.name), role ? h('span', { class: 'badge' }, role) : null),
        h('small', { class: 'muted' }, `${c.duration.toFixed(2)} s · ${c.loop ? 'loop' : 'once'} · ${kind}`));
    });
    const newBtn = button('+ New', () => popup(newBtn, [
      ['Empty clip (rest pose)', () => this._addClip(createClip({ name: 'New clip' }))],
      ['From the current pose', () => this._newFromPose(), !this.rig],
    ]), { cls: 'btn-sm' });
    const fromChar = button('Character clips ▾', () => popup(fromChar, (this.asset?.animations ?? []).length
      ? this.asset.animations.map((a) => [a.name, () => this._importCharacterClip(a)])
      : [['This character has no clips', () => {}, true]]), { cls: 'btn-sm', title: 'Import one of the preview character\'s own clips (its mocap Idle, Walk, Run…)' });
    this.clipsEl.replaceChildren(
      h('div', { class: 'panel-title' }, 'Clip library'),
      h('div', { class: 'anim-clips' }, ...(items.length ? items : [h('p', { class: 'hint' }, 'No clips yet. Make a new one, or import one below.')])),
      h('div', { class: 'btn-row' },
        newBtn,
        button('Duplicate', () => this.clip && this._addClip(duplicateClip(this.clip)), { cls: 'btn-sm' }),
        button('↑', () => this.clip && this.library.move(this.clip.id, -1), { cls: 'btn-sm', title: 'Move up (playtest key order)' }),
        button('↓', () => this.clip && this.library.move(this.clip.id, 1), { cls: 'btn-sm', title: 'Move down' }),
        button('Delete', () => this._deleteClip(), { cls: 'btn-sm btn-danger' })),
      h('div', { class: 'panel-title' }, 'Import'),
      h('div', { class: 'btn-row' }, fromChar, button('Mesh2Motion…', () => this._mesh2motionDialog(), { cls: 'btn-sm', title: '178 free (CC0) human animations, retargeted to tinyimgen\'s skeleton' })),
      h('p', { class: 'hint' }, 'In the playtest, clips named Idle, Walk, Run, WalkBackward, StrafeLeft or StrafeRight replace the character\'s own; the others play on keys 1–9 in this order.'),
    );
  }

  _addClip(clip) {
    // made on the preview character's skeleton: other characters get it fitted to theirs (clips.js retargetFor)
    if (!clip.rest && this.rig) clip.rest = restArrays(restPositions(this.rig));
    const i = this.clip ? this.library.clips.indexOf(this.clip) + 1 : this.library.clips.length;
    this.library.add(clip, i);
    this.changedSinceOpen = true;
    this.selectClip(clip.id);
    return clip;
  }

  _newFromPose() {
    const clip = createClip({ name: 'New clip' });
    for (const b of BONES) if (this.rig.bones[b]) setKey(clip, b, 0, this.rig.bones[b].quaternion.toArray());
    setKey(clip, HIPS_POS, 0, this.rig.bones.Hips.position.clone().sub(this.rig.restHips).divideScalar(this.rig.hipsHeight).toArray());
    this._addClip(clip);
  }

  _importCharacterClip(threeClip) {
    const rest = rigOf(this.asset.scene);
    const clip = clipFromThree(threeClip, rest, { source: `${this.asset.meta.tinyimgen ? 'tinyimgen' : 'character'}:${threeClip.name}` });
    this._addClip(clip);
    toast(`Imported ${clip.name}${isLocomotion(clip) ? ': it now replaces the character\'s own in the playtest' : ''}`, { type: 'ok' });
  }

  _deleteClip() {
    const clip = this.clip;
    if (!clip) return;
    modal('Delete clip', h('p', {}, `Delete “${clip.name}” from the library? This can't be undone.`), {
      actions: [{ label: 'Cancel', run: () => {} }, {
        label: 'Delete', cls: 'btn-danger', run: () => {
          const i = this.library.clips.indexOf(clip);
          this.library.remove(clip.id);
          this.undos = this.undos.filter((u) => u.clipId !== clip.id);
          this.redos = this.redos.filter((u) => u.clipId !== clip.id);
          this.changedSinceOpen = true;
          const next = this.library.clips[Math.min(i, this.library.clips.length - 1)];
          this.selectClip(next?.id ?? null);
        },
      }],
    });
  }

  _mesh2motionDialog() {
    if (!this.rig) { toast('Pick a character to preview on first', { type: 'error' }); return; }
    let pack = PACKS[0].id, filter = '';
    const list = h('div', { class: 'anim-m2m-list' });
    const status = h('p', { class: 'hint' });
    const tabs = PACKS.map((p) => button(p.label, () => { pack = p.id; render(); }, { cls: 'btn-sm' }));
    const search = textInput({ placeholder: 'Search…', onInput: (v) => { filter = v.toLowerCase(); render(); } });
    const render = async () => {
      tabs.forEach((t, i) => t.classList.toggle('active', PACKS[i].id === pack));
      list.replaceChildren();
      status.textContent = 'Loading the pack (downloaded once, ~2–6 MB)…';
      try {
        const src = await loadPack(pack);
        status.textContent = `${src.names.length} clips · click one to import it`;
        list.replaceChildren(...src.names.filter((n) => n.toLowerCase().includes(filter)).map((n) => h('button', {
          class: 'btn btn-sm', onclick: async (e) => {
            e.target.disabled = true;
            e.target.textContent = `${n}…`;
            try {
              this._addClip(await importMesh2Motion(pack, n, this.rig));
              close();
            } catch (err) {
              console.error(err);
              toast(`Import failed: ${err.message}`, { type: 'error', timeout: 6000 });
              e.target.disabled = false;
              e.target.textContent = n;
            }
          },
        }, n)));
      } catch (err) {
        status.textContent = `Couldn't load it: ${err.message}`;
      }
    };
    const close = modal('Import from Mesh2Motion', h('div', { class: 'anim-m2m' },
      h('div', { class: 'btn-row' }, ...tabs, search),
      status, list,
      h('p', { class: 'hint' }, 'Animations from Mesh2Motion (github.com/Mesh2Motion), CC0. They come in as the clip\'s base motion; your keys refine it.'),
    ));
    render();
  }

  // ---------------------------------------------------------------- inspector

  _renderInspector() {
    if (!this.root) return;
    const clip = this.clip;
    const out = [];
    if (!clip) {
      out.push(h('p', { class: 'hint' }, 'Pick a clip on the left, or make a new one.'));
    } else {
      const slot = this.library.actions().indexOf(clip);
      out.push(section('Clip', [
        row('Name', textInput({ value: clip.name, onChange: (v) => this.edit('Rename', () => { clip.name = this.library.uniqueName(v.trim() || clip.name, clip); }) })),
        row('Length (s)', numberInput({ value: clip.duration, step: 0.1, min: 0.1, max: 120, onChange: (v) => this.edit('Length', () => { clip.duration = v; }) })),
        row('Loop', checkbox({ value: clip.loop, onChange: (v) => this.edit('Loop', () => { clip.loop = v; }), label: 'Plays on repeat' })),
        row('Between keys', select({ value: clip.interp, options: [['smooth', 'Smooth'], ['linear', 'Linear']], onChange: (v) => this.edit('Interpolation', () => { clip.interp = v; }) })),
        h('p', { class: 'hint' }, isLocomotion(clip)
          ? `Replaces the character's own ${clip.name} clip in the playtest. Keep its length to keep the feet planted.`
          : slot >= 0 ? `Playtest: press ${slot + 1} to play it.` : 'Playtest: only the first 9 non-locomotion clips get a key.'),
        h('p', { class: 'hint' }, clip.base ? `Base motion: ${clip.source} (${clip.base.frames} frames). Keys adjust it.` : 'Keyframed from the rest pose.'),
        this.rig && retargetFor(clip, this.rig) ? h('p', { class: 'hint' }, 'Made on another character\'s skeleton: shown here as made. In the game it\'s fitted to each character\'s own proportions.') : null,
        h('div', { class: 'btn-row' }, button('Clear all keys', () => this.edit('Clear keys', () => { clip.keys = {}; clip.hipKeys = []; }), { cls: 'btn-sm btn-danger' })),
      ]));
      if (this.bone) {
        const isHips = this.bone === 'Hips';
        this.eulerInputs = ['x', 'y', 'z'].map((axis, i) => h('div', { class: `axis axis-${axis}` }, h('span', {}, axis.toUpperCase()), numberInput({
          value: 0, step: 1, onChange: () => this._eulerChanged(i),
        })));
        out.push(section(`Bone · ${channelLabel(this.bone)}`, [
          row('Rotation°', h('div', { class: 'vec3' }, ...this.eulerInputs)),
          h('div', { class: 'btn-row' },
            button('◆ Key (K)', () => this.keyBone(), { cls: 'btn-sm' }),
            button('Reset to base', () => this.resetBone(), { cls: 'btn-sm', title: clip.base ? 'Key no correction here: the base motion as it is' : 'Key the rest pose here' }),
            isHips ? button('◆ Key position', () => this.keyChannel(HIPS_POS), { cls: 'btn-sm' }) : null),
          h('p', { class: 'hint' }, `Drag the gizmo to pose it: that keys this frame. ${isHips ? 'W moves the hips, E rotates them.' : ''}`),
        ]));
      } else {
        out.push(h('p', { class: 'hint' }, 'Click a joint (or a timeline row) to pose that bone.'));
      }
      out.push(section('Pose', [
        h('div', { class: 'btn-row' },
          button('◆ Key whole pose', () => this.keyPose(), { cls: 'btn-sm', title: 'Shift+K' }),
          button('Mirror', () => this.mirrorPose(), { cls: 'btn-sm', title: 'Swap left and right at this frame (M)' })),
        h('div', { class: 'btn-row' },
          button('Copy pose', () => this.copyPose(), { cls: 'btn-sm', title: 'Ctrl+C' }),
          button('Paste pose', () => this.pastePose(), { cls: 'btn-sm', title: 'Ctrl+V', disabled: !this.clipboard })),
      ]));
    }
    out.push(section('Keys', h('table', { class: 'keys' }, ...[
      ['Click joint', 'Select bone'], ['E / W', 'Rotate / move (hips)'], ['K / Shift+K', 'Key bone / whole pose'],
      ['Space', 'Play / pause'], ['← →', 'Previous / next frame'], [', .', 'Previous / next key'], ['Delete', 'Delete selected keys'],
      ['M', 'Mirror pose'], ['Ctrl+C / Ctrl+V', 'Copy / paste pose'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['Esc', 'Deselect, then close'],
    ].map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d)))), { open: false }));
    this.inspectorEl.replaceChildren(h('div', { class: 'panel-title' }, 'Inspector'), ...out);
    this._syncEuler(true);
  }

  _syncEuler(force = false) {
    if (!this.eulerInputs || !this.bone || !this.rig?.bones[this.bone] || (!force && this.playing)) return;
    const e = new THREE.Euler().setFromQuaternion(this.rig.bones[this.bone].quaternion);
    this.eulerInputs.forEach((d, i) => d.querySelector('input').setValue(+(e[['x', 'y', 'z'][i]] * DEG).toFixed(1)));
  }

  _eulerChanged() {
    if (!this.clip || !this.bone) return;
    const [x, y, z] = this.eulerInputs.map((d) => (parseFloat(d.querySelector('input').value) || 0) / DEG);
    this._snapTime();
    this.rig.bones[this.bone].quaternion.setFromEuler(new THREE.Euler(x, y, z));
    this.edit(`Rotate ${this.bone}`, () => this._keyFromModel(this.bone));
  }

  // ---------------------------------------------------------------- editing

  /** One undoable edit of the current clip. */
  edit(label, fn) {
    const clip = this.clip;
    if (!clip) return;
    const before = editState(clip);
    fn();
    this._commit(label, clip, before);
  }

  _commit(label, clip, before) {
    const after = editState(clip);
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    this.undos.push({ label, clipId: clip.id, before, after });
    if (this.undos.length > 200) this.undos.shift();
    this.redos = [];
    this._afterEdit();
  }

  _afterEdit() {
    this.changedSinceOpen = true;
    this.library.changed();
    this._applyPose();
    this._renderInspector();
    this._drawTimeline();
    this._syncHelpers();
    this._syncUndo();
  }

  undo() { this._step(this.undos, this.redos, 'before'); }
  redo() { this._step(this.redos, this.undos, 'after'); }

  _step(from, to, which) {
    const u = from.pop();
    if (!u) return;
    const clip = this.library.get(u.clipId);
    if (!clip) return;
    applyEditState(clip, u[which]);
    to.push(u);
    if (clip !== this.clip) this.selectClip(clip.id);
    this.sel.clear();
    this._afterEdit();
    toast(`${which === 'before' ? 'Undid' : 'Redid'} ${u.label}`, { timeout: 1200 });
  }

  _syncUndo() {
    this.undoBtn.disabled = !this.undos.length;
    this.redoBtn.disabled = !this.redos.length;
    this.undoBtn.title = this.undos.length ? `Undo ${this.undos.at(-1).label} (Ctrl+Z)` : 'Undo';
    this.redoBtn.title = this.redos.length ? `Redo ${this.redos.at(-1).label} (Ctrl+Shift+Z)` : 'Redo';
  }

  _snapTime() {
    if (!this.clip) return;
    this.time = Math.min(frameOf(this.time), this._lastFrame()) / FPS;
    this._applyPose();
  }

  _lastFrame() { return this.clip ? frameCount(this.clip) - 1 : 0; }

  /** Key a channel from the model as it's posed now (bone rotation, or the Hips position for HIPS_POS). */
  _keyFromModel(ch) {
    const clip = this.clip, frame = frameOf(this.time), t = frame / FPS;
    if (ch === HIPS_POS) {
      const p = this.rig.bones.Hips.position.clone().sub(this.rig.restHips).divideScalar(this.rig.hipsHeight).sub(baseHips(clip, t));
      setKey(clip, HIPS_POS, frame, p.toArray());
    } else {
      const off = this.rig.bones[ch].quaternion.clone().multiply(baseRotation(clip, ch, t).invert()).normalize();
      setKey(clip, ch, frame, off.toArray());
    }
  }

  keyChannel(ch) {
    if (!this.clip || !this.rig) return;
    this._snapTime();
    this.edit(`Key ${channelLabel(ch)}`, () => this._keyFromModel(ch));
  }

  keyBone() { if (this.bone) this.keyChannel(this.bone); else toast('Select a bone first (click a joint)'); }

  keyPose() {
    if (!this.clip || !this.rig) return;
    this._snapTime();
    this.edit('Key pose', () => { for (const b of BONES) if (this.rig.bones[b]) this._keyFromModel(b); this._keyFromModel(HIPS_POS); });
  }

  resetBone() {
    if (!this.clip || !this.bone) return;
    this._snapTime();
    const frame = frameOf(this.time);
    this.edit(`Reset ${this.bone}`, () => {
      setKey(this.clip, this.bone, frame, [0, 0, 0, 1]);
      if (this.bone === 'Hips') setKey(this.clip, HIPS_POS, frame, [0, 0, 0]);
    });
  }

  deleteSelectedKeys() {
    if (!this.clip || !this.sel.size) {
      // nothing selected: the selected bone's key on this frame
      const frame = frameOf(this.time);
      if (this.clip && this.bone && channelKeys(this.clip, this.bone).some((k) => frameOf(k.t) === frame)) {
        this.edit('Delete key', () => deleteKey(this.clip, this.bone, frame));
      }
      return;
    }
    const ids = [...this.sel];
    this.sel.clear();
    this.edit(ids.length === 1 ? 'Delete key' : `Delete ${ids.length} keys`, () => ids.forEach((id) => deleteKey(this.clip, ...parseKeyId(id))));
  }

  /** The pose shown now: final local rotations and the Hips offset. */
  _currentPose() {
    const rot = {};
    for (const b of BONES) if (this.rig.bones[b]) rot[b] = this.rig.bones[b].quaternion.toArray();
    return { rot, hips: this.rig.bones.Hips.position.clone().sub(this.rig.restHips).divideScalar(this.rig.hipsHeight).toArray() };
  }

  _keyPoseValues(label, pose) {
    this._snapTime();
    const frame = frameOf(this.time), t = frame / FPS, clip = this.clip;
    this.edit(label, () => {
      for (const [b, q] of Object.entries(pose.rot)) {
        const off = new THREE.Quaternion().fromArray(q).multiply(baseRotation(clip, b, t).invert()).normalize();
        setKey(clip, b, frame, off.toArray());
      }
      setKey(clip, HIPS_POS, frame, new THREE.Vector3().fromArray(pose.hips).sub(baseHips(clip, t)).toArray());
    });
  }

  copyPose() {
    if (!this.rig) return;
    this.clipboard = this._currentPose();
    toast('Pose copied', { timeout: 1200 });
    this._renderInspector();
  }

  pastePose() {
    if (this.clip && this.clipboard) this._keyPoseValues('Paste pose', this.clipboard);
  }

  mirrorPose() {
    if (!this.clip || !this.rig) return;
    const pose = this._currentPose(), rot = {};
    // Reflect across the character's left/right plane: swap sides, and (x, y, z, w) -> (x, -y, -z, w), which is
    // exact here because every bone's rest frame is the world's (tinyimgen's identity rest rotations).
    for (const b of Object.keys(pose.rot)) {
      const [x, y, z, w] = pose.rot[mirrorName(b)] ?? pose.rot[b];
      rot[b] = [x, -y, -z, w];
    }
    this._keyPoseValues('Mirror pose', { rot, hips: [-pose.hips[0], pose.hips[1], pose.hips[2]] });
  }

  // ---------------------------------------------------------------- gizmo + picking

  _setGizmoMode(mode) {
    if (mode === 'translate' && this.bone !== 'Hips') { toast('Only the hips move; other bones rotate'); return; }
    this.transform.setMode(mode);
    this.modeBtns.forEach((b) => b.classList.toggle('active', b.mode === mode));
  }

  selectBone(name) {
    this.bone = name && this.rig?.bones[name] ? name : null;
    if (this.bone !== 'Hips' && this.transform.mode === 'translate') this._setGizmoMode('rotate');
    this._attachGizmo();
    this._syncHelpers();
    this._renderInspector();
    this._drawTimeline();
  }

  _attachGizmo() {
    if (this.bone && this.clip && this.rig) this.transform.attach(this.rig.bones[this.bone]);
    else this.transform.detach();
    this.modeBtns.forEach((b) => b.classList.toggle('active', b.mode === this.transform.mode));
  }

  _pick(e) {
    if (!this.showBones || !this.rig) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(p, this.camera);
    // nearest handle to the ray within a few pixels (the spheres are tiny, fingers especially)
    let best = null, bestD = Infinity;
    const v = new THREE.Vector3();
    for (const m of this.handles.children) {
      m.getWorldPosition(v);
      const screen = v.clone().project(this.camera);
      const d = Math.hypot((screen.x - p.x) * r.width / 2, (screen.y - p.y) * r.height / 2);
      if (d < 12 && d < bestD) { best = m; bestD = d; }
    }
    this.selectBone(best?.userData.bone ?? null);
  }

  _gizmoStart() {
    if (!this.clip) return;
    this.playing = false;
    this._snapTime();
    this._drag = { before: editState(this.clip) };
  }

  _gizmoMove() {
    if (!this._drag || !this.clip || !this.bone) return;
    this._keyFromModel(this.transform.mode === 'translate' ? HIPS_POS : this.bone);
    this._drawTimeline();
    this._syncEuler(true);
  }

  _gizmoEnd() {
    if (!this._drag) return;
    const { before } = this._drag;
    this._drag = null;
    this._commit(this.transform.mode === 'translate' ? 'Move hips' : `Rotate ${this.bone}`, this.clip, before);
  }

  // ---------------------------------------------------------------- time

  togglePlay() {
    if (!this.clip) return;
    if (!this.playing && !this.clip.loop && this.time >= this.clip.duration - 1e-6) this.time = 0;
    this.playing = !this.playing;
    if (!this.playing) this._snapTime();
    this._syncEuler(true);
  }

  setTime(t) {
    this.playing = false;
    this.time = Math.max(0, Math.min(t, this.clip ? this._lastFrame() / FPS : 0));
    this._snapTime();
    this._drawTimeline();
    this._syncEuler(true);
  }

  stepFrame(d) { this.setTime((frameOf(this.time) + d) / FPS); }

  jumpKey(dir) {
    if (!this.clip) return;
    const chans = this.bone ? [this.bone, ...(this.bone === 'Hips' ? [HIPS_POS] : [])] : allChannels(this.clip);
    const frames = [...new Set(chans.flatMap((c) => channelKeys(this.clip, c).map((k) => frameOf(k.t))))].sort((a, b) => a - b);
    const now = frameOf(this.time);
    const f = dir > 0 ? frames.find((x) => x > now) : frames.reverse().find((x) => x < now);
    if (f !== undefined) this.setTime(f / FPS);
  }

  _applyPose() {
    if (!this.rig) return;
    if (this.clip) applyPose(this.clip, this.time, this.rig);
    else {
      for (const b of Object.values(this.rig.bones)) b.quaternion.identity();
      this.rig.bones.Hips.position.copy(this.rig.restHips);
    }
  }

  _frame(now) {
    this.timer.update(now);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    if (this.playing && this.clip) {
      this.time += dt * this.speed;
      if (this.clip.loop) this.time %= this.clip.duration;
      else if (this.time >= this.clip.duration) { this.time = this.clip.duration; this.playing = false; }
    }
    if (!this._drag) this._applyPose();
    if (this.rig) {
      this.model.updateMatrixWorld(true);
      for (const m of this.handles.children) this.rig.bones[m.userData.bone].getWorldPosition(m.position);
    }
    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
    const frame = frameOf(this.time);
    this.playBtn.textContent = this.playing ? '❚❚' : '▶';
    this.timeLabel.textContent = this.clip ? `${this.time.toFixed(2)} s · frame ${frame} / ${this._lastFrame()}` : '';
    if (this.playing) this._drawTimeline();
  }

  // ---------------------------------------------------------------- timeline

  _rows() {
    if (!this.clip) return [];
    const rows = [{ id: POSE_ROW, label: 'Pose (all keys)' }];
    const chans = new Set(allChannels(this.clip));
    if (this.bone) { chans.add(this.bone); if (this.bone === 'Hips') chans.add(HIPS_POS); }
    for (const b of BONES) if (chans.has(b)) rows.push({ id: b, label: channelLabel(b) });
    if (chans.has(HIPS_POS)) rows.push({ id: HIPS_POS, label: 'Hips position' });
    return rows;
  }

  _geom() {
    const w = this.tlScroll.clientWidth;
    const last = Math.max(1, frameCount(this.clip) - (this.clip.loop ? 0 : 1)); // a loop also shows the wrap point
    const pf = (w - LABEL_W - 24) / last;
    return { w, last, pf, x: (f) => LABEL_W + 12 + f * pf, f: (x) => Math.round((x - LABEL_W - 12) / pf) };
  }

  _drawTimeline() {
    if (!this.tlCanvas || !this.isOpen) return;
    const c = this.tlCanvas, dpr = window.devicePixelRatio || 1;
    const rows = this._rows();
    const w = this.tlScroll.clientWidth, hgt = Math.max(this.tlScroll.clientHeight, RULER_H + rows.length * ROW_H + 4);
    if (c.width !== w * dpr || c.height !== hgt * dpr) { c.width = w * dpr; c.height = hgt * dpr; c.style.width = `${w}px`; c.style.height = `${hgt}px`; }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#181c22';
    g.fillRect(0, 0, w, hgt);
    if (!this.clip) {
      g.fillStyle = '#8a93a1';
      g.font = '12px system-ui';
      g.fillText('No clip selected', 12, 20);
      return;
    }
    const G = this._geom(), clip = this.clip;
    // ruler
    g.fillStyle = '#1f242c';
    g.fillRect(0, 0, w, RULER_H);
    g.font = '11px system-ui';
    const every = G.pf > 14 ? 1 : G.pf > 6 ? 5 : 10;
    for (let f = 0; f <= G.last; f++) {
      const x = G.x(f), major = f % FPS === 0 || f % 15 === 0;
      if (f % every && !major) continue;
      g.strokeStyle = major ? '#4a5362' : '#323945';
      g.beginPath(); g.moveTo(x + 0.5, major ? 6 : 14); g.lineTo(x + 0.5, hgt); g.stroke();
      if (major) { g.fillStyle = '#8a93a1'; g.fillText(`${(f / FPS).toFixed(1)}s`, x + 3, 12); }
    }
    // end of the clip (a loop wraps here)
    const xe = G.x(G.last);
    g.fillStyle = '#ffffff10';
    g.fillRect(xe, RULER_H, w - xe, hgt - RULER_H);
    // rows
    rows.forEach((r, i) => {
      const y = RULER_H + i * ROW_H;
      const selected = r.id === this.bone || (r.id === HIPS_POS && this.bone === 'Hips');
      g.fillStyle = selected ? '#2a3a52' : i % 2 ? '#1b2027' : '#1d222a';
      g.fillRect(0, y, w, ROW_H);
      if (r.id === POSE_ROW && clip.base) {
        g.fillStyle = '#4f9cff22';
        g.fillRect(G.x(0), y + 6, G.x(G.last) - G.x(0), ROW_H - 12);
      }
      g.fillStyle = selected ? '#ffffff' : '#b9c2cf';
      g.fillText(r.label, 10, y + 14);
      const frames = r.id === POSE_ROW
        ? [...new Set(allChannels(clip).flatMap((ch) => channelKeys(clip, ch).map((k) => frameOf(k.t))))]
        : channelKeys(clip, r.id).map((k) => frameOf(k.t));
      for (const f of frames) {
        const sel = r.id === POSE_ROW
          ? allChannels(clip).some((ch) => this.sel.has(keyId(ch, f)))
          : this.sel.has(keyId(r.id, f));
        const x = G.x(f), cy = y + ROW_H / 2, s = r.id === POSE_ROW ? 5 : 4.5;
        g.fillStyle = sel ? '#ffb02e' : f > G.last ? '#5d6470' : r.id === POSE_ROW ? '#e8edf3' : '#7fd1ff';
        g.beginPath(); g.moveTo(x, cy - s); g.lineTo(x + s, cy); g.lineTo(x, cy + s); g.lineTo(x - s, cy); g.closePath(); g.fill();
      }
    });
    g.fillStyle = '#ffffff14';
    g.fillRect(LABEL_W - 1, 0, 1, hgt);
    // playhead
    const xp = G.x(this.time * FPS);
    g.strokeStyle = '#ff5d5d';
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(xp, 0); g.lineTo(xp, hgt); g.stroke();
    g.lineWidth = 1;
  }

  _bindTimeline() {
    const c = this.tlCanvas;
    let drag = null;
    const hit = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('pointerdown', (e) => {
      if (!this.clip || e.button !== 0) return;
      const { x, y } = hit(e), G = this._geom(), rows = this._rows();
      c.setPointerCapture(e.pointerId);
      if (y < RULER_H) { drag = { mode: 'scrub' }; this.setTime(Math.max(0, G.f(x)) / FPS); return; }
      const row = rows[Math.floor((y - RULER_H) / ROW_H)];
      if (!row) return;
      if (x < LABEL_W) { if (row.id !== POSE_ROW) this.selectBone(row.id === HIPS_POS ? 'Hips' : row.id); return; }
      // a key under the pointer?
      const chans = row.id === POSE_ROW ? allChannels(this.clip) : [row.id];
      const near = [...new Set(chans.flatMap((ch) => channelKeys(this.clip, ch).map((k) => frameOf(k.t))))].find((f) => Math.abs(G.x(f) - x) <= 6);
      if (near !== undefined) {
        const ids = chans.filter((ch) => channelKeys(this.clip, ch).some((k) => frameOf(k.t) === near)).map((ch) => keyId(ch, near));
        const already = ids.every((id) => this.sel.has(id));
        if (e.shiftKey) ids.forEach((id) => (already ? this.sel.delete(id) : this.sel.add(id)));
        else if (!already) { this.sel.clear(); ids.forEach((id) => this.sel.add(id)); }
        drag = { mode: 'move', x0: x, before: editState(this.clip), ids: [...this.sel], moved: 0 };
        this.setTime(near / FPS);
        return;
      }
      if (row.id !== POSE_ROW) this.selectBone(row.id === HIPS_POS ? 'Hips' : row.id);
      if (!e.shiftKey) this.sel.clear();
      drag = { mode: 'scrub' };
      this.setTime(Math.max(0, G.f(x)) / FPS);
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const { x } = hit(e), G = this._geom();
      if (drag.mode === 'scrub') { this.setTime(Math.max(0, G.f(x)) / FPS); return; }
      const d = Math.round((x - drag.x0) / G.pf);
      if (d === drag.moved) return;
      // move the selected keys by d frames from where they started (keys they land on are replaced)
      applyEditState(this.clip, drag.before);
      const moved = drag.ids.map((id) => {
        const [ch, f] = parseKeyId(id);
        const k = channelKeys(this.clip, ch).find((k) => frameOf(k.t) === f);
        return k && { ch, f, value: k.q ?? k.p };
      }).filter(Boolean);
      if (moved.some((m) => m.f + d < 0)) return;
      moved.forEach((m) => deleteKey(this.clip, m.ch, m.f));
      moved.forEach((m) => setKey(this.clip, m.ch, m.f + d, m.value));
      drag.moved = d;
      this.sel = new Set(moved.map((m) => keyId(m.ch, m.f + d)));
      this.time = Math.max(0, Math.min(...moved.map((m) => m.f + d))) / FPS;
      this._applyPose();
      this._drawTimeline();
    });
    const end = () => {
      if (drag?.mode === 'move' && drag.moved) this._commit(`Move ${drag.ids.length === 1 ? 'key' : `${drag.ids.length} keys`}`, this.clip, drag.before);
      drag = null;
      this._drawTimeline();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------- keyboard

  _onKey(e) {
    if (!this.isOpen) return;
    e.stopPropagation(); // the map editor's shortcuts sleep while this is open
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { if (e.key === 'Escape') e.target.blur(); return; }
    if (document.querySelector('.modal-backdrop')) return;
    const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    const handled = () => e.preventDefault();
    if (ctrl) {
      if (k === 'z' && !e.shiftKey) { this.undo(); handled(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { this.redo(); handled(); }
      else if (k === 'c') { this.copyPose(); handled(); }
      else if (k === 'v') { this.pastePose(); handled(); }
      return;
    }
    switch (k) {
      case ' ': this.togglePlay(); handled(); break;
      case 'k': if (e.shiftKey) this.keyPose(); else this.keyBone(); break;
      case 'e': this._setGizmoMode('rotate'); break;
      case 'w': this._setGizmoMode('translate'); break;
      case 'm': this.mirrorPose(); break;
      case 'delete': case 'backspace': this.deleteSelectedKeys(); handled(); break;
      case 'arrowleft': this.stepFrame(-1); handled(); break;
      case 'arrowright': this.stepFrame(1); handled(); break;
      case ',': this.jumpKey(-1); break;
      case '.': this.jumpKey(1); break;
      case 'home': this.setTime(0); break;
      case 'end': this.setTime(this.clip?.duration ?? 0); break;
      case 'escape':
        if (this.sel.size) { this.sel.clear(); this._drawTimeline(); }
        else if (this.bone) this.selectBone(null);
        else this.close();
        break;
    }
  }
}
