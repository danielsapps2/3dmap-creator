import { h, row, section, numberInput, slider, colorInput, checkbox, select, textInput, button, toast, modal } from './dom.js';
import { PRIMITIVES } from '../editor/Primitives.js';
import { MARKERS } from '../editor/Markers.js';
import { entityIcon, childEntities, parentEntity, isWithin } from '../editor/Entities.js';
import { entityRig } from '../editor/Rig.js';
import { tinyimgenCatalog, importTinyimgen } from '../editor/Tinyimgen.js';
import { formatBytes } from '../core/utils.js';

// ====================================================================== Build

export function buildPanel(root, editor) {
  const tiles = [];
  const tile = (icon, label, spec, title) => {
    const b = h('button', { class: 'tile', title: title ?? `Place ${label}`, onclick: () => editor.startPlacement(spec) },
      h('span', { class: 'tile-icon' }, icon), h('span', { class: 'tile-label' }, label));
    b.spec = spec;
    tiles.push(b);
    return b;
  };
  const po = editor.placeOptions;
  root.append(
    section('Game objects', [
      h('div', { class: 'tiles' }, tile('◇', 'Empty', { kind: 'group' }, 'Place an empty game object to group others under')),
      h('p', { class: 'hint' }, 'Drag objects onto each other in the Scene list to make them children. Characters and holdable props from tinyimgen are in the Models tab.'),
    ]),
    section('Primitives', h('div', { class: 'tiles' },
      ...Object.entries(PRIMITIVES).map(([type, d]) => tile(d.icon, d.label, { kind: 'primitive', type })))),
    section('Gameplay markers', h('div', { class: 'tiles' },
      ...Object.entries(MARKERS).map(([type, d]) => tile(d.icon, d.label, { kind: 'marker', type })))),
    section('Placement', [
      row('Rotation', checkbox({ value: po.randomRotation, onChange: (v) => { po.randomRotation = v; }, label: 'Random Y' })),
      row('Scale min', numberInput({ value: po.scaleMin, step: 0.05, min: 0.01, onChange: (v) => { po.scaleMin = v; } })),
      row('Scale max', numberInput({ value: po.scaleMax, step: 0.05, min: 0.01, onChange: (v) => { po.scaleMax = v; } })),
      row('Surface', checkbox({ value: po.alignToNormal, onChange: (v) => { po.alignToNormal = v; }, label: 'Align to normal' })),
      row('Stamp', checkbox({ value: po.stamp, onChange: (v) => { po.stamp = v; }, label: 'Keep placing' })),
      h('p', { class: 'hint' }, 'Click a tile, then click in the viewport to place. Shift+click toggles keep-placing. Esc cancels. Turn on Snap to place on the grid.'),
    ]),
  );
  const sync = () => {
    const spec = editor.mode === 'place' ? editor._placeSpec : null;
    tiles.forEach((t) => t.classList.toggle('active', !!spec && spec.kind === t.spec.kind && spec.type === t.spec.type));
  };
  editor.on('modeChanged', sync);
  editor.on('placementChanged', sync);
}

// ====================================================================== Terrain

const TOOLS = [
  ['raise', '⬆', 'Raise'], ['lower', '⬇', 'Lower'], ['smooth', '≈', 'Smooth'],
  ['flatten', '▬', 'Flatten'], ['noise', '∿', 'Noise'], ['paint', '🖌', 'Paint'],
];

export function terrainPanel(root, editor, { importHeightmap, exportHeightmap }) {
  const b = editor.brush;
  const gen = { seed: 1337, scale: 60, height: 24, octaves: 5, persistence: 0.5, exponent: 1.4, ridged: false, island: false, base: 0, mode: 'replace' };
  const paint = { water: 1, snowHeight: 20, rockSlope: 0.78, sand: '#c8b47e', grass: '#6b8f47', rock: '#7a746c', snow: '#f2f4f7', fill: '#6b8f47' };
  const resize = { size: editor.terrain.size, segments: editor.terrain.segments };

  const toolBtns = TOOLS.map(([mode, icon, label]) => h('button', {
    class: 'tile', title: label,
    onclick: () => { b.mode = mode; editor.setMode('sculpt'); editor.emit('brushChanged'); },
  }, h('span', { class: 'tile-icon' }, icon), h('span', { class: 'tile-label' }, label)));
  toolBtns.forEach((t, i) => { t.mode = TOOLS[i][0]; });

  const sculptBtn = button('', () => editor.setMode(editor.mode === 'sculpt' ? 'select' : 'sculpt'), { cls: 'btn-wide', title: 'B' });
  const radius = slider({ value: b.radius, min: 0.5, max: 64, step: 0.5, onInput: (v) => { b.radius = v; } });
  const strength = slider({ value: b.strength, min: 0.01, max: 1, step: 0.01, onInput: (v) => { b.strength = v; } });
  const flatH = numberInput({ value: b.flattenTarget ?? 0, step: 0.1, onChange: (v) => { b.flattenTarget = v; b.flattenAuto = false; editor.emit('brushChanged'); } });
  const flatAuto = checkbox({ value: b.flattenAuto, onChange: (v) => { b.flattenAuto = v; }, label: 'Sample on click' });
  const flatRow = row('Flatten to', flatH, flatAuto);
  const paintColor = colorInput({ value: b.color, onInput: (v) => { b.color = v; } });
  const paintRow = row('Paint color', paintColor);

  const sizeIn = numberInput({ value: resize.size, step: 8, min: 8, max: 4096, onChange: (v) => { resize.size = v; } });
  const segSel = select({ value: String(resize.segments), options: [32, 64, 128, 192, 256, 384, 512].map((n) => [String(n), `${n} × ${n}`]), onChange: (v) => { resize.segments = +v; } });

  const flatShade = checkbox({ value: editor.terrain.material.flatShading, onChange: (v) => { editor.terrain.setFlatShading(v); editor.emit('changed'); }, label: 'Low-poly look' });
  const roughSlider = slider({ value: editor.terrain.material.roughness, min: 0, max: 1, step: 0.01, onInput: (v) => { editor.terrain.material.roughness = v; editor.emit('changed'); } });

  const seedIn = numberInput({ value: gen.seed, step: 1, int: true, onChange: (v) => { gen.seed = v; } });

  root.append(
    section('Sculpt', [
      sculptBtn,
      h('div', { class: 'tiles tiles-3' }, ...toolBtns),
      row('Radius', radius),
      row('Strength', strength),
      flatRow,
      paintRow,
      h('p', { class: 'hint' }, 'Left-drag to sculpt. [ / ] change radius. Right-drag orbits (add WASD to fly), middle-drag pans.'),
    ]),
    section('Generate', [
      row('Seed', seedIn, button('🎲', () => { gen.seed = Math.floor(Math.random() * 99999); seedIn.setValue(gen.seed); }, { cls: 'btn-sm', title: 'Random seed' })),
      row('Feature size', numberInput({ value: gen.scale, step: 1, min: 1, onChange: (v) => { gen.scale = v; } })),
      row('Height', numberInput({ value: gen.height, step: 0.5, min: 0, onChange: (v) => { gen.height = v; } })),
      row('Base height', numberInput({ value: gen.base, step: 0.5, onChange: (v) => { gen.base = v; } })),
      row('Octaves', numberInput({ value: gen.octaves, step: 1, min: 1, max: 10, int: true, onChange: (v) => { gen.octaves = v; } })),
      row('Roughness', slider({ value: gen.persistence, min: 0.1, max: 0.9, step: 0.01, onChange: (v) => { gen.persistence = v; } })),
      row('Sharpness', slider({ value: gen.exponent, min: 0.3, max: 4, step: 0.05, onChange: (v) => { gen.exponent = v; } })),
      row('Style', checkbox({ value: gen.ridged, onChange: (v) => { gen.ridged = v; }, label: 'Ridged' }), checkbox({ value: gen.island, onChange: (v) => { gen.island = v; }, label: 'Island' })),
      row('Mode', select({ value: gen.mode, options: [['replace', 'Replace'], ['add', 'Add on top']], onChange: (v) => { gen.mode = v; } })),
      h('div', { class: 'btn-row' },
        button('Generate', () => editor.terrainCommand('Generate terrain', (t) => t.generate(gen)), { cls: 'btn-primary' }),
        button('Generate + paint', () => editor.terrainCommand('Generate terrain', (t) => { t.generate(gen); t.autoPaint({ ...paint, snowHeight: gen.base + gen.height * 0.8, water: gen.base + gen.height * 0.08 }); })),
      ),
    ], { open: false }),
    section('Paint', [
      row('Water level', numberInput({ value: paint.water, step: 0.5, onChange: (v) => { paint.water = v; } })),
      row('Snow height', numberInput({ value: paint.snowHeight, step: 0.5, onChange: (v) => { paint.snowHeight = v; } })),
      row('Rock slope', slider({ value: paint.rockSlope, min: 0.3, max: 0.99, step: 0.01, onChange: (v) => { paint.rockSlope = v; } })),
      row('Colors',
        colorInput({ value: paint.sand, onChange: (v) => { paint.sand = v; } }),
        colorInput({ value: paint.grass, onChange: (v) => { paint.grass = v; } }),
        colorInput({ value: paint.rock, onChange: (v) => { paint.rock = v; } }),
        colorInput({ value: paint.snow, onChange: (v) => { paint.snow = v; } })),
      button('Auto-paint by height & slope', () => editor.terrainCommand('Auto-paint', (t) => t.autoPaint(paint)), { cls: 'btn-wide' }),
      row('Fill', colorInput({ value: paint.fill, onChange: (v) => { paint.fill = v; } }),
        button('Fill all', () => editor.terrainCommand('Fill terrain color', (t) => t.paintAll(paint.fill)), { cls: 'btn-sm' })),
    ], { open: false }),
    section('Terrain settings', [
      row('Size (m)', sizeIn),
      row('Resolution', segSel),
      button('Apply size / resolution', () => {
        if (resize.size === editor.terrain.size && resize.segments === editor.terrain.segments) return;
        editor.terrainCommand('Resize terrain', (t) => t.resize(resize.size, resize.segments));
      }, { cls: 'btn-wide' }),
      row('Flat shading', flatShade),
      row('Roughness', roughSlider),
      h('div', { class: 'btn-row' },
        button('Flatten all', () => editor.terrainCommand('Flatten terrain', (t) => t.flatten(0))),
        button('Import heightmap…', importHeightmap),
        button('Export heightmap', exportHeightmap),
      ),
      h('p', { class: 'hint' }, 'Flat shading only affects the editor/three.js material; exported glTF uses smooth normals.'),
    ], { open: false }),
  );

  const sync = () => {
    const sculpting = editor.mode === 'sculpt';
    sculptBtn.textContent = sculpting ? '■ Stop sculpting (B)' : '✎ Start sculpting (B)';
    sculptBtn.classList.toggle('btn-primary', !sculpting);
    toolBtns.forEach((t) => t.classList.toggle('active', sculpting && t.mode === b.mode));
    radius.setValue(b.radius);
    strength.setValue(b.strength);
    flatH.setValue(b.flattenTarget ?? 0);
    flatRow.style.display = b.mode === 'flatten' ? '' : 'none';
    paintRow.style.display = b.mode === 'paint' ? '' : 'none';
  };
  const syncSize = () => {
    resize.size = editor.terrain.size;
    resize.segments = editor.terrain.segments;
    sizeIn.setValue(resize.size);
    segSel.value = String(resize.segments);
    flatShade.querySelector('input').checked = editor.terrain.material.flatShading;
    roughSlider.setValue(editor.terrain.material.roughness);
  };
  editor.on('modeChanged', sync);
  editor.on('brushChanged', sync);
  editor.on('terrainChanged', syncSize);
  sync();
}

// ====================================================================== Assets

export function assetsPanel(root, editor, { importGLB }) {
  const list = h('div', { class: 'asset-list' });
  const tiny = h('div', { class: 'tiny-body' });
  root.append(
    h('div', { class: 'dropzone', onclick: importGLB },
      h('strong', {}, 'Import GLB / glTF'),
      h('span', {}, 'Click or drop files anywhere on the window'),
    ),
    section('tinyimgen', tiny, { actions: button('↻', (e) => { e.preventDefault(); loadTiny(true); }, { cls: 'btn-ghost btn-sm', title: 'Refresh the list from tinyimgen' }) }),
    section('Library', list),
  );

  // tinyimgen's rigged characters and holdable props. Click one to place it; a prop clicked while a character is
  // selected goes into that character's hand.
  let catalog = null, error = null;
  const busy = new Set();
  const loadTiny = async (refresh = false) => {
    tiny.replaceChildren(h('p', { class: 'hint' }, 'Looking for tinyimgen…'));
    try {
      catalog = await tinyimgenCatalog({ refresh });
      error = null;
    } catch (err) {
      catalog = null;
      error = err.message;
    }
    renderTiny();
  };
  const useItem = async (item) => {
    const key = `${item.role}:${item.id}`;
    if (busy.has(key)) return;
    busy.add(key);
    renderTiny();
    try {
      const asset = await importTinyimgen(editor, item);
      const holder = editor.selected && entityRig(editor.selected, editor.assets) ? editor.selected : null;
      if (asset.prop && holder) {
        const hand = editor.freeHand(holder, asset.prop.hand);
        if (editor.holdProp(holder, asset.id, hand)) toast(`${holder.name} holds ${asset.name} in the ${hand.toLowerCase()} hand`, { type: 'ok' });
        else editor.startPlacement({ kind: 'asset', assetId: asset.id });
      } else {
        editor.startPlacement({ kind: 'asset', assetId: asset.id });
      }
    } catch (err) {
      console.error(err);
      toast(`Couldn't import ${item.name}: ${err.message}`, { type: 'error', timeout: 6000 });
    } finally {
      busy.delete(key);
      renderTiny();
    }
  };
  const renderTiny = () => {
    if (error) {
      tiny.replaceChildren(h('p', { class: 'hint' }, `${error} at /tinyimgen. Start tinyimgen (server.py, port 7860) to use its characters and props.`),
        button('Retry', () => loadTiny(true), { cls: 'btn-sm' }));
      return;
    }
    if (!catalog) return;
    const card = (item) => {
      const inLib = !!editor.assets.findTinyimgen(item.id, item.role), loading = busy.has(`${item.role}:${item.id}`);
      const what = item.role === 'prop' ? `${item.hands === 2 ? 'Two hands' : 'One hand'} · ${item.hold}` : 'Rigged character';
      return h('button', { class: `tiny-card${loading ? ' busy' : ''}`, title: `${item.name} (tinyimgen ${item.id})`, onclick: () => useItem(item) },
        item.thumb ? h('img', { src: item.thumb, alt: '', loading: 'lazy' }) : h('span', { class: 'thumb-ph' }, item.role === 'prop' ? '🗡' : '🧍'),
        h('span', { class: 'tiny-name' }, item.name),
        h('small', {}, loading ? 'Downloading…' : inLib ? `${what} · in library` : what));
    };
    const group = (title, items, empty) => [
      h('div', { class: 'row-label sub' }, title),
      items.length ? h('div', { class: 'tiny-grid' }, ...items.map(card)) : h('p', { class: 'hint' }, empty),
    ];
    tiny.replaceChildren(
      ...group('Characters', catalog.characters, 'None yet: build a human with "Rig + animations" on.'),
      ...group('Holdable props', catalog.props, 'None yet: open a 3D object in tinyimgen\'s Prop Editor (Make holdable ✋) and save its grips.'),
      h('p', { class: 'hint' }, 'Click to place. With a character selected, clicking a prop puts it in their hand. You can also drag a prop onto a character in the Scene list.'),
    );
  };
  loadTiny();

  const render = () => {
    renderTiny();
    const assets = editor.assets.list();
    const counts = new Map();
    editor.objects.forEach((o) => { if (o.entity.kind === 'asset') counts.set(o.entity.assetId, (counts.get(o.entity.assetId) ?? 0) + 1); });
    if (!assets.length) {
      list.replaceChildren(h('p', { class: 'hint center' }, 'No models yet. Imported models are stored inside the project file.'));
      return;
    }
    list.replaceChildren(...assets.map((a) => {
      const active = editor.mode === 'place' && editor._placeSpec?.assetId === a.id;
      return h('div', { class: `asset${active ? ' active' : ''}`, title: 'Click to place', onclick: () => editor.startPlacement({ kind: 'asset', assetId: a.id }) },
        a.thumbnail ? h('img', { src: a.thumbnail, alt: '' }) : h('div', { class: 'thumb-ph' }, '⬢'),
        h('div', { class: 'asset-info' },
          h('strong', {}, a.name),
          h('small', {}, `${a.size.x.toFixed(1)} × ${a.size.y.toFixed(1)} × ${a.size.z.toFixed(1)} m · ${formatBytes(a.buffer.byteLength)}`),
          h('small', {}, [`${counts.get(a.id) ?? 0} placed`, a.rig && 'rigged', a.prop && `holdable (${a.prop.hands === 2 ? '2 hands' : '1 hand'})`,
            a.animations.length && `${a.animations.length} anim`].filter(Boolean).join(' · ')),
        ),
        button('✕', (e) => {
          e.stopPropagation();
          const n = counts.get(a.id) ?? 0;
          const doIt = () => {
            for (const o of [...editor.objects]) if (o.entity.assetId === a.id && editor.inScene(o)) editor._detach(o);
            editor.assets.remove(a.id);
            editor.history.clear();
            editor.emit('sceneChanged');
            toast(`Removed ${a.name}`);
          };
          if (!n) return doIt();
          modal('Remove model?', h('p', {}, `"${a.name}" is placed ${n} time(s). Removing it deletes those objects (and their children) and clears undo history.`), {
            actions: [{ label: 'Cancel', run: () => {} }, { label: 'Remove', cls: 'btn-danger', run: doIt }],
          });
        }, { cls: 'btn-ghost btn-sm', title: 'Remove from library' }),
      );
    }));
  };
  editor.assets.addEventListener('changed', render);
  editor.on('sceneChanged', render);
  editor.on('modeChanged', render);
  editor.on('placementChanged', render);
  render();
}

// ====================================================================== Outliner

const boneLabel = (bone) => bone.replace(/^(Left|Right)Hand_Socket$/, (_, side) => `${side[0]} hand`);

/** The scene tree. Drag rows onto each other to parent them (onto "Map & Terrain" for the top level). */
export function outliner(root, editor) {
  let filter = '', dragging = null;
  const collapsed = new WeakSet();
  const list = h('div', { class: 'outliner-list' });
  root.append(
    h('div', { class: 'outliner-head' },
      textInput({ value: '', placeholder: 'Filter objects…', onInput: (v) => { filter = v.toLowerCase(); render(); } })),
    list,
  );

  const canDrop = (target) => dragging && !dragging.some((d) => target && isWithin(target, d));
  const clearDrop = () => list.querySelectorAll('.drop-into').forEach((r) => r.classList.remove('drop-into'));
  const dropTarget = (el, target) => {
    el.addEventListener('dragover', (e) => {
      if (!canDrop(target)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      clearDrop();
      el.classList.add('drop-into');
    });
    el.addEventListener('drop', (e) => {
      if (!canDrop(target)) return;
      e.preventDefault();
      e.stopPropagation();
      const objs = dragging;
      dragging = null;
      clearDrop();
      if (target) collapsed.delete(target);
      editor.setParent(objs, target);
    });
  };
  dropTarget(list, null);
  list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) clearDrop(); });

  const render = () => {
    const sel = editor.selected;
    const match = (o) => !filter || o.name.toLowerCase().includes(filter) || o.entity.props.tags.toLowerCase().includes(filter);
    // Depth-first rows. With a filter, an object shows if it or anything below it matches.
    const rows = [];
    const walk = (o, depth) => {
      const kids = childEntities(o), at = rows.length;
      rows.push({ o, depth, kids: kids.length });
      let shown = match(o);
      if (filter || !collapsed.has(o)) for (const k of kids) shown = walk(k, depth + 1) || shown;
      if (!shown) rows.length = at;
      return shown;
    };
    editor.roots.forEach((o) => walk(o, 0));
    const order = rows.map((r) => r.o);
    const click = (e, o) => {
      if (editor.mode !== 'select') editor.setMode('select');
      if (e.ctrlKey || e.metaKey) editor.toggleSelect(o);
      else if (e.shiftKey && sel) {
        // Range from the primary selection to the clicked row (in list order).
        const a = order.indexOf(sel), b = order.indexOf(o);
        const range = a < 0 ? [o] : order.slice(Math.min(a, b), Math.max(a, b) + 1);
        editor.setSelection([...editor.selection.filter((x) => !range.includes(x)), ...range.filter((x) => x !== o), o]);
      } else editor.select(o);
    };
    const terrain = h('div', { class: `ol-row ol-terrain${!sel ? ' selected' : ''}`, onclick: () => editor.select(null), title: 'Map settings · drop objects here to move them to the top level' },
      h('span', { class: 'ol-icon' }, '⛰'), h('span', { class: 'ol-name' }, 'Map & Terrain'));
    dropTarget(terrain, null);
    list.replaceChildren(terrain, ...rows.map(({ o, depth, kids }) => {
      const open = filter || !collapsed.has(o);
      const r = h('div', {
        class: `ol-row${editor.isSelected(o) ? ' selected' : ''}${o.visible ? '' : ' hidden'}`,
        style: `padding-left: ${4 + depth * 14}px`,
        draggable: true,
        onclick: (e) => click(e, o),
        ondblclick: () => editor.focus(o),
        ondragstart: (e) => {
          dragging = editor.isSelected(o) ? editor.topmost(editor.selection) : [o];
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('application/x-3dmap-objects', dragging.map((d) => d.name).join(', '));
        },
        ondragend: () => { dragging = null; clearDrop(); },
      },
      h('span', {
        class: `ol-twist${kids ? '' : ' empty'}`,
        title: kids ? (open ? 'Collapse' : 'Expand') : '',
        onclick: (e) => {
          if (!kids || filter) return;
          e.stopPropagation();
          if (collapsed.has(o)) collapsed.delete(o); else collapsed.add(o);
          render();
        },
      }, kids ? (open ? '▾' : '▸') : ''),
      h('span', { class: 'ol-icon' }, entityIcon(o)),
      h('span', { class: 'ol-name' }, o.name),
      o.entity.attach ? h('span', { class: 'ol-bone', title: `Attached to ${o.entity.attach}` }, boneLabel(o.entity.attach)) : null,
      h('button', { class: 'ol-eye', title: o.visible ? 'Hide' : 'Show', onclick: (e) => { e.stopPropagation(); editor.setVisible(o, !o.visible); render(); } }, o.visible ? '👁' : '—'));
      dropTarget(r, o);
      if (o === sel) queueMicrotask(() => r.scrollIntoView({ block: 'nearest' }));
      return r;
    }));
  };
  editor.on('sceneChanged', render);
  editor.on('selectionChanged', () => {
    // reveal the selection inside collapsed parents
    for (const o of editor.selection) for (let p = parentEntity(o); p; p = parentEntity(p)) collapsed.delete(p);
    render();
  });
  editor.on('objectChanged', render);
  render();
}
