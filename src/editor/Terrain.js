import * as THREE from 'three';
import { Perlin } from '../core/noise.js';
import { clamp, smoothstep } from '../core/utils.js';

export const DEFAULT_TERRAIN_COLOR = '#6b8f47';

/**
 * Heightfield terrain. Vertices are laid out on a (segments + 1)^2 grid centred on the origin:
 * index = iz * (segments + 1) + ix, x = ix * step - size / 2, z = iz * step - size / 2.
 */
export class Terrain {
  constructor({ size = 128, segments = 128 } = {}) {
    this.size = size;
    this.segments = segments;
    this.heights = new Float32Array((segments + 1) ** 2);
    this.colors = new Float32Array((segments + 1) ** 2 * 3);
    this.fillColor(new THREE.Color(DEFAULT_TERRAIN_COLOR));
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    this.gridUniforms = {
      uGridSize: { value: 1 },
      uGridOpacity: { value: 0.22 },
      uGridColor: { value: new THREE.Color(0x0c1620) },
    };
    this._installGridOverlay();
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.name = 'Terrain';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this._brushNoise = new Perlin(4242);
    this.rebuild();
  }

  static blankSnapshot(size = 128, segments = 128) {
    const n = (segments + 1) ** 2;
    const colors = new Float32Array(n * 3);
    const c = new THREE.Color(DEFAULT_TERRAIN_COLOR);
    for (let i = 0; i < n; i++) { colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b; }
    return { size, segments, heights: new Float32Array(n), colors };
  }

  /**
   * Editor-only grid drawn in world X/Z on the terrain surface (follows hills). Exporters ignore
   * onBeforeCompile, so this never reaches the game. Major lines every 10 cells; lines fade out
   * when cells get too small on screen.
   */
  _installGridOverlay() {
    const u = this.gridUniforms;
    this.material.customProgramCacheKey = () => 'terrain-grid';
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGridPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGridPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uGridSize;
          uniform float uGridOpacity;
          uniform vec3 uGridColor;
          varying vec3 vGridPos;
          float gridLine(vec2 c, out float cellPx) {
            vec2 w = max(fwidth(c), vec2(1e-5));
            vec2 d = abs(fract(c - 0.5) - 0.5) / w;
            cellPx = 1.0 / max(w.x, w.y);
            return 1.0 - min(min(d.x, d.y), 1.0);
          }`)
        .replace('#include <fog_fragment>', `
          if (uGridOpacity > 0.0) {
            float px, pxMajor;
            vec2 c = vGridPos.xz / uGridSize;
            float minor = gridLine(c, px) * smoothstep(3.0, 8.0, px);
            float major = gridLine(c / 10.0, pxMajor) * smoothstep(3.0, 8.0, pxMajor);
            float a = max(minor * uGridOpacity, major * min(1.0, uGridOpacity * 1.8));
            gl_FragColor.rgb = mix(gl_FragColor.rgb, uGridColor, a);
          }
          #include <fog_fragment>`);
    };
  }

  get side() { return this.segments + 1; }
  get step() { return this.size / this.segments; }

  fillColor(color) {
    for (let i = 0; i < this.colors.length; i += 3) {
      this.colors[i] = color.r;
      this.colors[i + 1] = color.g;
      this.colors[i + 2] = color.b;
    }
  }

  rebuild() {
    const n = this.side, step = this.step, half = this.size / 2;
    const pos = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        pos[i * 3] = ix * step - half;
        pos[i * 3 + 1] = this.heights[i];
        pos[i * 3 + 2] = iz * step - half;
        uv[i * 2] = ix / (n - 1);
        uv[i * 2 + 1] = 1 - iz / (n - 1);
      }
    }
    const seg = this.segments;
    const index = new (n * n > 65535 ? Uint32Array : Uint16Array)(seg * seg * 6);
    let k = 0;
    for (let iz = 0; iz < seg; iz++) {
      for (let ix = 0; ix < seg; ix++) {
        const a = iz * n + ix, b = a + 1, c = a + n, d = c + 1;
        index[k++] = a; index[k++] = c; index[k++] = b;
        index[k++] = b; index[k++] = c; index[k++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    const old = this.mesh.geometry;
    this.mesh.geometry = g;
    old.dispose();
    this.computeNormals(0, n - 1, 0, n - 1);
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }

  /** Push heights in the inclusive vertex range into the geometry. */
  updateRegion(x0, x1, z0, z1) {
    const n = this.side;
    x0 = clamp(x0, 0, n - 1); x1 = clamp(x1, 0, n - 1);
    z0 = clamp(z0, 0, n - 1); z1 = clamp(z1, 0, n - 1);
    const g = this.mesh.geometry;
    const pos = g.attributes.position.array;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const i = iz * n + ix;
        pos[i * 3 + 1] = this.heights[i];
      }
    }
    this.computeNormals(x0 - 1, x1 + 1, z0 - 1, z1 + 1);
    g.attributes.position.needsUpdate = true;
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }

  updateAll() {
    this.updateRegion(0, this.segments, 0, this.segments);
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  updateColors() {
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  computeNormals(x0, x1, z0, z1) {
    const n = this.side, H = this.heights, s2 = this.step * 2;
    x0 = clamp(x0, 0, n - 1); x1 = clamp(x1, 0, n - 1);
    z0 = clamp(z0, 0, n - 1); z1 = clamp(z1, 0, n - 1);
    const attr = this.mesh.geometry.attributes.normal;
    const nrm = attr.array;
    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const hL = H[iz * n + Math.max(ix - 1, 0)];
        const hR = H[iz * n + Math.min(ix + 1, n - 1)];
        const hD = H[Math.max(iz - 1, 0) * n + ix];
        const hU = H[Math.min(iz + 1, n - 1) * n + ix];
        let nx = hL - hR, ny = s2, nz = hD - hU;
        const len = Math.hypot(nx, ny, nz) || 1;
        const i = (iz * n + ix) * 3;
        nrm[i] = nx / len; nrm[i + 1] = ny / len; nrm[i + 2] = nz / len;
      }
    }
    attr.needsUpdate = true;
  }

  getHeightAt(x, z) {
    const n = this.side, seg = this.segments, half = this.size / 2, step = this.step;
    const gx = clamp((x + half) / step, 0, seg);
    const gz = clamp((z + half) / step, 0, seg);
    const x0 = Math.min(Math.floor(gx), seg - 1), z0 = Math.min(Math.floor(gz), seg - 1);
    const fx = gx - x0, fz = gz - z0;
    const H = this.heights;
    const h00 = H[z0 * n + x0], h10 = H[z0 * n + x0 + 1];
    const h01 = H[(z0 + 1) * n + x0], h11 = H[(z0 + 1) * n + x0 + 1];
    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return a + (b - a) * fz;
  }

  contains(x, z) {
    const half = this.size / 2;
    return x >= -half && x <= half && z >= -half && z <= half;
  }

  /**
   * Apply a brush dab. brush = { mode, radius, strength, color, flattenTarget }.
   * Rates are per second, scaled by dt.
   */
  applyBrush(point, brush, dt) {
    const n = this.side, step = this.step, half = this.size / 2;
    const r = brush.radius;
    const cx = (point.x + half) / step, cz = (point.z + half) / step, rc = r / step;
    const x0 = Math.max(0, Math.floor(cx - rc)), x1 = Math.min(n - 1, Math.ceil(cx + rc));
    const z0 = Math.max(0, Math.floor(cz - rc)), z1 = Math.min(n - 1, Math.ceil(cz + rc));
    if (x0 > x1 || z0 > z1) return;

    const H = this.heights, C = this.colors;
    const rate = brush.strength * (4 + r * 0.5) * dt;
    const blend = clamp(brush.strength * dt * 8, 0, 1);
    const src = brush.mode === 'smooth' ? H.slice() : null;
    const col = brush.mode === 'paint' ? new THREE.Color(brush.color) : null;

    for (let iz = z0; iz <= z1; iz++) {
      for (let ix = x0; ix <= x1; ix++) {
        const wx = ix * step - half, wz = iz * step - half;
        const d = Math.hypot(wx - point.x, wz - point.z);
        if (d > r) continue;
        const t = 1 - d / r;
        const f = t * t * (3 - 2 * t);
        const i = iz * n + ix;
        switch (brush.mode) {
          case 'raise': H[i] += rate * f; break;
          case 'lower': H[i] -= rate * f; break;
          case 'smooth': {
            const avg = (
              src[iz * n + Math.max(ix - 1, 0)] + src[iz * n + Math.min(ix + 1, n - 1)] +
              src[Math.max(iz - 1, 0) * n + ix] + src[Math.min(iz + 1, n - 1) * n + ix] + src[i]
            ) / 5;
            H[i] += (avg - H[i]) * clamp(blend * f * 2, 0, 1);
            break;
          }
          case 'flatten': {
            const target = brush.flattenTarget ?? 0;
            H[i] += (target - H[i]) * clamp(blend * f * 1.5, 0, 1);
            break;
          }
          case 'noise':
            H[i] += this._brushNoise.noise(wx * 0.18, wz * 0.18) * rate * f * 1.5;
            break;
          case 'paint': {
            const k = clamp(blend * f * 1.5, 0, 1);
            C[i * 3] += (col.r - C[i * 3]) * k;
            C[i * 3 + 1] += (col.g - C[i * 3 + 1]) * k;
            C[i * 3 + 2] += (col.b - C[i * 3 + 2]) * k;
            break;
          }
        }
      }
    }
    if (brush.mode === 'paint') {
      this.updateColors();
    } else {
      for (let iz = z0; iz <= z1; iz++) {
        for (let ix = x0; ix <= x1; ix++) if (!Number.isFinite(H[iz * n + ix])) H[iz * n + ix] = 0;
      }
      this.updateRegion(x0, x1, z0, z1);
    }
  }

  /** Procedural fBm heightfield. */
  generate({
    seed = 1, scale = 60, height = 24, octaves = 5, persistence = 0.5, lacunarity = 2,
    exponent = 1.3, ridged = false, island = false, base = 0, mode = 'replace',
  } = {}) {
    const perlin = new Perlin(seed);
    const n = this.side, step = this.step, half = this.size / 2;
    const vals = new Float32Array(n * n);
    let min = Infinity, max = -Infinity;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const wx = ix * step - half, wz = iz * step - half;
        let v = 0, amp = 1, freq = 1 / scale, norm = 0;
        for (let o = 0; o < octaves; o++) {
          let s = perlin.noise(wx * freq + o * 31.7, wz * freq + o * 17.3);
          if (ridged) { s = 1 - Math.abs(s); s *= s; }
          v += s * amp;
          norm += amp;
          amp *= persistence;
          freq *= lacunarity;
        }
        v /= norm;
        vals[iz * n + ix] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    const range = max - min || 1;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        let t = Math.pow(clamp((vals[i] - min) / range, 0, 1), exponent);
        if (island) {
          const d = Math.hypot(ix * step - half, iz * step - half) / half;
          t *= 1 - smoothstep(0.35, 0.95, d);
        }
        if (mode === 'add') this.heights[i] += t * height;
        else this.heights[i] = base + t * height;
      }
    }
    this.updateAll();
  }

  flatten(height = 0) {
    this.heights.fill(height);
    this.updateAll();
  }

  /** Colour vertices by height and slope. */
  autoPaint({
    water = 0, snowHeight = 22, rockSlope = 0.78,
    sand = '#c8b47e', grass = '#6b8f47', rock = '#7a746c', snow = '#f2f4f7',
  } = {}) {
    const n = this.side, H = this.heights, C = this.colors;
    const N = this.mesh.geometry.attributes.normal.array;
    const cSand = new THREE.Color(sand), cGrass = new THREE.Color(grass);
    const cRock = new THREE.Color(rock), cSnow = new THREE.Color(snow);
    const c = new THREE.Color(), dark = new THREE.Color();
    for (let i = 0; i < n * n; i++) {
      const h = H[i], ny = N[i * 3 + 1];
      const jitter = this._brushNoise.noise((i % n) * 0.35, Math.floor(i / n) * 0.35) * 0.06;
      c.copy(cGrass);
      dark.copy(cGrass).multiplyScalar(0.8);
      c.lerp(dark, smoothstep(water + 2, snowHeight, h) * 0.6);
      c.lerp(cRock, smoothstep(rockSlope + 0.06, rockSlope - 0.08, ny));
      c.lerp(cSnow, smoothstep(snowHeight - 2, snowHeight + 2, h) * smoothstep(0.55, 0.8, ny));
      c.lerp(cSand, smoothstep(water + 1.6, water + 0.4, h));
      C[i * 3] = clamp(c.r + jitter, 0, 1);
      C[i * 3 + 1] = clamp(c.g + jitter, 0, 1);
      C[i * 3 + 2] = clamp(c.b + jitter, 0, 1);
    }
    this.updateColors();
  }

  paintAll(color) {
    this.fillColor(new THREE.Color(color));
    this.updateColors();
  }

  /** Change world size and/or grid resolution, resampling existing data. */
  resize(size, segments) {
    if (segments !== this.segments) {
      const on = this.side, oH = this.heights, oC = this.colors;
      const nn = segments + 1;
      const H = new Float32Array(nn * nn), C = new Float32Array(nn * nn * 3);
      for (let iz = 0; iz < nn; iz++) {
        for (let ix = 0; ix < nn; ix++) {
          const gx = (ix / segments) * (on - 1), gz = (iz / segments) * (on - 1);
          const x0 = Math.min(Math.floor(gx), on - 2), z0 = Math.min(Math.floor(gz), on - 2);
          const fx = gx - x0, fz = gz - z0;
          const i00 = z0 * on + x0, i10 = i00 + 1, i01 = i00 + on, i11 = i01 + 1;
          const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
          const i = iz * nn + ix;
          H[i] = oH[i00] * w00 + oH[i10] * w10 + oH[i01] * w01 + oH[i11] * w11;
          for (let k = 0; k < 3; k++) {
            C[i * 3 + k] = oC[i00 * 3 + k] * w00 + oC[i10 * 3 + k] * w10 + oC[i01 * 3 + k] * w01 + oC[i11 * 3 + k] * w11;
          }
        }
      }
      this.heights = H;
      this.colors = C;
      this.segments = segments;
    }
    this.size = size;
    this.rebuild();
  }

  snapshot() {
    return { size: this.size, segments: this.segments, heights: this.heights.slice(), colors: this.colors.slice() };
  }

  restore(s) {
    let repaired;
    if (s.segments === this.segments && s.size === this.size) {
      this.heights.set(s.heights);
      this.colors.set(s.colors);
      repaired = this.sanitize();
      this.updateAll();
    } else {
      this.size = s.size;
      this.segments = s.segments;
      this.heights = s.heights.slice();
      this.colors = s.colors.slice();
      repaired = this.sanitize();
      this.rebuild();
    }
    return repaired;
  }

  /**
   * Replace non-finite heights (NaN/Infinity) with the average of their finite neighbours, and
   * non-finite colours with the default. A single NaN breaks raycasting over much of the terrain
   * and the smooth brush spreads it, so bad data is repaired wherever it can enter.
   * Returns the number of heights repaired.
   */
  sanitize() {
    const n = this.side, H = this.heights, C = this.colors;
    let repaired = 0;
    for (let pass = 0; pass < 64; pass++) {
      let remaining = 0;
      for (let iz = 0; iz < n; iz++) {
        for (let ix = 0; ix < n; ix++) {
          const i = iz * n + ix;
          if (Number.isFinite(H[i])) continue;
          let sum = 0, count = 0;
          for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
            const x = ix + dx, z = iz + dz;
            if (x < 0 || z < 0 || x >= n || z >= n) continue;
            const v = H[z * n + x];
            if (Number.isFinite(v)) { sum += v; count++; }
          }
          if (count) { H[i] = sum / count; repaired++; } else remaining++;
        }
      }
      if (!remaining) break;
      if (pass === 63) for (let i = 0; i < H.length; i++) if (!Number.isFinite(H[i])) { H[i] = 0; repaired++; }
    }
    const def = new THREE.Color(DEFAULT_TERRAIN_COLOR);
    for (let i = 0; i < C.length; i += 3) {
      if (!Number.isFinite(C[i]) || !Number.isFinite(C[i + 1]) || !Number.isFinite(C[i + 2])) {
        C[i] = def.r; C[i + 1] = def.g; C[i + 2] = def.b;
      }
    }
    return repaired;
  }

  toJSON() {
    return {
      ...this.snapshot(),
      material: { roughness: this.material.roughness, flatShading: this.material.flatShading },
    };
  }

  fromJSON(data) {
    const repaired = this.restore({
      size: data.size,
      segments: data.segments,
      heights: new Float32Array(data.heights),
      colors: new Float32Array(data.colors),
    });
    if (data.material) {
      this.material.roughness = data.material.roughness ?? 0.95;
      this.setFlatShading(!!data.material.flatShading);
    }
    return repaired;
  }

  setFlatShading(v) {
    this.material.flatShading = v;
    this.material.needsUpdate = true;
  }

  /** Load a grayscale image as heights: black = base, white = base + maxHeight. */
  loadHeightmap(image, { maxHeight = 30, base = 0 } = {}) {
    const n = this.side;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = n;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, n, n);
    const data = ctx.getImageData(0, 0, n, n).data;
    for (let i = 0; i < n * n; i++) {
      const l = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
      this.heights[i] = base + l * maxHeight;
    }
    this.updateAll();
  }

  /** Normalised 8-bit heightmap. Returns { canvas, min, max }. */
  toHeightmapCanvas() {
    const n = this.side, H = this.heights;
    let min = Infinity, max = -Infinity;
    for (const h of H) { if (h < min) min = h; if (h > max) max = h; }
    const range = max - min || 1;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = n;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(n, n);
    for (let i = 0; i < n * n; i++) {
      const v = Math.round(((H[i] - min) / range) * 255);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return { canvas, min, max };
  }
}
