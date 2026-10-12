import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { uid, stripExt } from '../core/utils.js';

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

  async add(fileName, buffer, id = uid()) {
    const gltf = await this.loader.parseAsync(buffer.slice(0), '');
    const scene = gltf.scene ?? gltf.scenes[0];
    scene.updateMatrixWorld(true);
    scene.traverse((o) => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.isEmpty() ? new THREE.Vector3(1, 1, 1) : box.getSize(new THREE.Vector3());
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const asset = {
      id,
      name: stripExt(fileName),
      fileName,
      buffer,
      scene,
      animations: gltf.animations ?? [],
      size,
      pivotOffset: new THREE.Vector3(center.x, box.isEmpty() ? 0 : box.min.y, center.z),
      thumbnail: null,
    };
    try { asset.thumbnail = this._makeThumbnail(scene, box); } catch (e) { console.warn('thumbnail failed', e); }
    this.assets.set(id, asset);
    this.dispatchEvent(new Event('changed'));
    return asset;
  }

  get(id) { return this.assets.get(id); }
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
