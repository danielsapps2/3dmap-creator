import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { uid, stripExt } from '../core/utils.js';
import { fileStem, uniquePath } from '../core/paths.js';

/** Holds imported GLB files. Placed objects are clones of an asset's source scene. */
export class AssetLibrary extends EventTarget {
  constructor(renderer) {
    super();
    this.assets = new Map();
    const base = import.meta.env.BASE_URL;
    this.loader = new GLTFLoader()
      .setDRACOLoader(new DRACOLoader().setDecoderPath(`${base}draco/`))
      .setKTX2Loader(new KTX2Loader().setTranscoderPath(`${base}basis/`).detectSupport(renderer))
      .setMeshoptDecoder(MeshoptDecoder);
    this._thumb = null;
  }

  /**
   * meta: extra data saved with the asset, e.g. { tinyimgen: { id, role }, grip } for models pulled from tinyimgen
   * (grip = the prop's grip.json). The asset also gets, from the model itself:
   *   rig:  { bones: [names], sockets: [names] } when it has a skeleton (characters), else null
   *   prop: { hands, hold, grip } when it has a Grip_Primary node (holdable props), else null
   */
  /** path: where the model lives in the project ("assets/knight.glb"); a free one under assets/ by default. */
  async add(fileName, buffer, id = uid(), meta = {}, path = null) {
    const ext = /\.gltf$/i.test(fileName) ? '.gltf' : '.glb';
    path ??= uniquePath('assets', fileStem(stripExt(fileName)), ext, this.list().map((a) => a.path));
    const asset = { id, fileName, path, ...await this._parse(fileName, buffer, meta) };
    this.assets.set(id, asset);
    this.dispatchEvent(new Event('changed'));
    return asset;
  }

  /**
   * Swap an asset's model for a new version (e.g. a prop re-saved in tinyimgen), keeping its id. The asset object
   * is updated in place; objects already placed keep the old model until they are re-instantiated
   * (Editor.reloadAsset does that).
   */
  async replace(id, buffer, meta) {
    const asset = this.assets.get(id);
    if (!asset) throw new Error(`Missing asset "${id}"`);
    Object.assign(asset, await this._parse(asset.fileName, buffer, meta ?? asset.meta));
    this.dispatchEvent(new Event('changed'));
    return asset;
  }

  async _parse(fileName, buffer, meta) {
    const gltf = await this.loader.parseAsync(buffer.slice(0), '');
    const scene = gltf.scene ?? gltf.scenes[0];
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const parsed = {
      name: stripExt(fileName),
      buffer,
      scene,
      animations: gltf.animations ?? [],
      size,
      pivotOffset: new THREE.Vector3(center.x, box.isEmpty() ? 0 : box.min.y, center.z),
      thumbnail: null,
      meta: meta ?? {},
      rig: rigInfo(scene),
      prop: propInfo(scene, meta),
    };
    try { parsed.thumbnail = this._makeThumbnail(scene, box); } catch (e) { console.warn('thumbnail failed', e); }
    return parsed;
  }

  get(id) { return this.assets.get(id); }

  byPath(path) { return this.list().find((a) => a.path?.toLowerCase() === path.toLowerCase()) ?? null; }

  /** Rename a model (its file follows, in the same folder). */
  rename(id, name) {
    const a = this.assets.get(id);
    if (!a || !name.trim()) return;
    const dir = a.path.slice(0, a.path.lastIndexOf('/'));
    a.name = name.trim();
    a.fileName = `${a.name}${a.path.slice(a.path.lastIndexOf('.'))}`;
    a.path = uniquePath(dir, fileStem(a.name), a.path.slice(a.path.lastIndexOf('.')), this.list().filter((x) => x !== a).map((x) => x.path));
    this.dispatchEvent(new Event('changed'));
  }

  /** The library's copy of a tinyimgen model, if it was imported already. */
  findTinyimgen(id, role) {
    return this.list().find((a) => a.meta.tinyimgen?.id === id && a.meta.tinyimgen.role === role) ?? null;
  }
  list() { return [...this.assets.values()]; }

  instantiate(id) {
    const asset = this.assets.get(id);
    const c = skeletonClone(asset.scene);
    c.__basePosition = asset.scene.position.clone();
    c.__pivotOffset = asset.pivotOffset;
    return c;
  }

  remove(id) {
    this.assets.delete(id);
    this.dispatchEvent(new Event('changed'));
  }

  clear() {
    this.assets.clear();
    this.dispatchEvent(new Event('changed'));
  }

  _makeThumbnail(source, box) {
    if (!this._thumb) {
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setSize(128, 128);
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
      const dir = new THREE.DirectionalLight(0xffffff, 2);
      dir.position.set(2, 3, 2);
      scene.add(dir);
      this._thumb = { renderer, scene, camera: new THREE.PerspectiveCamera(35, 1, 0.01, 10000) };
    }
    const { renderer, scene, camera } = this._thumb;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.001);
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.position.copy(center).add(new THREE.Vector3(1, 0.7, 1.2).normalize().multiplyScalar(dist));
    camera.near = dist / 100;
    camera.far = dist * 10;
    camera.updateProjectionMatrix();
    camera.lookAt(center);
    const parent = source.parent;
    scene.add(source);
    renderer.render(scene, camera);
    scene.remove(source);
    if (parent) parent.add(source);
    return renderer.domElement.toDataURL('image/png');
  }
}

/** Bones and attachment sockets of a rigged model (sockets first in `attachPoints`). */
function rigInfo(scene) {
  const bones = [], sockets = [];
  scene.traverse((o) => {
    if (o.isBone) bones.push(o.name);
    else if (/_Socket$/.test(o.name) && o.parent?.isBone) sockets.push(o.name);
  });
  return bones.length ? { bones, sockets, attachPoints: [...sockets, ...bones] } : null;
}

/** Grip data of a holdable prop (tinyimgen's prop.glb: a "Prop" root with Grip_Primary / Grip_Secondary nodes). */
function propInfo(scene, meta) {
  const grip = scene.getObjectByName('Grip_Primary');
  if (!grip) return null;
  const extras = grip.parent?.userData ?? {};
  const saved = meta?.grip ?? null;
  return {
    hands: saved?.hands ?? extras.hands ?? (scene.getObjectByName('Grip_Secondary') ? 2 : 1),
    hold: saved?.hold ?? extras.hold ?? 'upright',
    hand: saved?.hand === 'left' ? 'Left' : 'Right',
    grip: saved,
  };
}
