// Performance overlay for the playtest: FPS / frame times, draw calls, and GPU memory allocated by this page.
//
// GPU memory comes from webgl-memory, which wraps the WebGL context and tallies every buffer, texture,
// renderbuffer and the canvas itself. Browsers don't expose real VRAM usage, so this is what *this page*
// has allocated on the GPU, not the whole card. It must be imported before the WebGL context is created.
import 'webgl-memory';

const MB = 1024 * 1024;
const fmtMB = (bytes) => (bytes / MB).toFixed(bytes < 10 * MB ? 2 : 1);
const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export class PerfHud {
  /** @param {import('three').WebGLRenderer} renderer */
  constructor(renderer, { interval = 500 } = {}) {
    this.renderer = renderer;
    this.interval = interval;
    const gl = renderer.getContext();
    this.memExt = gl.getExtension('GMAN_webgl_memory');
    this.gpuName = gpuName(gl);

    this.el = document.createElement('div');
    this.el.id = 'perf';
    this.el.title = 'F3 to hide';
    document.body.append(this.el);

    this._windowStart = performance.now();
    this._lastFrame = 0;
    this._frames = 0;
    this._worst = 0;
    this._cpuSum = 0;
    this._cpuStart = 0;
    this.visible = true;
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'F3') return;
      e.preventDefault();
      this.visible = !this.visible;
      this.el.hidden = !this.visible;
    });
  }

  /** Call at the start of each frame, before update + render. */
  begin() {
    const now = performance.now();
    if (this._lastFrame) this._worst = Math.max(this._worst, now - this._lastFrame);
    this._lastFrame = now;
    this._cpuStart = now;
  }

  /** Call right after renderer.render() (draw-call stats reset on every render). */
  end() {
    const now = performance.now();
    this._cpuSum += now - this._cpuStart;
    this._frames++;
    const elapsed = now - this._windowStart;
    if (elapsed < this.interval) return;

    const fps = (this._frames * 1000) / elapsed;
    const stats = {
      fps,
      frameMs: elapsed / this._frames,
      worstMs: this._worst,
      cpuMs: this._cpuSum / this._frames,
    };
    this._windowStart = now;
    this._frames = 0;
    this._worst = 0;
    this._cpuSum = 0;
    if (this.visible) this._draw(stats);
  }

  _draw({ fps, frameMs, worstMs, cpuMs }) {
    const info = this.renderer.info;
    const fpsClass = fps >= 55 ? 'good' : fps >= 30 ? 'warn' : 'bad';
    const rows = [
      `<div class="perf-big"><span class="${fpsClass}">${Math.round(fps)}</span> FPS</div>`,
      row('Frame', `${frameMs.toFixed(1)} ms · worst ${worstMs.toFixed(1)}`),
      row('CPU', `${cpuMs.toFixed(2)} ms`, 'Time spent in update + render() on the CPU each frame (GPU work runs async)'),
      row('Draw calls', fmtCount(info.render.calls)),
      row('Triangles', fmtCount(info.render.triangles)),
    ];

    if (this.memExt) {
      const { memory: m, resources: r } = this.memExt.getMemoryInfo();
      rows.push(
        `<div class="perf-big perf-mem">${fmtMB(m.total)} <small>MB GPU</small></div>`,
        row('Textures', `${fmtMB(m.texture)} MB · ${r.texture}`),
        row('Buffers', `${fmtMB(m.buffer)} MB · ${r.buffer}`),
        row('Render targets', `${fmtMB(m.renderbuffer)} MB · ${r.renderbuffer}`),
        row('Canvas', `${fmtMB(m.drawingbuffer)} MB`),
        row('Programs', String(r.program)),
      );
    } else {
      rows.push(row('GPU memory', 'unavailable'));
    }

    const heap = performance.memory; // Chromium only
    if (heap) rows.push(row('JS heap', `${fmtMB(heap.usedJSHeapSize)} / ${Math.round(heap.jsHeapSizeLimit / MB)} MB`));
    if (this.gpuName) rows.push(`<div class="perf-gpu" title="${escapeHtml(this.gpuName)}">${escapeHtml(this.gpuName)}</div>`);
    this.el.innerHTML = rows.join('');
  }
}

function row(label, value, title = '') {
  return `<div class="perf-row"${title ? ` title="${title}"` : ''}><span>${label}</span><b>${value}</b></div>`;
}

function gpuName(gl) {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const name = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  return typeof name === 'string' ? name : '';
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
