import * as THREE from 'three';
import { h, row, section, numberInput, slider, vec3Input, colorInput, checkbox, select, textInput, button, toast } from './dom.js';
import { PRIMITIVES } from '../editor/Primitives.js';
import { MARKERS } from '../editor/Markers.js';
import {
  serializeEntity, refreshEntity, entityLabel, entityIcon, COLLIDERS, parentEntity, childEntities, entitySubtree,
} from '../editor/Entities.js';
import { entityRig, entityProp, isHandSocket, socketForHand, holdData } from '../editor/Rig.js';
import { FINGERS, curlValue } from '../runtime/props.js';
import { DEFAULT_FINGERS } from '../runtime/hold.js';
import { tinyimgenCatalog, importTinyimgen } from '../editor/Tinyimgen.js';
import CONTROLLER_SOURCE from '../runtime/PlayerController.script.js?raw';
import { TEMPLATES } from '../editor/Scripts.js';

const DEG = THREE.MathUtils.RAD2DEG, RAD = THREE.MathUtils.DEG2RAD;

export class Inspector {
  constructor(root, editor) {
    this.root = root;
    this.editor = editor;
    this._before = null;
    this._selfCommit = false;
    this.fields = {};
    editor.on('selectionChanged', () => { this._before = null; this.render(); });
    editor.on('objectChanged', (obj) => { if (editor.isSelected(obj) && !this._selfCommit) this._renderSoon(); });
    editor.on('objectTransformed', (obj) => { if (obj === editor.selected) this.syncTransform(); });
    editor.on('envChanged', () => { if (!editor.selected) this.render(); });
    // children added or removed (e.g. the spawn's player model) change what the selection's sections show
    editor.on('sceneChanged', () => { if (!this._selfCommit) this._renderSoon(); });
    editor.on('terrainChanged', () => { if (!editor.selected) this.render(); });
    editor.on('scriptsChanged', () => { if (editor.selected) this._renderSoon(); });
    this.render();
  }

  render() {
    this.root.replaceChildren();
    this.fields = {};
    const obj = this.editor.selected;
    if (this.editor.selection.length > 1) this.renderMulti();
    else if (obj) this.renderEntity(obj);
    else this.renderScene();
  }

  /** Coalesce bursts (e.g. one objectChanged per object in a multi-edit) into one render. */
  _renderSoon() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    queueMicrotask(() => { this._renderQueued = false; this.render(); });
  }

  // ------------------------------------------------------------------ multi-selection

  renderMulti() {
    const ed = this.editor, objs = [...ed.selection];
    const batch = (label, fn) => {
      this._selfCommit = true;
      ed.batchEdit(objs, label, (o) => { fn(o.entity, o); refreshEntity(o); });
      this._selfCommit = false;
    };
    const common = (get) => { const v = get(objs[0]); return objs.every((o) => get(o) === v) ? v : undefined; };

    this.root.append(h('div', { class: 'insp-head' },
      h('span', { class: 'insp-icon' }, '▣'),
      h('div', { class: 'insp-title' },
        h('b', {}, `${objs.length} objects selected`),
        h('small', {}, 'Gizmo moves / rotates / scales them together · Shift+click to add or remove')),
    ));

    this.root.append(section('Selection', [
      h('div', { class: 'muted', style: 'max-height: 120px; overflow: auto; font-size: 12px' },
        ...objs.map((o) => h('div', {}, `${entityIcon(o)} ${o.name}`))),
      h('div', { class: 'btn-row' },
        button('Drop to ground', () => ed.dropToGround(), { title: 'G' }),
        button('Snap to grid', () => ed.snapToGrid(), { title: 'Shift+S' }),
        button('Reset rot', () => batch('Reset rotation', (_, o) => o.rotation.set(0, 0, 0))),
        button('Focus', () => ed.focus(), { title: 'F' }),
      ),
      h('div', { class: 'btn-row' },
        button('Duplicate', () => ed.duplicateSelected(), { title: 'Ctrl+D' }),
        button('Delete', () => ed.deleteSelected(), { cls: 'btn-danger', title: 'Delete' }),
      ),
    ]));

    const prims = objs.filter((o) => o.entity.kind === 'primitive');
    if (prims.length) {
      const color = common((o) => o.entity.material?.color) ?? prims[0].entity.material.color;
      this.root.append(section(`Material (${prims.length} primitive${prims.length === 1 ? '' : 's'})`, [
        row('Color', colorInput({
          value: color,
          onInput: (v) => prims.forEach((o) => { o.material.color.set(v); }),
          onChange: (v) => batch('Color', (en) => { if (en.material) en.material.color = v; }),
        })),
      ]));
    }

    const collider = common((o) => o.entity.props.collider);
    const isStatic = common((o) => o.entity.props.isStatic);
    this.root.append(section('Game data', [
      row('Collider', select({
        value: collider ?? '',
        options: [...(collider === undefined ? [['', '— mixed —']] : []), ...COLLIDERS.map((c) => [c, c])],
        onChange: (v) => { if (v) batch('Collider', (en) => { en.props.collider = v; }); },
      })),
      row('Static', checkbox({ value: isStatic ?? false, onChange: (v) => batch('Static', (en) => { en.props.isStatic = v; }), label: isStatic === undefined ? 'Does not move (mixed)' : 'Does not move' })),
      row('Add tag', textInput({
        value: '', placeholder: 'tag added to all',
        onChange: (v) => {
          const tag = v.trim();
          if (tag) batch('Tag', (en) => {
            const tags = en.props.tags.split(',').map((t) => t.trim()).filter(Boolean);
            if (!tags.includes(tag)) en.props.tags = [...tags, tag].join(', ');
          });
        },
      })),
    ]));
  }

  /** Apply a mutation to the selected entity; commit=true records one undo step. */
  edit(obj, mutate, commit, { refresh = true } = {}) {
    if (!this._before || this._beforeObj !== obj) {
      this._before = serializeEntity(obj);
      this._beforeObj = obj;
    }
    mutate(obj.entity);
    if (refresh) refreshEntity(obj);
    this.editor.requestPose();
    if (commit) {
      const before = this._before;
      this._before = null;
      this._selfCommit = true;
      this.editor.recordState(obj, before, 'Edit');
      this._selfCommit = false;
    }
  }

  syncTransform() {
    const obj = this.editor.selected, f = this.fields;
    if (!obj || !f.position) return;
    f.position.setValue(obj.position.toArray());
    f.rotation.setValue([obj.rotation.x * DEG, obj.rotation.y * DEG, obj.rotation.z * DEG]);
    f.scale.setValue(obj.scale.toArray());
    f.uniform.setValue(obj.scale.x);
    f.height?.setValue(this._assetHeight(obj));
  }

  _assetHeight(obj) {
    const asset = this.editor.assets.get(obj.entity.assetId);
    return asset ? asset.size.y * obj.scale.y : 0;
  }

  // ------------------------------------------------------------------ entity

  renderEntity(obj) {
    const e = obj.entity, ed = this.editor;
    const bind = (mutate, opts) => [(v) => this.edit(obj, (en) => mutate(en, v), false, opts), (v) => this.edit(obj, (en) => mutate(en, v), true, opts)];

    // Header
    const [nameIn, nameCh] = bind((_, v) => { obj.name = v; }, { refresh: false });
    this.root.append(h('div', { class: 'insp-head' },
      h('span', { class: 'insp-icon' }, entityIcon(obj)),
      h('div', { class: 'insp-title' },
        textInput({ value: obj.name, onInput: nameIn, onChange: (v) => { nameCh(v); ed.emit('sceneChanged'); } }),
        h('small', {}, entityLabel(obj), e.kind === 'asset' ? ` · ${ed.assets.get(e.assetId)?.fileName ?? ''}` : '')),
    ));

    this.root.append(this._hierarchySection(obj));

    // Transform
    const f = this.fields;
    const tf = (fn) => bind((_, v) => fn(v), { refresh: false });
    const [pIn, pCh] = tf((v) => obj.position.fromArray(v));
    const [rIn, rCh] = tf((v) => obj.rotation.set(v[0] * RAD, v[1] * RAD, v[2] * RAD));
    const [sIn, sCh] = tf((v) => obj.scale.fromArray(v));
    const [uIn, uCh] = tf((v) => { obj.scale.setScalar(v); });
    const afterUniform = (fn) => (v) => { fn(v); f.scale.setValue(obj.scale.toArray()); f.height?.setValue(this._assetHeight(obj)); };
    f.position = vec3Input({ value: obj.position.toArray(), step: 0.1, onInput: pIn, onChange: pCh });
    f.rotation = vec3Input({ value: [obj.rotation.x * DEG, obj.rotation.y * DEG, obj.rotation.z * DEG], step: 1, onInput: rIn, onChange: rCh });
    f.scale = vec3Input({ value: obj.scale.toArray(), step: 0.05, onInput: sIn, onChange: sCh });
    f.uniform = numberInput({ value: obj.scale.x, step: 0.05, min: 0.001, onInput: afterUniform(uIn), onChange: afterUniform(uCh) });
    const transformRows = [
      row('Position', f.position),
      row('Rotation°', f.rotation),
      row('Scale', f.scale),
      row('Uniform', f.uniform),
    ];
    if (e.kind === 'asset' && !e.attach) {
      const asset = ed.assets.get(e.assetId);
      const [hIn, hCh] = tf((v) => { if (asset?.size.y > 0) obj.scale.setScalar(v / asset.size.y); });
      f.height = numberInput({ value: this._assetHeight(obj), step: 0.1, min: 0.001, onInput: afterUniform(hIn), onChange: afterUniform(hCh), title: 'Scale uniformly so the model is this tall' });
      transformRows.push(row('Height (m)', f.height));
    }
    transformRows.push(h('div', { class: 'btn-row' },
      e.attach ? null : button('Drop to ground', () => ed.dropToGround(obj), { title: 'G' }),
      e.attach ? null : button('Snap to grid', () => ed.snapToGrid(obj), { title: 'Round position X/Z, rotation and scale to the snap steps (Shift+S)' }),
      button('Reset rot', () => this.edit(obj, () => obj.rotation.set(0, 0, 0), true, { refresh: false })),
      button('Focus', () => ed.focus(obj), { title: 'F' }),
    ));
    const parent = parentEntity(obj);
    if (parent) transformRows.unshift(h('p', { class: 'hint' }, `Relative to ${e.attach ? `${parent.name} → ${e.attach}` : parent.name}.`));
    this.root.append(section('Transform', transformRows));

    // Shape / marker / asset params
    if (e.kind === 'primitive') {
      this.root.append(section('Shape', PRIMITIVES[e.type].params.map((p) => this._paramRow(obj, p))));
      this.root.append(this._materialSection(obj));
    } else if (e.kind === 'marker') {
      // params without a `section` go under the marker's name; the rest get a section each (the spawn's player settings)
      const groups = new Map([[MARKERS[e.type].label, []]]);
      for (const p of MARKERS[e.type].params) {
        const key = p.section ?? MARKERS[e.type].label;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(this._paramRow(obj, p));
      }
      // A spawn with a player controller script keeps its movement and camera settings in the script's params.
      const controller = e.type === 'spawn' && ed.scripts ? e.scripts.find((r) => ed.scripts.isController(r.id)) : null;
      if (e.type === 'spawn' && !controller) {
        groups.get('Movement')?.push(h('p', { class: 'hint' }, 'Used by ▶ Play and exported in this node\'s userData.params. Walk and run speeds apply in first person; in third person the character moves at its animation\'s speed.'));
      }
      for (const [title, rows] of groups) {
        if (controller && (title === 'Camera' || title === 'Movement')) continue;
        this.root.append(section(title, rows, { open: title !== 'Movement' }));
        if (e.type === 'spawn' && title === MARKERS.spawn.label) {
          this._playerSection(obj).forEach((el) => this.root.append(el));
          if (ed.scripts) this.root.append(this._controllerSection(obj, controller));
        }
      }
    } else if (e.kind === 'asset') {
      const asset = ed.assets.get(e.assetId);
      const [, cpCh] = bind((en, v) => { en.params.centerPivot = v; });
      this.root.append(section('Model', [
        row('Source size', h('span', { class: 'muted' }, asset ? asset.size.toArray().map((n) => n.toFixed(2)).join(' × ') : '?')),
        row('Base pivot', checkbox({ value: e.params.centerPivot, onChange: cpCh, label: 'Center on base' })),
        asset?.animations.length ? row('Animations', h('span', { class: 'muted' }, asset.animations.map((a) => a.name || 'clip').join(', '))) : null,
        asset?.rig ? row('Rig', h('span', { class: 'muted' }, `${asset.rig.bones.length} bones${asset.rig.sockets.length ? ` · ${asset.rig.sockets.join(', ')}` : ''}`)) : null,
        asset?.prop ? row('Holdable', h('span', { class: 'muted' }, `${asset.prop.hands === 2 ? 'two hands' : 'one hand'} · ${asset.prop.hold}${asset.prop.grip ? '' : ' · no grip.json (default finger curl)'}`)) : null,
        asset?.meta.tinyimgen ? row('Source', h('span', { class: 'muted' }, `tinyimgen ${asset.meta.tinyimgen.role} ${asset.meta.tinyimgen.id}`)) : null,
      ]));
      if (asset?.rig?.sockets.some(isHandSocket)) this.root.append(this._handsSection(obj));
      if (asset?.prop && isHandSocket(e.attach)) this.root.append(this._holdSection(obj));
    }

    // Rendering
    if (e.kind !== 'marker' && e.kind !== 'group') {
      const [, castCh] = bind((en, v) => { en.shadow.cast = v; });
      const [, recvCh] = bind((en, v) => { en.shadow.receive = v; });
      this.root.append(section('Rendering', [
        row('Shadows', checkbox({ value: e.shadow.cast, onChange: castCh, label: 'Cast' }), checkbox({ value: e.shadow.receive, onChange: recvCh, label: 'Receive' })),
        row('Visible', checkbox({ value: obj.visible, onChange: (v) => ed.setVisible(obj, v) })),
      ]));
    }

    if (ed.scripts) this.root.append(this._scriptsSection(obj));
    this.root.append(this._gameSection(obj));
    this.root.append(h('div', { class: 'btn-row insp-actions' },
      button('Duplicate', () => ed.duplicateSelected(), { title: 'Ctrl+D' }),
      button('Delete', () => ed.deleteSelected(), { cls: 'btn-danger', title: 'Del' }),
    ));
  }

  /** Parent, bone attachment and children. */
  _hierarchySection(obj) {
    const ed = this.editor, e = obj.entity, parent = parentEntity(obj);
    const mine = new Set(entitySubtree(obj));
    const depth = (o) => { let d = 0; for (let p = parentEntity(o); p; p = parentEntity(p)) d++; return d; };
    const candidates = ed.objects.filter((o) => !mine.has(o));
    const rows = [
      row('Parent', select({
        value: parent?.entity.id ?? '',
        options: [['', '— none (top level) —'], ...candidates.map((o) => [o.entity.id, `${'\u00a0\u00a0'.repeat(depth(o))}${entityIcon(o)} ${o.name}`])],
        onChange: (id) => ed.setParent([obj], candidates.find((o) => o.entity.id === id) ?? null),
      })),
    ];
    const rig = entityRig(parent, ed.assets);
    if (rig) {
      rows.push(row('Attach to', select({
        value: e.attach ?? '',
        options: [['', `${parent.name} (no bone)`], ...rig.attachPoints.map((b) => [b, b])],
        onChange: (bone) => ed.attachTo(obj, bone || null, { snap: !!entityProp(obj, ed.assets) && isHandSocket(bone) }),
      })));
    }
    const kids = childEntities(obj);
    if (kids.length) {
      rows.push(row('Children', h('span', { class: 'muted' }, kids.map((k) => k.name).join(', ')),
        button('Select', () => ed.setSelection(kids), { cls: 'btn-sm' })));
    }
    rows.push(h('p', { class: 'hint' }, 'Or drag it onto another object in the Scene list. Children move, hide and export with their parent.'));
    return section('Hierarchy', rows, { open: !!parent || kids.length > 0 });
  }

  /** What a character holds, and a picker to hand it a prop (library props and tinyimgen's). */
  _handsSection(obj, { keepSelection = false } = {}) {
    const ed = this.editor;
    const held = childEntities(obj).filter((c) => isHandSocket(c.entity.attach));
    const pick = { value: '', hand: ed.freeHand(obj, 'Right') };
    const options = [['', 'Choose a prop…']];
    const items = new Map();
    for (const a of ed.assets.list()) if (a.prop) { options.push([`lib:${a.id}`, a.name]); items.set(`lib:${a.id}`, a); }
    const picker = select({ value: '', options, onChange: (v) => { pick.value = v; } });
    // tinyimgen props that aren't in the library yet (filled in when the catalog arrives)
    tinyimgenCatalog().then(({ props }) => {
      for (const p of props) {
        if (ed.assets.findTinyimgen(p.id, 'prop')) continue;
        items.set(`tiny:${p.id}`, p);
        picker.append(h('option', { value: `tiny:${p.id}` }, `${p.name} (tinyimgen)`));
      }
    }).catch(() => {});
    const give = async (hand) => {
      const item = items.get(pick.value);
      if (!item) { toast('Choose a prop first'); return; }
      try {
        const asset = item.role === 'prop' ? await importTinyimgen(ed, item) : item;
        ed.holdProp(obj, asset.id, hand, { select: !keepSelection });
      } catch (err) {
        toast(`Couldn't import ${item.name}: ${err.message}`, { type: 'error', timeout: 6000 });
      }
    };
    return section('Hands', [
      ...held.map((c) => row(c.entity.attach.startsWith('Left') ? 'Left hand' : 'Right hand',
        h('span', { class: 'muted' }, c.name),
        button('Select', () => ed.select(c), { cls: 'btn-sm' }),
        button('✕', () => ed.removeObject(c), { cls: 'btn-ghost btn-sm', title: 'Drop it (delete)' }))),
      row('Hold', picker),
      h('div', { class: 'btn-row' },
        button('In right hand', () => give('Right'), { cls: 'btn-sm' }),
        button('In left hand', () => give('Left'), { cls: 'btn-sm' })),
      h('p', { class: 'hint' }, 'The prop\'s grip goes on the hand socket, with the finger curls and hold saved in tinyimgen\'s Prop Editor. The editor shows the first frame of Idle; the playtest animates it.'),
    ]);
  }

  /**
   * The player under a Player Spawn: its rigged model (pick, replace, height), what it holds, and how each prop is
   * held. Returns the sections to add.
   */
  _playerSection(spawn) {
    const ed = this.editor, model = ed.playerModel(spawn);
    const items = new Map(), options = [['', model ? 'Replace with…' : 'Choose a human model…']];
    for (const a of ed.assets.list()) if (a.rig) { options.push([`lib:${a.id}`, a.name]); items.set(`lib:${a.id}`, a); }
    const picker = select({
      value: '', options,
      onChange: async (v) => {
        const item = items.get(v);
        if (!item) return;
        try {
          const asset = item.role === 'character' ? await importTinyimgen(ed, item) : item;
          ed.setPlayerModel(spawn, asset.id);
        } catch (err) {
          toast(`Couldn't import ${item.name}: ${err.message}`, { type: 'error', timeout: 6000 });
        }
      },
    });
    tinyimgenCatalog().then(({ characters }) => {
      for (const c of characters) {
        if (ed.assets.findTinyimgen(c.id, 'character')) continue;
        items.set(`tiny:${c.id}`, c);
        picker.append(h('option', { value: `tiny:${c.id}` }, `${c.name} (tinyimgen)`));
      }
    }).catch(() => {});

    const rows = [];
    if (model) {
      const asset = ed.assets.get(model.entity.assetId);
      const height = () => asset.size.y * model.scale.y;
      const hIn = numberInput({
        value: height(), step: 0.05, min: 0.1, title: 'Scales the model uniformly to this height; the playtest uses it too',
        onInput: (v) => this.edit(model, () => model.scale.setScalar(v / asset.size.y), false, { refresh: false }),
        onChange: (v) => this.edit(model, () => model.scale.setScalar(v / asset.size.y), true, { refresh: false }),
      });
      rows.push(
        row('Model', h('span', { class: 'muted' }, model.name),
          button('Select', () => ed.select(model), { cls: 'btn-sm' }),
          button('✕', () => ed.removeObject(model), { cls: 'btn-ghost btn-sm', title: 'Remove the model (and what it holds)' })),
        row('Height (m)', hIn),
      );
    }
    rows.push(row(model ? 'Replace' : 'Model', picker));
    rows.push(h('p', { class: 'hint' }, model
      ? '▶ Play uses this model as the player, animated with tinyimgen\'s locomotion, holding its props.'
      : 'Pick a rigged human (from the library or tinyimgen). ▶ Play then uses it as the player.'));
    const out = [section('Player', rows)];
    if (model && entityRig(model, ed.assets).sockets.some(isHandSocket)) {
      out.push(this._handsSection(model, { keepSelection: true }));
      for (const prop of childEntities(model)) {
        if (entityProp(prop, ed.assets) && isHandSocket(prop.entity.attach)) out.push(this._holdSection(prop, { title: `Hold · ${prop.name}`, open: false }));
      }
    }
    return out;
  }

  /** How a held prop is held: hand, hold style, arms, finger curls, grip offset. Edits go on top of its grip.json. */
  _holdSection(prop, { title = 'Hold', open = true } = {}) {
    const ed = this.editor, e = prop.entity, data = holdData(prop, ed.assets);
    const hand = e.attach.startsWith('Left') ? 'Left' : 'Right', other = hand === 'Left' ? 'Right' : 'Left';
    const setHold = (patch, commit) => this.edit(prop, (en) => { en.params.hold = { ...en.params.hold, ...patch }; }, commit, { refresh: false });
    const fingersOf = (which) => ({ ...(holdData(prop, ed.assets).fingers?.[which] ?? DEFAULT_FINGERS) });
    const setFingers = (which, curls, commit) => this.edit(prop, (en) => {
      const prev = en.params.hold ?? {};
      en.params.hold = { ...prev, fingers: { ...prev.fingers, [which]: curls } };
    }, commit, { refresh: false });
    const fingerRows = (which, label) => {
      const sliders = FINGERS.map((f) => {
        const s = slider({
          value: curlValue(fingersOf(which)[f] ?? 0), min: 0, max: 1, step: 0.01,
          onInput: (v) => setFingers(which, { ...fingersOf(which), [f]: v }, false),
          onChange: (v) => setFingers(which, { ...fingersOf(which), [f]: v }, true),
        });
        return row(f, s);
      });
      const preset = (name, v) => button(name, () => { setFingers(which, Object.fromEntries(FINGERS.map((f) => [f, f === 'Thumb' ? [0.15, v, v] : v])), true); this.render(); }, { cls: 'btn-sm' });
      return [h('div', { class: 'row-label sub' }, label), ...sliders,
        h('div', { class: 'btn-row' }, preset('Open', 0), preset('Relaxed', 0.45), preset('Fist', 1))];
    };
    const [pIn, pCh] = [false, true].map((commit) => (v) => this.edit(prop, () => prop.position.fromArray(v), commit, { refresh: false }));
    const [rIn, rCh] = [false, true].map((commit) => (v) => this.edit(prop, () => prop.rotation.set(v[0] * RAD, v[1] * RAD, v[2] * RAD), commit, { refresh: false }));
    const edited = !!e.params.hold && Object.keys(e.params.hold).length > 0;
    return section(title, [
      row('Hand', select({
        value: hand, options: [['Right', 'Right hand'], ['Left', 'Left hand']],
        onChange: (v) => { if (v !== hand) ed.attachTo(prop, socketForHand(v), { snap: true }); },
      })),
      row('Hold', select({
        value: data.hold ?? 'upright', options: [['upright', 'Upright (swords, tools)'], ['forward', 'Forward (guns, wands)']],
        onChange: (v) => setHold({ hold: v }, true),
      })),
      data.hands === 2 ? h('p', { class: 'hint' }, `Two-handed: carried in front, the ${other.toLowerCase()} hand on the second grip.`) : null,
      data.carry ? row('Arms', select({
        value: data.arms, options: [['animated', 'Animated (swing with the clip)'], ['static', 'Static (saved carry pose)']],
        onChange: (v) => setHold({ arms: v }, true),
      })) : null,
      ...fingerRows('primary', `${hand} hand fingers (0 open … 1 fist)`),
      ...(data.hands === 2 ? fingerRows('secondary', `${other} hand fingers`) : []),
      h('div', { class: 'row-label sub' }, 'Grip offset (relative to the hand socket)'),
      row('Position', vec3Input({ value: prop.position.toArray(), step: 0.005, onInput: pIn, onChange: pCh })),
      row('Rotation°', vec3Input({ value: [prop.rotation.x * DEG, prop.rotation.y * DEG, prop.rotation.z * DEG], step: 1, onInput: rIn, onChange: rCh })),
      h('div', { class: 'btn-row' },
        button('Snap grip to hand', () => ed.snapToGrip(prop), { title: 'Put the grip (from tinyimgen\'s Prop Editor) back on the hand socket' }),
        button('Reset to saved grip', () => { this.edit(prop, (en) => { delete en.params.hold; }, true, { refresh: false }); this.render(); },
          { title: edited ? 'Drop the edits above and use the prop\'s grip.json again' : 'No edits yet' })),
      h('p', { class: 'hint' }, edited ? 'Edited here: these settings override the prop\'s tinyimgen grip for this copy.' : 'From the prop\'s tinyimgen grip.json. Changes here apply to this copy only.'),
    ], { open });
  }

  _paramRow(obj, p) {
    const e = obj.entity;
    const set = (commit) => (v) => this.edit(obj, (en) => { en.params[p.key] = v; }, commit);
    let control;
    if (p.type === 'select') control = select({ value: e.params[p.key], options: p.options, onChange: set(true) });
    else if (p.type === 'text') control = textInput({ value: e.params[p.key], onInput: set(false), onChange: set(true) });
    else if (p.type === 'color') control = colorInput({ value: e.params[p.key], onInput: set(false), onChange: set(true) });
    else if (p.type === 'bool') control = checkbox({ value: e.params[p.key], onChange: set(true) });
    else control = numberInput({ value: e.params[p.key], step: p.step, min: p.min, max: p.max, int: p.int, onInput: set(false), onChange: set(true), title: p.title });
    const r = row(p.label, control);
    if (p.title) r.title = p.title;
    return r;
  }

  _materialSection(obj) {
    const m = obj.entity.material;
    const set = (key, commit) => (v) => this.edit(obj, (en) => { en.material[key] = v; }, commit);
    const pair = (key) => ({ onInput: set(key, false), onChange: set(key, true) });
    return section('Material', [
      row('Color', colorInput({ value: m.color, ...pair('color') })),
      row('Roughness', slider({ value: m.roughness, min: 0, max: 1, step: 0.01, ...pair('roughness') })),
      row('Metalness', slider({ value: m.metalness, min: 0, max: 1, step: 0.01, ...pair('metalness') })),
      row('Emissive', colorInput({ value: m.emissive, ...pair('emissive') }),
        numberInput({ value: m.emissiveIntensity, step: 0.1, min: 0, ...pair('emissiveIntensity'), title: 'Emissive intensity' })),
      row('Opacity', slider({ value: m.opacity, min: 0, max: 1, step: 0.01, ...pair('opacity') })),
      row('Shading', checkbox({ value: m.flatShading, onChange: set('flatShading', true), label: 'Flat' }),
        checkbox({ value: m.doubleSided, onChange: set('doubleSided', true), label: 'Double-sided' })),
    ]);
  }

  /** The spawn's player controller: the script with the movement, camera and view code (and their settings). */
  _controllerSection(obj, controller) {
    const ed = this.editor, lib = ed.scripts;
    if (controller) {
      return section('Player controller', [
        h('p', { class: 'hint' }, `Movement, camera and view settings are the “${lib.get(controller.id)?.name}” script's fields below; its code is how the player moves.`),
        h('div', { class: 'btn-row' }, button('Edit the code', () => ed.emit('openScript', controller.id), { cls: 'btn-sm' })),
      ]);
    }
    const make = () => {
      // the spawn's current settings carry over: the script's params use the same names
      const id = (lib.list().find((s) => lib.isController(s.id) && s.name === 'Player controller') ?? lib.add({ name: 'Player controller', source: CONTROLLER_SOURCE })).id;
      const keys = MARKERS.spawn.params.filter((p) => p.section).map((p) => p.key);
      this.edit(obj, (en) => { en.scripts.push({ id, params: Object.fromEntries(keys.map((k) => [k, en.params[k]])) }); }, true, { refresh: false });
      this.render();
    };
    return section('Player controller', [
      h('p', { class: 'hint' }, 'The playtest moves the player with a built-in controller script and the Movement / Camera settings above. Make it this map\'s own script to change how the player moves, looks and jumps.'),
      h('div', { class: 'btn-row' }, button('Make a player controller script', make, { cls: 'btn-sm btn-primary' })),
    ]);
  }

  /** Scripts attached to the object, with a field per declared param (values are this object's). */
  _scriptsSection(obj) {
    const ed = this.editor, lib = ed.scripts, refs = obj.entity.scripts;
    const setParam = (i, key, commit) => (v) => this.edit(obj, (en) => { en.scripts[i].params = { ...en.scripts[i].params, [key]: v }; }, commit, { refresh: false });
    const field = (i, key, def, value) => {
      const opts = (def.options ?? []).map((o) => (Array.isArray(o) ? o.map(String) : [String(o), String(o)]));
      const c = def.type === 'number' ? numberInput({ value: Number(value) || 0, step: def.step ?? 0.1, min: def.min, max: def.max, onChange: setParam(i, key, true) })
        : def.type === 'bool' ? checkbox({ value: !!value, onChange: setParam(i, key, true) })
        : def.type === 'color' ? colorInput({ value, onInput: setParam(i, key, false), onChange: setParam(i, key, true) })
        : def.type === 'select' ? select({ value: String(value), options: opts, onChange: setParam(i, key, true) })
        : def.type === 'clip' ? select({ // a clip from the animation library (plus the characters' own Idle, Walk…)
          value: String(value ?? ''),
          options: [...new Set(['', ...(ed.clips?.clips.map((c) => c.name) ?? []), 'Idle', 'Walk', 'Run', String(value ?? '')])].map((n) => [n, n || '(none)']),
          onChange: setParam(i, key, true),
        })
        : textInput({ value, onChange: setParam(i, key, true) });
      const r = row(def.label, c);
      if (def.title) r.title = def.title;
      return r;
    };
    const items = refs.map((ref, i) => {
      const script = lib.get(ref.id);
      const hooks = h('small', { class: 'muted' });
      const fields = h('div');
      const box = h('div', { class: 'script-ref-box' },
        h('div', { class: 'script-ref-head' },
          h('b', { title: script?.path ?? 'The script was deleted' }, script?.name ?? 'Missing script'), hooks,
          script ? button('Edit', () => ed.emit('openScript', ref.id), { cls: 'btn-sm' }) : null,
          button('✕', () => { this.edit(obj, (en) => { en.scripts.splice(i, 1); }, true, { refresh: false }); this.render(); }, { cls: 'btn-sm btn-ghost', title: 'Remove from this object' })),
        fields);
      if (script) {
        lib.meta(ref.id).then((meta) => {
          if (meta.error) { fields.replaceChildren(h('p', { class: 'hint error' }, `⚠ ${meta.error}`)); return; }
          hooks.textContent = meta.hooks.join(' · ');
          fields.replaceChildren(...Object.entries(meta.fields).map(([key, def]) => field(i, key, def, ref.params?.[key] ?? def.default)));
        });
      }
      return box;
    });
    // a script file from the project, a new one, or an engine template (copied into scripts/ first)
    const add = select({
      value: '',
      options: [
        ['', '+ Add script…'],
        ...lib.list().filter((s) => !refs.some((r) => r.id === s.id)).sort((a, b) => a.path.localeCompare(b.path)).map((s) => [s.id, s.path.replace(/^scripts\//, '')]),
        ['$new', 'New script…'],
        ...TEMPLATES.filter((t) => t.name !== 'Empty').map((t) => [`tpl:${t.name}`, `From template: ${t.name}`]),
      ],
      onChange: (v) => {
        if (!v) return;
        const tpl = v.startsWith('tpl:') && TEMPLATES.find((t) => t.name === v.slice(4));
        const id = v === '$new' ? lib.add({ name: 'New script' }).id : tpl ? lib.add({ name: tpl.name, source: tpl.source }).id : v;
        this.edit(obj, (en) => { en.scripts.push({ id, params: {} }); }, true, { refresh: false });
        if (v === '$new') ed.emit('openScript', id);
        this.render();
      },
    });
    return section(refs.length ? `Scripts (${refs.length})` : 'Scripts', [...items, add]);
  }

  _gameSection(obj) {
    const e = obj.entity;
    const set = (key, commit) => (v) => this.edit(obj, (en) => { en.props[key] = v; }, commit, { refresh: false });
    const list = h('div', { class: 'kv-list' });
    const renderList = () => {
      list.replaceChildren(...e.props.custom.map((kv, i) => h('div', { class: 'kv' },
        textInput({ value: kv.key, placeholder: 'key', onChange: (v) => this.edit(obj, (en) => { en.props.custom[i].key = v.trim(); }, true, { refresh: false }) }),
        textInput({ value: kv.value, placeholder: 'value', onChange: (v) => this.edit(obj, (en) => { en.props.custom[i].value = v; }, true, { refresh: false }) }),
        button('✕', () => { this.edit(obj, (en) => { en.props.custom.splice(i, 1); }, true, { refresh: false }); renderList(); }, { cls: 'btn-ghost btn-sm', title: 'Remove' }),
      )));
    };
    renderList();
    return section('Game data', [
      row('Collider', select({ value: e.props.collider, options: COLLIDERS.map((c) => [c, c]), onChange: set('collider', true) })),
      row('Static', checkbox({ value: e.props.isStatic, onChange: set('isStatic', true), label: 'Does not move' })),
      row('Tags', textInput({ value: e.props.tags, placeholder: 'enemy, loot, …', onChange: set('tags', true) })),
      h('div', { class: 'row-label sub' }, 'Custom properties'),
      list,
      button('+ Add property', () => {
        this.edit(obj, (en) => { en.props.custom.push({ key: `prop${en.props.custom.length + 1}`, value: '' }); }, true, { refresh: false });
        renderList();
      }, { cls: 'btn-sm' }),
      h('p', { class: 'hint' }, 'Exported to glTF extras → object.userData in three.js. Values like 3, true or {"a":1} are parsed.'),
    ]);
  }

  // ------------------------------------------------------------------ scene

  renderScene() {
    const ed = this.editor, env = ed.env;
    const set = (key) => (v) => ed.setEnvironment({ [key]: v });
    const pair = (key) => ({ onInput: set(key), onChange: set(key) });
    this.root.append(h('div', { class: 'insp-head' },
      h('span', { class: 'insp-icon' }, '🗺'),
      h('div', { class: 'insp-title' },
        textInput({ value: ed.mapName, onChange: (v) => { ed.mapName = v || 'Untitled Map'; ed.emit('changed'); } }),
        h('small', {}, 'Map settings — select an object to edit it')),
    ));
    this.root.append(section('Sky & fog', [
      row('Background', colorInput({ value: env.background, ...pair('background') })),
      row('Fog', checkbox({ value: env.fog, onChange: set('fog'), label: 'Enabled' })),
      row('Fog near', numberInput({ value: env.fogNear, step: 5, min: 0, ...pair('fogNear') })),
      row('Fog far', numberInput({ value: env.fogFar, step: 5, min: 1, ...pair('fogFar') })),
    ]));
    this.root.append(section('Lighting', [
      row('Sky light', colorInput({ value: env.skyColor, ...pair('skyColor') })),
      row('Ground light', colorInput({ value: env.groundColor, ...pair('groundColor') })),
      row('Ambient', slider({ value: env.ambientIntensity, min: 0, max: 5, step: 0.05, ...pair('ambientIntensity') })),
      row('Sun color', colorInput({ value: env.sunColor, ...pair('sunColor') })),
      row('Sun intensity', slider({ value: env.sunIntensity, min: 0, max: 10, step: 0.05, ...pair('sunIntensity') })),
      row('Sun azimuth', slider({ value: env.sunAzimuth, min: 0, max: 360, step: 1, ...pair('sunAzimuth') })),
      row('Sun elevation', slider({ value: env.sunElevation, min: 1, max: 90, step: 1, ...pair('sunElevation') })),
      row('Shadows', checkbox({ value: env.shadows, onChange: set('shadows'), label: 'Sun casts shadows' })),
    ]));
    this.root.append(section('Editor', [
      row('Grid', checkbox({ value: env.showGrid, onChange: set('showGrid'), label: 'Show grid' })),
    ]));
    const counts = { primitive: 0, asset: 0, marker: 0, group: 0 };
    ed.objects.forEach((o) => counts[o.entity.kind]++);
    const t = ed.terrain;
    this.root.append(section('Stats', [
      row('Objects', h('span', { class: 'muted' }, `${counts.primitive} primitives · ${counts.asset} models · ${counts.marker} markers${counts.group ? ` · ${counts.group} empties` : ''}`)),
      row('Terrain', h('span', { class: 'muted' }, `${t.size}×${t.size} m · ${t.segments}² cells`)),
      row('Assets', h('span', { class: 'muted' }, `${ed.assets.list().length} GLB files`)),
    ]));
  }
}
