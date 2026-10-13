// Vite plugin: the engine's shared library, used by every project instead of each keeping its own.
//
//   engine/models/   one .glb/.gltf per model, with an optional <name>.meta.json beside it holding the editor's asset
//                    meta (tinyimgen link, prop grip, a character's `controller` fields: player controller settings
//                    it plays with, e.g. { walkSpeed, runSpeed, walkRate, runRate }). Projects keep a copy in assets/ that follows the engine file
//                    (src/editor/EngineModels.js).
//   engine/clips/    the animation clip library, one <name>.clip.json per clip (src/editor/EngineClips.js).
//
//   GET    /engine/api/models   [{ file, name, size, modified, sha256, meta }]   (file: path under engine/models/)
//   GET    /engine/api/clips    [{ file, size, modified }]                       (file: path under engine/clips/)
//   GET    /engine/models/<file>, /engine/clips/<file>
//   PUT    /engine/models/<file>, /engine/clips/<file>   write it; answers with its listing entry
//   DELETE /engine/clips/<file>
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MODEL = /\.(glb|gltf)$/i;
const META = /\.meta\.json$/i;
const CLIP = /\.clip\.json$/i;
const MAX_BODY = 512 * 1024 * 1024;

const fail = (status, message) => Object.assign(new Error(message), { status });

export function engineLibrary(root) {
  root = path.resolve(root);
  const dirs = { models: path.join(root, 'models'), clips: path.join(root, 'clips') };
  const hashes = new Map(); // absolute path -> { key: size:mtime, sha256 }

  const resolve = (kind, rel) => {
    const dir = dirs[kind];
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep)) throw fail(400, `Outside the engine's ${kind} folder`);
    return abs;
  };

  async function walk(dir, test, sub = '') {
    let entries;
    try {
      entries = await fs.readdir(path.join(dir, sub), { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const e of entries) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...await walk(dir, test, rel));
      else if (test.test(e.name)) out.push(rel);
    }
    return out.sort();
  }

  async function modelEntry(rel) {
    const abs = resolve('models', rel);
    const st = await fs.stat(abs);
    let meta = {}, metaTime = 0;
    try {
      const metaAbs = resolve('models', rel.replace(MODEL, '.meta.json'));
      metaTime = (await fs.stat(metaAbs)).mtimeMs;
      meta = JSON.parse(await fs.readFile(metaAbs, 'utf8'));
    } catch { /* no meta, or half-written */ }
    const key = `${st.size}:${st.mtimeMs}`;
    let h = hashes.get(abs);
    if (h?.key !== key) {
      h = { key, sha256: crypto.createHash('sha256').update(await fs.readFile(abs)).digest('hex') };
      hashes.set(abs, h);
    }
    return {
      file: rel, name: path.basename(rel).replace(MODEL, ''), size: st.size,
      modified: Math.round(Math.max(st.mtimeMs, metaTime)), sha256: h.sha256, meta,
    };
  }

  async function clipEntry(rel) {
    const st = await fs.stat(resolve('clips', rel));
    return { file: rel, size: st.size, modified: Math.round(st.mtimeMs) };
  }

  const readBody = (req) => new Promise((done, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(fail(413, 'Too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => done(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const send = (res, status, body, type = 'text/plain') => {
    res.statusCode = status;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-cache');
    res.end(body);
  };
  const json = (res, value) => send(res, 200, JSON.stringify(value), 'application/json');

  /** Write then rename, so a watcher (or another tab) never reads half a file. */
  async function writeAtomic(abs, body) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, abs);
  }

  async function middleware(req, res, next) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/engine/')) return next();
    try {
      if (req.method === 'GET' && url.pathname === '/engine/api/models') {
        return json(res, await Promise.all((await walk(dirs.models, MODEL)).map(modelEntry)));
      }
      if (req.method === 'GET' && url.pathname === '/engine/api/clips') {
        return json(res, await Promise.all((await walk(dirs.clips, CLIP)).map(clipEntry)));
      }
      const m = url.pathname.match(/^\/engine\/(models|clips)\/(.+)$/);
      if (!m) return next();
      const kind = m[1], rel = decodeURIComponent(m[2]);
      const ok = kind === 'models' ? MODEL.test(rel) || META.test(rel) : CLIP.test(rel);
      if (!ok) throw fail(400, kind === 'models' ? 'Only .glb, .gltf and .meta.json files' : 'Only .clip.json files');
      const abs = resolve(kind, rel);
      if (req.method === 'GET') {
        const type = /\.json$/i.test(rel) ? 'application/json' : /\.gltf$/i.test(rel) ? 'model/gltf+json' : 'model/gltf-binary';
        return send(res, 200, await fs.readFile(abs), type);
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (/\.json$/i.test(rel)) JSON.parse(body.toString('utf8')); // refuse broken JSON
        await writeAtomic(abs, body);
        return json(res, kind === 'clips' ? await clipEntry(rel) : MODEL.test(rel) ? await modelEntry(rel) : { ok: true });
      }
      if (req.method === 'DELETE' && kind === 'clips') {
        await fs.rm(abs, { force: true });
        return json(res, { ok: true });
      }
      throw fail(405, 'Method not allowed');
    } catch (err) {
      return send(res, err.status ?? (err.code === 'ENOENT' ? 404 : err instanceof SyntaxError ? 400 : 500), err.message);
    }
  }

  return {
    name: 'engine-library',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
