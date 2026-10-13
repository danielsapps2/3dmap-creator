// The Files tab: the project's files (scripts/, assets/, clips/) as a tree, plus what the engine provides (script
// templates, tinyimgen models) to copy into the project. Scripts drag onto objects (viewport, Scene list, Inspector)
// to attach; models click to place; clips open in the animation editor. With a project folder open, every change
// here is a change on disk (ProjectSync writes it).
import { h, button, toast, modal, contextMenu, prompt } from './dom.js';
import { TEMPLATES } from '../editor/Scripts.js';
import { tinyimgenCatalog, importTinyimgen } from '../editor/Tinyimgen.js';
import { duplicateClip, createClip } from '../anim/clips.js';
import { baseName, dirName, fileStem, uniquePath } from '../core/paths.js';
import { formatBytes, pickFiles } from '../core/utils.js';

export const DRAG_TYPE = 'application/x-3dmap-file';
const ICON = { script: '📜', template: '📜', model: '🧊', clip: '🎞', folder: '📁', engine: '⚙' };

/**
 * actions: { openScript(id), openClip(id), importModels(files), openFolder(), saveFolder() }
 * Returns { attach(objects, dragData) } for other drop targets.
 */
export function explorer(root, editor, sync, actions) {
  const { scripts, assets, clips } = editor;
  const open = new Set(['scripts', 'assets', 'clips', 'engine', 'engine/templates']);
  let selected = null; // path (or engine key)
  let tiny = null;     // tinyimgen catalog, once loaded

  // ---------------------------------------------------------------- operations

  const usage = (id) => editor.objects.filter((o) => o.entity.scripts?.some((r) => r.id === id));
  const modelUsage = (id) => editor.objects.filter((o) => o.entity.kind === 'asset' && o.entity.assetId === id);

  /** A script made from an engine template, saved into scripts/ (or `dir`). */
  const fromTemplate = (name, dir = 'scripts') => {
    const tpl = TEMPLATES.find((t) => t.name === name) ?? TEMPLATES[0];
    const script = scripts.add({ name: tpl.name === 'Empty' ? 'New script' : tpl.name, source: tpl.source, dir });
    toast(`Added ${script.path}${sync.name ? ` to ${sync.name}/` : ''}`, { type: 'ok' });
    return script;
  };

  /** Attach a dragged script (or template: copied into the project first) to objects. */
  const attach = (objs, data) => {
    objs = objs.filter(Boolean);
    if (!objs.length || !data) return;
    const id = data.kind === 'template' ? fromTemplate(data.name).id : data.id;
    const todo = objs.filter((o) => !o.entity.scripts.some((r) => r.id === id));
    if (!todo.length) return;
    editor.batchEdit(todo, 'Attach script', (o) => { o.entity.scripts.push({ id, params: {} }); });
    toast(`Attached ${scripts.get(id)?.name} to ${todo.length === 1 ? todo[0].name : `${todo.length} objects`}`, { type: 'ok' });
  };

  const renameScript = async (s) => {
    const name = await prompt('Rename script', { value: s.name, label: s.path, ok: 'Rename' });
    if (name && name !== s.name) scripts.update(s.id, { name });
  };
  const deleteScript = (s) => {
    const users = usage(s.id);
    modal('Delete script', h('p', {}, `Delete ${s.path}${users.length ? ` and take it off ${users.length} object${users.length === 1 ? '' : 's'}` : ''}?${sync.name ? ' The file is deleted from the folder.' : ''}`), {
      actions: [{ label: 'Cancel', run: () => {} }, {
        label: 'Delete', cls: 'btn-danger', run: () => {
          if (users.length) editor.batchEdit(users, 'Remove script', (o) => { o.entity.scripts = o.entity.scripts.filter((r) => r.id !== s.id); });
          scripts.remove(s.id);
        },
      }],
    });
  };
  const duplicateScript = (s) => scripts.add({ path: uniquePath(dirName(s.path), `${s.name} copy`, '.js', scripts.list().map((x) => x.path)), source: s.source });

  const renameModel = async (a) => {
    const name = await prompt('Rename model', { value: a.name, label: a.path, ok: 'Rename' });
    if (name && name !== a.name) assets.rename(a.id, name);
  };
  const deleteModel = (a) => {
    const users = modelUsage(a.id);
    modal('Delete model', h('p', {}, `Delete ${a.path}${users.length ? ` and the ${users.length} placed cop${users.length === 1 ? 'y' : 'ies'} of it` : ''}?`), {
      actions: [{ label: 'Cancel', run: () => {} }, {
        label: 'Delete', cls: 'btn-danger', run: () => {
          for (const o of users) if (editor.inScene(o)) editor._detach(o);
          assets.remove(a.id);
          editor.emit('sceneChanged');
        },
      }],
    });
  };

  const renameClip = async (c) => {
    const name = await prompt('Rename clip', { value: c.name, label: c.path, ok: 'Rename' });
    if (name && name !== c.name) { c.name = clips.uniqueName(name, c); clips.changed(); }
  };
  const deleteClip = (c) => modal('Delete clip', h('p', {}, `Delete ${c.path}?`), {
    actions: [{ label: 'Cancel', run: () => {} }, { label: 'Delete', cls: 'btn-danger', run: () => clips.remove(c.id) }],
  });

  const placeModel = (a) => {
    if (editor.mode !== 'select') editor.setMode('select');
    editor.startPlacement({ kind: 'asset', assetId: a.id });
  };
  const useEngineModel = async (item) => {
    try {
      const asset = await importTinyimgen(editor, item); // copied into the project's assets/
      placeModel(asset);
    } catch (err) {
      toast(`Couldn't import ${item.name}: ${err.message}`, { type: 'error', timeout: 6000 });
    }
  };
  const importScriptFiles = async (dir) => {
    for (const f of await pickFiles('.js,.mjs', true)) {
      scripts.add({ path: uniquePath(dir, fileStem(f.name.replace(/\.m?js$/, '')), '.js', scripts.list().map((s) => s.path)), source: await f.text() });
    }
  };

  // ---------------------------------------------------------------- tree

  /** Folder tree from paths: { name, path, dirs: Map, files: [] }. */
  const treeOf = (top, items) => {
    const rootNode = { name: top, path: top, dirs: new Map(), files: [] };
    for (const it of items) {
      let node = rootNode;
      const parts = it.path.split('/').slice(1, -1);
      for (const p of parts) {
        const path = `${node.path}/${p}`;
        if (!node.dirs.has(p)) node.dirs.set(p, { name: p, path, dirs: new Map(), files: [] });
        node = node.dirs.get(p);
      }
      node.files.push(it);
    }
    return rootNode;
  };

  const row = ({ depth, icon, label, sub, title, cls = '', onclick, ondblclick, oncontextmenu, drag, key }) => {
    const el = h('div', {
      class: `fx-row ${cls}${key && key === selected ? ' selected' : ''}`, title,
      style: `padding-left: ${6 + depth * 14}px`, tabindex: 0,
      onclick: (e) => { if (key) { selected = key; el.parentElement?.querySelectorAll('.fx-row.selected').forEach((r) => r.classList.remove('selected')); el.classList.add('selected'); } onclick?.(e); },
      ondblclick, oncontextmenu: oncontextmenu && ((e) => { e.preventDefault(); oncontextmenu(e); }),
      onkeydown: (e) => { if (e.key === 'Enter') (ondblclick ?? onclick)?.(e); },
    }, h('span', { class: 'fx-icon' }, icon), h('span', { class: 'fx-name' }, label), sub ? h('small', { class: 'fx-sub' }, sub) : null);
    if (drag) {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(drag));
        e.dataTransfer.setData('text/plain', label);
      });
    }
    return el;
  };

  const folderRow = (node, depth, { menu, count }) => row({
    depth, icon: open.has(node.path) ? '▾' : '▸', label: `${node.name}/`, sub: count ? String(count) : '', cls: 'fx-folder',
    onclick: () => { open.has(node.path) ? open.delete(node.path) : open.add(node.path); render(); },
    oncontextmenu: menu && ((e) => contextMenu(e.clientX, e.clientY, menu(node.path))),
  });

  const walk = (node, depth, fileRow, menu, out) => {
    out.push(folderRow(node, depth, { menu, count: countFiles(node) }));
    if (!open.has(node.path)) return;
    for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) walk(d, depth + 1, fileRow, menu, out);
    for (const f of node.files.sort((a, b) => a.path.localeCompare(b.path))) out.push(fileRow(f, depth + 1));
  };
  const countFiles = (n) => n.files.length + [...n.dirs.values()].reduce((s, d) => s + countFiles(d), 0);

  const scriptMenu = (dir) => [
    ['New script', () => actions.openScript(fromTemplate('Empty', dir).id)],
    ...TEMPLATES.filter((t) => t.name !== 'Empty').map((t) => [`New from template: ${t.name}`, () => actions.openScript(fromTemplate(t.name, dir).id)]),
    '-',
    ['Import .js files…', () => importScriptFiles(dir)],
  ];
  const modelMenu = () => [['Import models (.glb / .gltf)…', () => actions.importModels()]];
  const clipMenu = () => [['New clip (in the animation editor)', () => { const c = clips.add(createClip({ name: 'New clip' })); actions.openClip(c.id); }]];

  const render = () => {
    const out = [];
    const sel = editor.selection;
    const scriptRow = (s, depth) => {
      const n = usage(s.id).length;
      return row({
        depth, icon: ICON.script, label: baseName(s.path), sub: n ? `on ${n}` : '', key: s.path,
        title: `${s.path}\nDouble-click to edit · drag onto an object to attach`,
        ondblclick: () => actions.openScript(s.id),
        drag: { kind: 'script', id: s.id },
        oncontextmenu: (e) => contextMenu(e.clientX, e.clientY, [
          ['Edit', () => actions.openScript(s.id)],
          [sel.length ? `Attach to ${sel.length === 1 ? sel[0].name : `${sel.length} objects`}` : 'Attach to the selection', () => attach(sel, { kind: 'script', id: s.id }), { disabled: !sel.length }],
          '-',
          ['Rename…', () => renameScript(s)],
          ['Duplicate', () => duplicateScript(s)],
          ['Delete', () => deleteScript(s), { danger: true }],
        ]),
      });
    };
    const modelRow = (a, depth) => {
      const n = modelUsage(a.id).length;
      return row({
        depth, icon: ICON.model, label: baseName(a.path), sub: n ? `×${n}` : formatBytes(a.buffer.byteLength), key: a.path,
        title: `${a.path} · ${formatBytes(a.buffer.byteLength)}\nClick to place`,
        onclick: () => placeModel(a),
        oncontextmenu: (e) => contextMenu(e.clientX, e.clientY, [
          ['Place', () => placeModel(a)],
          '-',
          ['Rename…', () => renameModel(a)],
          ['Delete', () => deleteModel(a), { danger: true }],
        ]),
      });
    };
    const clipRow = (c, depth) => row({
      depth, icon: ICON.clip, label: baseName(c.path), sub: `${c.duration.toFixed(1)} s`, key: c.path,
      title: `${c.path}\nDouble-click to open in the animation editor`,
      ondblclick: () => actions.openClip(c.id),
      oncontextmenu: (e) => contextMenu(e.clientX, e.clientY, [
        ['Open in the animation editor', () => actions.openClip(c.id)],
        '-',
        ['Rename…', () => renameClip(c)],
        ['Duplicate', () => clips.add(duplicateClip(c))],
        ['Delete', () => deleteClip(c), { danger: true }],
      ]),
    });

    walk(treeOf('scripts', scripts.list()), 0, scriptRow, scriptMenu, out);
    walk(treeOf('assets', assets.list()), 0, modelRow, modelMenu, out);
    walk(treeOf('clips', clips.clips), 0, clipRow, clipMenu, out);

    // what the engine provides: used ones are copied into the project
    out.push(row({ depth: 0, icon: open.has('engine') ? '▾' : '▸', label: 'Engine', cls: 'fx-folder fx-engine', title: 'Built into the editor: using one copies it into the project', onclick: () => { open.has('engine') ? open.delete('engine') : open.add('engine'); render(); } }));
    if (open.has('engine')) {
      const sub = (key, label) => row({ depth: 1, icon: open.has(key) ? '▾' : '▸', label, cls: 'fx-folder fx-engine', onclick: () => { open.has(key) ? open.delete(key) : open.add(key); render(); } });
      out.push(sub('engine/templates', 'Script templates'));
      if (open.has('engine/templates')) {
        for (const t of TEMPLATES) {
          out.push(row({
            depth: 2, icon: ICON.template, label: t.name, cls: 'fx-engine-item', key: `tpl:${t.name}`,
            title: `${t.description}\nClick: copy into scripts/ and edit · drag onto an object: copy and attach`,
            onclick: () => actions.openScript(fromTemplate(t.name).id),
            drag: { kind: 'template', name: t.name },
          }));
        }
      }
      out.push(sub('engine/tinyimgen', 'tinyimgen models'));
      if (open.has('engine/tinyimgen')) {
        if (!tiny) {
          out.push(row({ depth: 2, icon: '…', label: 'Loading…', cls: 'fx-engine-item' }));
          tinyimgenCatalog().then((c) => { tiny = c; render(); }).catch((err) => { tiny = { error: err.message, characters: [], props: [] }; render(); });
        } else if (tiny.error) {
          out.push(row({ depth: 2, icon: '⚠', label: 'tinyimgen isn\'t running', title: tiny.error, cls: 'fx-engine-item' }));
        } else {
          for (const item of [...tiny.characters, ...tiny.props]) {
            const have = assets.list().find((a) => a.meta.tinyimgen?.id === item.id && a.meta.tinyimgen.role === item.role);
            out.push(row({
              depth: 2, icon: item.role === 'character' ? '🧍' : '🗡', label: item.name, sub: have ? 'in project' : item.role, cls: 'fx-engine-item',
              title: have ? `In the project as ${have.path}` : 'Click: copy into assets/ and place',
              onclick: () => useEngineModel(item),
            }));
          }
        }
      }
    }

    root.replaceChildren(
      h('div', { class: 'fx-head' },
        h('div', { class: 'fx-project', title: sync.name ? 'Changes to scripts, models and clips are written to this folder straight away; Ctrl+S saves the map' : '' },
          h('span', {}, sync.name ? `📁 ${sync.name}` : 'Not saved to a folder yet'),
          h('small', { class: 'muted' }, sync.name ? 'files are written as you work · Ctrl+S saves the map' : sync.supported ? 'files live in the editor until you save' : 'this browser saves single .map.json files')),
        sync.supported ? h('div', { class: 'btn-row' },
          button('Open folder…', () => actions.openFolder(), { cls: 'btn-sm' }),
          !sync.name ? button('Save to folder…', () => actions.saveFolder(), { cls: 'btn-sm btn-primary' }) : null) : null),
      h('div', { class: 'fx-tree' }, ...out),
      h('p', { class: 'hint fx-hint' }, 'Drag a script onto an object in the viewport, the Scene list or the Inspector to attach it. Right-click for more.'),
    );
  };

  // ---------------------------------------------------------------- drop targets: attach dragged scripts

  const dragged = (e) => {
    try { return JSON.parse(e.dataTransfer.getData(DRAG_TYPE)); } catch { return null; }
  };
  const isOurs = (e) => e.dataTransfer?.types.includes(DRAG_TYPE);
  const target = (el, objectsAt) => {
    el.addEventListener('dragover', (e) => {
      if (!isOurs(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add('fx-drop');
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('fx-drop'); });
    el.addEventListener('drop', (e) => {
      if (!isOurs(e)) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('fx-drop');
      const objs = objectsAt(e);
      if (!objs.length) { toast('Drop it on an object'); return; }
      attach(objs, dragged(e));
    });
  };
  target(document.getElementById('viewport'), (e) => [editor.pickAt(e)].filter(Boolean));
  target(document.getElementById('outliner'), (e) => {
    const id = e.target.closest?.('[data-entity]')?.dataset.entity;
    return id ? [editor.objects.find((o) => o.entity.id === id)] : [];
  });
  target(document.getElementById('right'), () => [...editor.selection]);

  for (const lib of [scripts, assets, clips]) lib.addEventListener('changed', render);
  sync.addEventListener('changed', render);
  for (const ev of ['selectionChanged', 'sceneChanged', 'objectChanged']) editor.on(ev, render);
  render();
  return { attach, fromTemplate };
}
