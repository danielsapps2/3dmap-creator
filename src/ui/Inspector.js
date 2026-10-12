import * as THREE from 'three';
import { h, row, section, numberInput, slider, vec3Input, colorInput, checkbox, select, textInput, button } from './dom.js';
import { PRIMITIVES } from '../editor/Primitives.js';
import { MARKERS } from '../editor/Markers.js';
import { serializeEntity, refreshEntity, entityLabel, entityIcon, COLLIDERS } from '../editor/Entities.js';

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
    editor.on('sceneChanged', () => { if (!editor.selected) this.render(); });
    editor.on('terrainChanged', () => { if (!editor.selected) this.render(); });
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
    if (!this._before) this._before = serializeEntity(obj);
    mutate(obj.entity);
    if (refresh) refreshEntity(obj);
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
    if (e.kind === 'asset') {
      const asset = ed.assets.get(e.assetId);
      const [hIn, hCh] = tf((v) => { if (asset?.size.y > 0) obj.scale.setScalar(v / asset.size.y); });
      f.height = numberInput({ value: this._assetHeight(obj), step: 0.1, min: 0.001, onInput: afterUniform(hIn), onChange: afterUniform(hCh), title: 'Scale uniformly so the model is this tall' });
      transformRows.push(row('Height (m)', f.height));
    }
    transformRows.push(h('div', { class: 'btn-row' },
      button('Drop to ground', () => ed.dropToGround(obj), { title: 'G' }),
      button('Snap to grid', () => ed.snapToGrid(obj), { title: 'Round position X/Z, rotation and scale to the snap steps (Shift+S)' }),
      button('Reset rot', () => this.edit(obj, () => obj.rotation.set(0, 0, 0), true, { refresh: false })),
      button('Focus', () => ed.focus(obj), { title: 'F' }),
    ));
    this.root.append(section('Transform', transformRows));

    // Shape / marker / asset params
    if (e.kind === 'primitive') {
      this.root.append(section('Shape', PRIMITIVES[e.type].params.map((p) => this._paramRow(obj, p))));
      this.root.append(this._materialSection(obj));
    } else if (e.kind === 'marker') {
      this.root.append(section(MARKERS[e.type].label, MARKERS[e.type].params.map((p) => this._paramRow(obj, p))));
    } else if (e.kind === 'asset') {
      const asset = ed.assets.get(e.assetId);
      const [, cpCh] = bind((en, v) => { en.params.centerPivot = v; });
      this.root.append(section('Model', [
        row('Source size', h('span', { class: 'muted' }, asset ? asset.size.toArray().map((n) => n.toFixed(2)).join(' × ') : '?')),
        row('Base pivot', checkbox({ value: e.params.centerPivot, onChange: cpCh, label: 'Center on base' })),
        asset?.animations.length ? row('Animations', h('span', { class: 'muted' }, asset.animations.map((a) => a.name || 'clip').join(', '))) : null,
      ]));
    }

    // Rendering
    if (e.kind !== 'marker') {
      const [, castCh] = bind((en, v) => { en.shadow.cast = v; });
      const [, recvCh] = bind((en, v) => { en.shadow.receive = v; });
      this.root.append(section('Rendering', [
        row('Shadows', checkbox({ value: e.shadow.cast, onChange: castCh, label: 'Cast' }), checkbox({ value: e.shadow.receive, onChange: recvCh, label: 'Receive' })),
        row('Visible', checkbox({ value: obj.visible, onChange: (v) => ed.setVisible(obj, v) })),
      ]));
    }

    this.root.append(this._gameSection(obj));
    this.root.append(h('div', { class: 'btn-row insp-actions' },
      button('Duplicate', () => ed.duplicateSelected(), { title: 'Ctrl+D' }),
      button('Delete', () => ed.deleteSelected(), { cls: 'btn-danger', title: 'Del' }),
    ));
  }

  _paramRow(obj, p) {
    const e = obj.entity;
    const set = (commit) => (v) => this.edit(obj, (en) => { en.params[p.key] = v; }, commit);
    let control;
    if (p.type === 'text') control = textInput({ value: e.params[p.key], onInput: set(false), onChange: set(true) });
    else if (p.type === 'color') control = colorInput({ value: e.params[p.key], onInput: set(false), onChange: set(true) });
    else if (p.type === 'bool') control = checkbox({ value: e.params[p.key], onChange: set(true) });
    else control = numberInput({ value: e.params[p.key], step: p.step, min: p.min, max: p.max, int: p.int, onInput: set(false), onChange: set(true) });
    return row(p.label, control);
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
    const counts = { primitive: 0, asset: 0, marker: 0 };
    ed.objects.forEach((o) => counts[o.entity.kind]++);
    const t = ed.terrain;
    this.root.append(section('Stats', [
      row('Objects', h('span', { class: 'muted' }, `${counts.primitive} primitives · ${counts.asset} models · ${counts.marker} markers`)),
      row('Terrain', h('span', { class: 'muted' }, `${t.size}×${t.size} m · ${t.segments}² cells`)),
      row('Assets', h('span', { class: 'muted' }, `${ed.assets.list().length} GLB files`)),
    ]));
  }
}
