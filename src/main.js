import './styles.css';
import { Editor } from './editor/Editor.js';
import { serializeProject, loadProject, projectToJSON, projectFromJSON } from './editor/Project.js';
import { exportMap, exportLayoutJSON } from './editor/Export.js';
import { Inspector } from './ui/Inspector.js';
import { buildPanel, terrainPanel, assetsPanel, outliner } from './ui/Panels.js';
import { h, button, toast, modal, numberInput, row, checkbox } from './ui/dom.js';
import { downloadBlob, saveBlobAs, pickFiles, slug } from './core/utils.js';
import { idbGet, idbSet, idbDelete } from './core/storage.js';
import { entitySubtree, isShown } from './editor/Entities.js';
import { entityRig } from './editor/Rig.js';
import { watchTinyimgenProps } from './editor/Tinyimgen.js';
import { watchEngineModels } from './editor/EngineModels.js';
import { connectEngineClips } from './editor/EngineClips.js';
import { ClipLibrary } from './anim/clips.js';
import { AnimEditor } from './anim/AnimEditor.js';
import { ScriptLibrary } from './editor/Scripts.js';
import { ScriptEditor } from './ui/ScriptEditor.js';
import { explorer } from './ui/Explorer.js';
import { PlayMode } from './ui/PlayMode.js';
import { folderSupported } from './editor/ProjectFolder.js';
import { ProjectSync } from './editor/ProjectSync.js';

const $ = (id) => document.getElementById(id);
const editor = new Editor($('viewport'));
window.editor = editor; // handy for console tinkering

// The map's scripts (saved with the project, exported in the map GLB, run by src/runtime/scripts.js).
const scripts = (editor.scripts = new ScriptLibrary());
scripts.addEventListener('changed', () => { editor.emit('scriptsChanged'); editor.emit('changed'); });

// The animation clip library lives in the engine (engine/clips/, EngineClips.js), shared by every project; projects
// don't keep clips. The animation editor edits it; ▶ Play hands it to the playtest, and exported maps carry it.
// IndexedDB keeps a copy for when the editor runs without the engine library (a static build).
const clips = (editor.clips = new ClipLibrary());
const clipsLoaded = (async () => {
  const cached = await idbGet('clip-library').catch(() => null);
  const migrated = await idbGet('clip-library-in-engine').catch(() => false);
  // the browser's library from before the engine kept clips joins the engine once (the engine's versions win)
  if (await connectEngineClips(clips, { ui: { toast }, legacy: migrated ? null : cached })) {
    if (!migrated) idbSet('clip-library-in-engine', true).catch(() => {});
  } else {
    clips.load(cached);
  }
})().catch((err) => console.warn('clip library', err));
let clipsTimer = null;
clips.addEventListener('changed', () => {
  clearTimeout(clipsTimer);
  clipsTimer = setTimeout(() => idbSet('clip-library', clips.toJSON()).catch(() => {}), 800);
});

// ------------------------------------------------------------------ actions

async function importGLBFiles(files) {
  let last = null;
  for (const file of files) {
    try {
      const asset = await editor.assets.add(file.name, await file.arrayBuffer());
      last = asset;
      toast(`Imported ${asset.name}`, { type: 'ok' });
    } catch (err) {
      console.error(err);
      toast(`Failed to import ${file.name}: ${err.message}`, { type: 'error', timeout: 6000 });
    }
  }
  if (last) {
    showTab('assets');
    editor.startPlacement({ kind: 'asset', assetId: last.id });
  }
}

const importGLB = async () => importGLBFiles(await pickFiles('.glb,.gltf', true));

async function openProjectFile(file) {
  try {
    const data = projectFromJSON(await file.text());
    sync.setFolder(null); // first: the old folder mustn't follow the editor emptying out (a single-file project: Ctrl+S asks)
    await loadProject(editor, data, { onWarning: (m) => toast(m, { type: 'error', timeout: 6000 }) });
    toast(`Opened ${data.name ?? file.name}`, { type: 'ok' });
  } catch (err) {
    console.error(err);
    toast(`Could not open project: ${err.message}`, { type: 'error', timeout: 6000 });
  }
}

const openProjectFileDialog = async () => {
  const [file] = await pickFiles('.json,.map.json');
  if (file) openProjectFile(file);
};
const openProject = () => (folderSupported ? openProjectFolder() : openProjectFileDialog());

// ------------------------------------------------------------------ project folder

const confirmBox = (title, text, ok) => new Promise((resolve) => {
  modal(title, h('p', {}, text), { actions: [{ label: 'Cancel', run: () => resolve(false) }, { label: ok, cls: 'btn-primary', run: () => resolve(true) }] });
});

// The project as a folder of files (ProjectFolder.js): scripts/ and assets/ are written as they change; Ctrl+S
// writes project.json. Edits made outside (VS Code) come in while it's open.
const sync = new ProjectSync(editor, {
  toast,
  confirm: confirmBox,
  scriptChangedOnDisk: (id, text) => scriptEditor.external(id, text),
  reloadGame: () => refreshPlaytest(),
});
sync.addEventListener('changed', () => syncStatus());
const openProjectFolder = () => sync.open();

/** Ctrl+S: into the project's folder (asking for one the first time), or a single file where folders don't work. */
async function saveProject({ as = false } = {}) {
  if (!folderSupported) return saveProjectFile();
  if (await sync.save({ as })) { saveState = `saved to ${sync.name}/`; syncStatus(); }
}

/** The whole project in one .map.json file (models embedded). */
async function saveProjectFile() {
  try {
    // The picker opens before serializing so it still has the click/keypress's user activation.
    const saved = await saveBlobAs(
      () => new Blob([projectToJSON(serializeProject(editor))], { type: 'application/json' }),
      `${slug(editor.mapName)}.map.json`,
      { description: 'Map project', accept: { 'application/json': ['.json'] } },
    );
    if (saved) toast('Project saved', { type: 'ok' });
  } catch (err) {
    console.error(err);
    toast(`Save failed: ${err.message}`, { type: 'error', timeout: 6000 });
  }
}

async function exportGLB(binary = true) {
  try {
    const blob = await exportMap(editor, { binary, ...exportOpts });
    downloadBlob(blob, `${slug(editor.mapName)}.${binary ? 'glb' : 'gltf'}`);
    toast(`Exported ${binary ? 'GLB' : 'glTF'} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`, { type: 'ok' });
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message}`, { type: 'error', timeout: 6000 });
  }
}

const exportOpts = { includeTerrain: true, includeMarkers: true };

function exportDialog() {
  modal('Export map', h('div', {},
    h('p', {}, 'The GLB contains the terrain mesh, all placed objects and markers (as empty nodes), with game data in each node\'s ', h('code', {}, 'userData'), '. Load it with ', h('code', {}, 'GLTFLoader'), ' or the bundled ', h('code', {}, 'MapLoader.js'), '.'),
    row('Terrain', checkbox({ value: exportOpts.includeTerrain, onChange: (v) => { exportOpts.includeTerrain = v; }, label: 'Include terrain mesh' })),
    row('Markers', checkbox({ value: exportOpts.includeMarkers, onChange: (v) => { exportOpts.includeMarkers = v; }, label: 'Include spawns / triggers / lights' })),
  ), {
    actions: [
      { label: 'Layout JSON', run: () => { downloadBlob(exportLayoutJSON(editor), `${slug(editor.mapName)}.layout.json`); } },
      { label: 'glTF (.gltf)', run: () => { exportGLB(false); } },
      { label: 'Export .glb', cls: 'btn-primary', run: () => { exportGLB(true); } },
    ],
  });
}

/**
 * The playtest's player: the first visible Player Spawn with a rigged model below it. The playtest plays that model
 * (from its original GLB, which has the animations the exported map leaves out) and moves whatever it holds onto it.
 */
function playtestPlayer() {
  for (const spawn of editor.objects) {
    if (spawn.entity.kind !== 'marker' || spawn.entity.type !== 'spawn' || !isShown(spawn)) continue;
    const character = entitySubtree(spawn).find((o) => o !== spawn && isShown(o) && entityRig(o, editor.assets));
    if (!character) continue;
    const asset = editor.assets.get(character.entity.assetId);
    // its height in the editor: the asset's size times its world scale
    const scale = character.getWorldScale(character.scale.clone()).y;
    return { spawnId: spawn.entity.id, characterId: character.entity.id, name: character.name, buffer: asset.buffer, scale, height: asset.size.y * scale, controller: asset.meta?.controller ?? null };
  }
  return null;
}

/** Export the map (and the player's model) for the playtest page to load. */
async function writePlaytest() {
  const blob = await exportMap(editor, { binary: true, includeTerrain: true, includeMarkers: true });
  const player = playtestPlayer();
  await (player ? idbSet('playtest-player', player) : idbDelete('playtest-player'));
  await idbSet('playtest', await blob.arrayBuffer());
  await idbSet('playtest-clips', clips.toJSON());
}

/** Re-export the playtest and have an open playtest tab reload it in place (nothing listens if none is open). */
async function refreshPlaytest() {
  try {
    await writePlaytest();
    playtestChannel.postMessage({ type: 'reload' });
    playMode.reloaded();
  } catch (err) {
    console.error(err);
    toast(`Couldn't update the playtest: ${err.message}`, { type: 'error' });
  }
}

const playtestChannel = new BroadcastChannel('3dmap-playtest');

async function playtest() {
  try {
    await writePlaytest();
    window.open('./game.html?playtest=1', '3dmap-playtest');
  } catch (err) {
    console.error(err);
    toast(`Playtest failed: ${err.message}`, { type: 'error' });
  }
}

// A prop re-saved in tinyimgen's Prop Editor shows up here without re-importing it, and in a playtest tab if one
// is open (it reloads the map in place when told to; with none open, nothing listens).
let playtestRefresh = null;
watchTinyimgenProps(editor, {
  onUpdate: (asset, placed) => {
    toast(`Updated ${asset.name} from tinyimgen${placed ? ` (${placed} placed)` : ''}`, { type: 'ok' });
    clearTimeout(playtestRefresh); // several props saved at once: one reload
    playtestRefresh = setTimeout(refreshPlaytest, 300);
  },
});

// Models shared through the engine (engine/models/) follow it: a newer engine version replaces the project's copy and
// its placed objects, and project models identical to an engine model get linked to it.
watchEngineModels(editor, {
  onUpdate: (asset, placed) => {
    toast(`Updated ${asset.name} from the engine${placed ? ` (${placed} placed)` : ''}`, { type: 'ok' });
    clearTimeout(playtestRefresh);
    playtestRefresh = setTimeout(refreshPlaytest, 300);
  },
});

// ▶ Play runs the playtest inside the viewport (↗ opens it in a tab instead).
const playBtn = button('▶ Play', () => playMode.toggle(), { cls: 'btn-play', title: 'Play the map right here (Ctrl+P)' });
const playMode = new PlayMode(editor, {
  prepare: writePlaytest,
  openInTab: () => playtest(),
  onChange: () => {
    playBtn.textContent = playMode.starting && !playMode.playing ? 'Starting…' : playMode.playing ? '⏹ Stop' : '▶ Play';
    playBtn.classList.toggle('btn-danger', playMode.playing);
    playBtn.disabled = playMode.starting && !playMode.playing;
    document.body.classList.toggle('playing', playMode.playing);
  },
});
window.playMode = playMode;

const animEditor = new AnimEditor(editor, clips, {
  onClose: ({ changed }) => {
    if (playMode.playing) editor.setPaused(true); // the game still covers the viewport
    if (changed) refreshPlaytest();
  },
});
window.animEditor = animEditor;

// Saving a script reloads an open playtest, so a change shows up right away.
const scriptEditor = new ScriptEditor(scripts, { onSaved: () => refreshPlaytest() });
editor.on('openScript', (id) => scriptEditor.open(id));
const openAnimEditor = async () => {
  await clipsLoaded;
  animEditor.open().catch((err) => { console.error(err); toast(`Animation editor: ${err.message}`, { type: 'error', timeout: 6000 }); });
};

async function importHeightmap(file) {
  if (!file) [file] = await pickFiles('image/*');
  if (!file) return;
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  const opts = { maxHeight: 30, base: 0 };
  modal('Import heightmap', h('div', {},
    h('p', {}, `${file.name} (${img.width}×${img.height}) will be resampled to the terrain grid. Black = base, white = base + max height.`),
    row('Max height', numberInput({ value: opts.maxHeight, step: 1, onChange: (v) => { opts.maxHeight = v; } })),
    row('Base', numberInput({ value: opts.base, step: 1, onChange: (v) => { opts.base = v; } })),
  ), {
    actions: [
      { label: 'Cancel', run: () => URL.revokeObjectURL(img.src) },
      { label: 'Apply', cls: 'btn-primary', run: () => { editor.terrainCommand('Import heightmap', (t) => t.loadHeightmap(img, opts)); URL.revokeObjectURL(img.src); } },
    ],
  });
}

function exportHeightmap() {
  const { canvas, min, max } = editor.terrain.toHeightmapCanvas();
  canvas.toBlob((blob) => {
    downloadBlob(blob, `${slug(editor.mapName)}_heightmap_${min.toFixed(2)}_${max.toFixed(2)}.png`);
    toast(`Heightmap range ${min.toFixed(2)} → ${max.toFixed(2)} m (in filename)`);
  });
}

function newMap() {
  modal('New map?', h('p', {}, 'This clears the current map. Save first if you want to keep it.'), {
    actions: [
      { label: 'Cancel', run: () => {} },
      { label: 'Clear map', cls: 'btn-danger', run: () => { sync.setFolder(null); editor.clearAll(); toast('New map'); } },
    ],
  });
}

function showHelp() {
  const keys = [
    ['Right-drag', 'Orbit camera'], ['Middle-drag / Shift+Right-drag', 'Pan'], ['Wheel', 'Zoom (to cursor)'],
    ['Hold Right mouse + W A S D', 'Fly (mouse looks around)'], ['… + Q / E', 'Fly down / up'], ['… + Shift', 'Fly 3× faster'],
    ['… + Wheel', 'Change fly speed'], ['Arrows / PageUp / PageDown', 'Fly without holding the mouse'],
    ['Left-click', 'Select / place / sculpt'], ['Double-click', 'Focus selection'],
    ['Shift / Ctrl + click', 'Add or remove an object from the selection'], ['Left-drag on empty space', 'Box select (hold Shift/Ctrl to add)'],
    ['Ctrl+A', 'Select all'], ['Hold Shift while scaling', 'Scale one side only (the opposite side stays put)'],
    ['Hold Alt while dragging the gizmo', 'Duplicate and move the copy (original stays)'],
    ['W / E / R', 'Move / Rotate / Scale gizmo'], ['Q', 'Toggle world / local space'],
    ['X', 'Toggle grid snapping (move, rotate, scale, placement)'], ['Hold Ctrl', 'Temporarily flip snapping while dragging / placing'],
    ['Shift+S', 'Snap selected object to grid'],
    ['Drag rows in the Scene list', 'Parent objects (drop a prop on a character to put it in their hand)'],
    ['B', 'Toggle sculpt mode'], ['[ / ]', 'Brush radius'], ['1–6', 'Brush tool (in sculpt mode)'],
    ['F', 'Focus selected (or whole map)'], ['G', 'Drop selected to ground'],
    ['Ctrl+D', 'Duplicate'], ['Delete / Backspace', 'Delete'], ['Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y', 'Undo / Redo'],
    ['Ctrl+S', 'Save project'], ['Ctrl+E', 'Export map'], ['Ctrl+P', 'Play in the editor / stop'], ['Shift+Click (placing)', 'Keep placing'], ['Esc', 'Cancel / deselect'],
  ];
  modal('Controls', h('table', { class: 'keys' }, ...keys.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d)))));
}

// ------------------------------------------------------------------ top bar

const menu = (label, items) => {
  const dd = h('div', { class: 'menu-dd' }, ...items.map((it) => it === '-' ? h('hr') :
    h('button', { class: 'menu-item', onclick: () => { wrap.classList.remove('open'); it[1](); } }, h('span', {}, it[0]), h('kbd', {}, it[2] ?? ''))));
  const wrap = h('div', { class: 'menu' }, h('button', { class: 'btn btn-ghost', onclick: (e) => { e.stopPropagation(); document.querySelectorAll('.menu.open').forEach((m) => m !== wrap && m.classList.remove('open')); wrap.classList.toggle('open'); } }, label), dd);
  return wrap;
};
document.addEventListener('click', () => document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')));

const undoBtn = button('↶', () => editor.history.undo(), { cls: 'btn-icon', title: 'Undo (Ctrl+Z)' });
const redoBtn = button('↷', () => editor.history.redo(), { cls: 'btn-icon', title: 'Redo (Ctrl+Shift+Z)' });
const modeBtns = [['translate', '✥', 'Move (W)'], ['rotate', '⟳', 'Rotate (E)'], ['scale', '⤢', 'Scale (R)']].map(([m, icon, title]) => {
  const b = button(icon, () => editor.setTransformMode(m), { cls: 'btn-icon', title });
  b.mode = m;
  return b;
});
const spaceBtn = button('World', () => editor.setSpace(editor.transform.space === 'world' ? 'local' : 'world'), { cls: 'btn-sm', title: 'Gizmo space (Q)' });
const snapBtn = button('⌗ Snap', () => editor.setSnap({ enabled: !editor.snap.enabled }), { cls: 'btn-sm', title: 'Toggle grid snapping (X). Hold Ctrl while dragging to toggle temporarily.' });
const snapT = numberInput({ value: editor.snap.translate, step: 0.25, min: 0.01, onChange: (v) => editor.setSnap({ translate: v }), title: 'Move snap / grid cell size (m)' });
const snapR = numberInput({ value: editor.snap.rotate, step: 5, min: 1, max: 180, onChange: (v) => editor.setSnap({ rotate: v }), title: 'Rotate snap (degrees)' });
const snapS = numberInput({ value: editor.snap.scale, step: 0.05, min: 0.01, onChange: (v) => editor.setSnap({ scale: v }), title: 'Scale snap (step)' });
const snapField = (icon, input, unit, title) => h('label', { class: 'snap-field', title }, h('span', {}, icon), input, h('small', {}, unit));

$('topbar').append(
  h('div', { class: 'brand' }, '⛰ ', h('span', {}, '3D Map Creator')),
  menu('File', [
    ['New map', newMap],
    ...(folderSupported ? [
      ['Open project folder…', openProjectFolder, 'Ctrl+O'],
      ['Save project', () => saveProject(), 'Ctrl+S'],
      ['Save project as folder…', () => saveProject({ as: true })],
      '-',
      ['Open project file (.map.json)…', openProjectFileDialog],
      ['Save as single file (.map.json)…', saveProjectFile],
    ] : [
      ['Open project…', openProjectFileDialog, 'Ctrl+O'],
      ['Save project', saveProjectFile, 'Ctrl+S'],
    ]),
    '-',
    ['Import GLB model…', importGLB, 'Ctrl+I'],
    ['Import heightmap…', () => importHeightmap()],
    '-',
    ['Export map…', exportDialog, 'Ctrl+E'],
    ['Export .glb (quick)', () => exportGLB(true)],
    ['Export layout JSON', () => downloadBlob(exportLayoutJSON(editor), `${slug(editor.mapName)}.layout.json`)],
    ['Export heightmap PNG', exportHeightmap],
  ]),
  menu('Edit', [
    ['Undo', () => editor.history.undo(), 'Ctrl+Z'],
    ['Redo', () => editor.history.redo(), 'Ctrl+Shift+Z'],
    '-',
    ['Duplicate', () => editor.duplicateSelected(), 'Ctrl+D'],
    ['Delete', () => editor.deleteSelected(), 'Del'],
    ['Drop to ground', () => editor.dropToGround(), 'G'],
    ['Snap to grid', () => editor.snapToGrid(), 'Shift+S'],
    ['Focus', () => editor.focus(), 'F'],
  ]),
  h('div', { class: 'sep' }),
  undoBtn, redoBtn,
  h('div', { class: 'sep' }),
  ...modeBtns, spaceBtn,
  h('div', { class: 'sep' }),
  snapBtn,
  h('span', { class: 'snap-vals' },
    snapField('✥', snapT, 'm', 'Move snap / grid cell size (m)'),
    snapField('⟳', snapR, '°', 'Rotate snap (degrees)'),
    snapField('⤢', snapS, '×', 'Scale snap (step)')),
  h('div', { class: 'spacer' }),
  button('🎬 Animate', openAnimEditor, { cls: 'btn', title: 'Animation editor: refine and make clips for tinyimgen characters' }),
  playBtn,
  button('↗', playtest, { cls: 'btn-icon', title: 'Playtest in a new tab' }),
  button('Export', exportDialog, { cls: 'btn-primary', title: 'Export map (Ctrl+E)' }),
  button('?', showHelp, { cls: 'btn-icon', title: 'Controls' }),
);

const syncToolbar = () => {
  undoBtn.disabled = !editor.history.canUndo;
  redoBtn.disabled = !editor.history.canRedo;
  undoBtn.title = editor.history.canUndo ? `Undo ${editor.history.undos.at(-1).label} (Ctrl+Z)` : 'Undo';
  redoBtn.title = editor.history.canRedo ? `Redo ${editor.history.redos.at(-1).label} (Ctrl+Shift+Z)` : 'Redo';
  modeBtns.forEach((b) => b.classList.toggle('active', editor.mode === 'select' && editor.transform.mode === b.mode));
  spaceBtn.textContent = editor.transform.space === 'world' ? 'World' : 'Local';
  snapBtn.classList.toggle('active', editor.snapActive);
  snapBtn.classList.toggle('snap-temp', editor.snapActive !== editor.snap.enabled);
  snapT.setValue(editor.snap.translate);
  snapR.setValue(editor.snap.rotate);
  snapS.setValue(editor.snap.scale);
};
['historyChanged', 'modeChanged', 'transformModeChanged', 'snapChanged'].forEach((ev) => editor.on(ev, syncToolbar));
syncToolbar();

// ------------------------------------------------------------------ left panel tabs

const TABS = [['build', 'Build'], ['terrain', 'Terrain'], ['assets', 'Models'], ['files', 'Files']];
const tabBtns = TABS.map(([id, label]) => h('button', { class: 'tab', onclick: () => showTab(id) }, label));
$('tabs').append(...tabBtns);
function showTab(id) {
  TABS.forEach(([tid], i) => {
    $(`tab-${tid}`).hidden = tid !== id;
    tabBtns[i].classList.toggle('active', tid === id);
  });
}
showTab('build');
editor.on('modeChanged', (m) => { if (m === 'sculpt') showTab('terrain'); });

buildPanel($('tab-build'), editor);
terrainPanel($('tab-terrain'), editor, { importHeightmap: () => importHeightmap(), exportHeightmap });
assetsPanel($('tab-assets'), editor, { importGLB });
explorer($('tab-files'), editor, sync, {
  openScript: (id) => scriptEditor.open(id),
  openClip: async (id) => { await clipsLoaded; await animEditor.open(); animEditor.selectClip(id); },
  importModels: () => importGLB(),
  openFolder: openProjectFolder,
  saveFolder: () => saveProject({ as: true }),
});
outliner($('outliner'), editor);
new Inspector($('inspector'), editor);

// ------------------------------------------------------------------ status bar

const HINTS = {
  select: 'Click / Shift+click / drag-box select · Right-drag orbit · Right-drag + WASD fly · W/E/R gizmo · Alt+drag duplicate · Shift+scale = one side',
  sculpt: 'Sculpting — left-drag to apply brush · [ ] radius · B or Esc to exit',
  place: 'Placing — click to place · Shift+click keep placing · Esc to cancel',
};
const syncStatus = () => {
  $('status-mode').textContent = HINTS[editor.mode];
  $('viewport-hint').textContent = editor.mode === 'select' ? '' : HINTS[editor.mode];
  $('viewport-hint').hidden = editor.mode === 'select';
  const n = editor.objects.length;
  $('status-info').textContent = `${editor.mapName}${sync?.name ? ` · 📁 ${sync.name}` : ''} · ${n} object${n === 1 ? '' : 's'}${saveState ? ` · ${saveState}` : ''}`;
};
let saveState = '';
editor.on('modeChanged', syncStatus);
editor.on('sceneChanged', syncStatus);
editor.on('changed', syncStatus);
editor.on('cursor', (p) => {
  $('status-cursor').textContent = p ? `x ${p.x.toFixed(2)}  y ${p.y.toFixed(2)}  z ${p.z.toFixed(2)}` : '';
});
syncStatus();

let speedToast = null, speedTimer;
editor.on('flySpeed', (v) => {
  const msg = `Fly speed ${v < 10 ? v.toFixed(1) : Math.round(v)} m/s`;
  if (speedToast?.isConnected) speedToast.firstChild.textContent = msg;
  else speedToast = toast(msg, { timeout: 0 });
  clearTimeout(speedTimer);
  speedTimer = setTimeout(() => speedToast?.remove(), 1200);
});

// ------------------------------------------------------------------ keyboard

const BRUSH_KEYS = ['raise', 'lower', 'smooth', 'flatten', 'noise', 'paint'];
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl) {
    if (k === 'z' && !e.shiftKey) { editor.history.undo(); e.preventDefault(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { editor.history.redo(); e.preventDefault(); }
    else if (k === 'd') { editor.duplicateSelected(); e.preventDefault(); }
    else if (k === 'a') { if (editor.mode !== 'select') editor.setMode('select'); editor.selectAll(); e.preventDefault(); }
    else if (k === 's') { saveProject(); e.preventDefault(); }
    else if (k === 'o') { openProject(); e.preventDefault(); }
    else if (k === 'e') { exportDialog(); e.preventDefault(); }
    else if (k === 'i') { importGLB(); e.preventDefault(); }
    else if (k === 'p') { playMode.toggle(); e.preventDefault(); }
    return;
  }
  if (e.altKey) return;
  switch (k) {
    case 'w': editor.setTransformMode('translate'); break;
    case 'e': editor.setTransformMode('rotate'); break;
    case 'r': editor.setTransformMode('scale'); break;
    case 'q': editor.setSpace(editor.transform.space === 'world' ? 'local' : 'world'); break;
    case 'x': editor.setSnap({ enabled: !editor.snap.enabled }); break;
    case 's': if (e.shiftKey) editor.snapToGrid(); break;
    case 'b': editor.setMode(editor.mode === 'sculpt' ? 'select' : 'sculpt'); break;
    case 'f': editor.focus(); break;
    case 'g': editor.dropToGround(); break;
    case 'delete': case 'backspace': editor.deleteSelected(); e.preventDefault(); break;
    case '[': editor.brush.radius = Math.max(0.5, editor.brush.radius / 1.15); editor.emit('brushChanged'); break;
    case ']': editor.brush.radius = Math.min(64, editor.brush.radius * 1.15); editor.emit('brushChanged'); break;
    case 'escape':
      if (editor.mode !== 'select') editor.setMode('select');
      else editor.select(null);
      break;
    default:
      if (editor.mode === 'sculpt' && /^[1-6]$/.test(k)) {
        editor.brush.mode = BRUSH_KEYS[+k - 1];
        editor.emit('brushChanged');
      }
  }
});

// ------------------------------------------------------------------ drag & drop

let dragDepth = 0;
const fileDrag = (e) => e.dataTransfer?.types.includes('Files'); // not the Scene list's own drags
window.addEventListener('dragenter', (e) => { if (!fileDrag(e)) return; e.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; });
window.addEventListener('dragleave', (e) => { if (fileDrag(e) && --dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
window.addEventListener('dragover', (e) => { if (fileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!fileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const files = [...e.dataTransfer.files];
  const models = files.filter((f) => /\.(glb|gltf)$/i.test(f.name));
  const project = files.find((f) => /\.json$/i.test(f.name));
  const image = files.find((f) => f.type.startsWith('image/'));
  if (project) await openProjectFile(project);
  if (models.length) await importGLBFiles(models);
  if (image && !models.length && !project) importHeightmap(image);
});

// ------------------------------------------------------------------ autosave

let autosaveTimer = null;
let restoring = true;
editor.on('changed', () => {
  if (restoring) return;
  clearTimeout(autosaveTimer);
  saveState = 'unsaved';
  syncStatus();
  autosaveTimer = setTimeout(async () => {
    try {
      await idbSet('autosave', serializeProject(editor));
      saveState = 'autosaved';
    } catch (err) {
      console.warn('autosave failed', err);
      saveState = 'autosave failed';
    }
    syncStatus();
  }, 1500);
});
['sceneChanged', 'terrainChanged', 'objectChanged'].forEach((ev) => editor.on(ev, () => editor.emit('changed')));

(async () => {
  try {
    const data = await idbGet('autosave');
    if (data) {
      await loadProject(editor, data, { onWarning: (m) => toast(m, { type: 'error', timeout: 6000 }), mergeClips: false });
      toast('Restored your last session', { type: 'ok' });
      // the session's project folder: reconnect (the browser may want a click to allow it again)
      await sync.reconnect(Date.parse(data.savedAt) || 0);
    } else {
      // First run: give the user something to look at.
      editor.terrainCommand('Generate terrain', (t) => {
        t.generate({ seed: 7, scale: 70, height: 14, octaves: 5, exponent: 1.6, base: -1 });
        t.autoPaint({ water: 0, snowHeight: 11.5 });
      });
      editor.history.clear();
      toast('Welcome! Press ? for controls.', { timeout: 5000 });
    }
  } catch (err) {
    console.error(err);
    toast(`Could not restore autosave: ${err.message}`, { type: 'error', timeout: 6000 });
  } finally {
    restoring = false;
  }
})();
