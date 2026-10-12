// Minimal DOM + form-control helpers used by all panels.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const row = (label, ...controls) =>
  h('div', { class: 'row' }, h('label', { class: 'row-label', title: label }, label), h('div', { class: 'row-control' }, ...controls));

export function section(title, children, { open = true, actions = null } = {}) {
  const d = h('details', { class: 'section', open });
  d.append(h('summary', {}, h('span', {}, title), actions), h('div', { class: 'section-body' }, ...[children].flat()));
  return d;
}

const fmt = (v, step) => {
  if (!Number.isFinite(v)) return '0';
  const decimals = step >= 1 ? 0 : Math.min(4, Math.max(1, Math.ceil(-Math.log10(step))));
  return String(Number(v.toFixed(decimals)));
};

/** Number input; dragging horizontally on it scrubs the value. */
export function numberInput({ value, step = 0.1, min = -Infinity, max = Infinity, int = false, onInput, onChange, title }) {
  const input = h('input', { type: 'number', class: 'num', step: String(step), value: fmt(value, step), title });
  const clampV = (v) => Math.min(max, Math.max(min, int ? Math.round(v) : v));
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onInput?.(clampV(v));
  });
  input.addEventListener('change', () => {
    let v = parseFloat(input.value);
    if (!Number.isFinite(v)) v = value;
    v = clampV(v);
    input.value = fmt(v, step);
    value = v;
    onChange?.(v);
  });
  // Scrub: alt-drag or drag while not focused
  let scrub = null;
  input.addEventListener('pointerdown', (e) => {
    if (document.activeElement === input) return;
    scrub = { x: e.clientX, start: parseFloat(input.value) || 0, moved: false };
    input.setPointerCapture(e.pointerId);
  });
  input.addEventListener('pointermove', (e) => {
    if (!scrub) return;
    const dx = e.clientX - scrub.x;
    if (!scrub.moved && Math.abs(dx) < 3) return;
    scrub.moved = true;
    e.preventDefault();
    const mult = e.shiftKey ? 10 : e.ctrlKey ? 0.1 : 1;
    const v = clampV(scrub.start + Math.round(dx / 2) * step * mult);
    input.value = fmt(v, step);
    onInput?.(v);
  });
  input.addEventListener('pointerup', () => {
    if (!scrub) return;
    const moved = scrub.moved;
    scrub = null;
    if (moved) {
      value = parseFloat(input.value);
      input.blur();
      onChange?.(value);
    } else {
      input.focus();
      input.select();
    }
  });
  input.setValue = (v) => {
    value = v;
    if (document.activeElement !== input) input.value = fmt(v, step);
  };
  return input;
}

export function slider({ value, min, max, step, onInput, onChange }) {
  const range = h('input', { type: 'range', min, max, step, value });
  const num = numberInput({
    value, step, min, max,
    onInput: (v) => { range.value = v; onInput?.(v); },
    onChange: (v) => { range.value = v; onChange?.(v); },
  });
  range.addEventListener('input', () => { num.setValue(parseFloat(range.value)); onInput?.(parseFloat(range.value)); });
  range.addEventListener('change', () => onChange?.(parseFloat(range.value)));
  const wrap = h('div', { class: 'slider' }, range, num);
  wrap.setValue = (v) => { range.value = v; num.setValue(v); };
  return wrap;
}

export function vec3Input({ value, step = 0.1, onInput, onChange }) {
  const v = [...value];
  const inputs = ['x', 'y', 'z'].map((axis, i) =>
    h('div', { class: `axis axis-${axis}` }, h('span', {}, axis.toUpperCase()), numberInput({
      value: v[i], step,
      onInput: (n) => { v[i] = n; onInput?.([...v]); },
      onChange: (n) => { v[i] = n; onChange?.([...v]); },
    })));
  const wrap = h('div', { class: 'vec3' }, ...inputs);
  wrap.setValue = (nv) => {
    nv.forEach((n, i) => { v[i] = n; inputs[i].querySelector('input').setValue(n); });
  };
  return wrap;
}

export function colorInput({ value, onInput, onChange }) {
  const input = h('input', { type: 'color', value });
  input.addEventListener('input', () => onInput?.(input.value));
  input.addEventListener('change', () => onChange?.(input.value));
  return input;
}

export function checkbox({ value, onChange, label }) {
  const input = h('input', { type: 'checkbox', checked: !!value });
  input.addEventListener('change', () => onChange?.(input.checked));
  return label ? h('label', { class: 'check' }, input, h('span', {}, label)) : input;
}

export function select({ value, options, onChange }) {
  const s = h('select', {}, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  s.addEventListener('change', () => onChange?.(s.value));
  return s;
}

export function textInput({ value, placeholder, onInput, onChange }) {
  const input = h('input', { type: 'text', value: value ?? '', placeholder });
  input.addEventListener('input', () => onInput?.(input.value));
  input.addEventListener('change', () => onChange?.(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  return input;
}

export const button = (label, onClick, { cls = '', title = '' } = {}) =>
  h('button', { class: `btn ${cls}`, title, onclick: onClick }, label);

let toastHost;
export function toast(message, { type = 'info', timeout = 3200, action } = {}) {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts' }));
  const t = h('div', { class: `toast toast-${type}` }, h('span', {}, message));
  if (action) t.append(button(action.label, () => { action.run(); t.remove(); }, { cls: 'btn-sm' }));
  toastHost.append(t);
  if (timeout) setTimeout(() => t.remove(), timeout);
  return t;
}

export function modal(title, body, { actions = [] } = {}) {
  const close = () => backdrop.remove();
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h3', {}, title), button('✕', close, { cls: 'btn-ghost' })),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-actions' }, ...actions.map((a) => button(a.label, () => { if (a.run() !== false) close(); }, { cls: a.cls }))) : null,
    ));
  document.body.append(backdrop);
  return close;
}
