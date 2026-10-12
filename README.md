# 3D Map Creator

A browser-based level editor for three.js games. Sculpt terrain, build with primitives, import and place GLB models, drop gameplay markers, then export a single `.glb` your game loads with `GLTFLoader`.

```bash
npm install
npm run dev        # opens http://localhost:5173 (editor) — game demo at /game.html
npm run build      # static build in dist/
```

## Features

| Area | What you can do |
|---|---|
| **Terrain** | Heightfield up to 512² cells. Brushes: raise, lower, smooth, flatten, noise, vertex-color paint. Procedural fBm generator (seed, ridged, island). Auto-paint by height/slope. Heightmap PNG import/export. Resize/resample. |
| **Primitives** | Box, sphere, cylinder, cone, pyramid, torus, capsule, plane, ramp, stairs. You can edit the parameters later, plus PBR material (color, roughness, metalness, emissive, opacity, flat shading). |
| **GLB models** | Import `.glb`/`.gltf` (Draco, Meshopt, KTX2 supported). Thumbnails, base-pivot centering, "set height in meters", scatter placement (random rotation/scale, align to surface). |
| **Markers** | Player spawn (direction arrow), waypoint, trigger volume, point light. |
| **Game data** | Per-object collider type (box, ramp, sphere, mesh, trigger), static flag, tags, custom key/value properties. Ramps and stairs default to the walkable `ramp` collider. These are exported as glTF extras, so in three.js they show up in `object.userData`. |
| **Editing** | Multi-select (Shift/Ctrl+click, box-drag, Ctrl+A, outliner ranges) and transform, duplicate, delete, drop or snap the whole selection together. Hold **Shift while scaling** to scale one side only. Hold **Alt while dragging** the gizmo to duplicate and drag the copy. Move/rotate/scale gizmo with grid snapping (objects snap by their bounding-box edges, so any size lines up with the grid and each other; markers snap by their pivot; move step = grid cell, rotate step in degrees, scale step), hold Ctrl to toggle snapping temporarily, snap-to-grid for existing objects, and a grid drawn on the terrain surface. Also: undo/redo, duplicate, drop-to-ground, outliner, autosave to IndexedDB. |
| **Output** | `.glb` / `.gltf` map, layout JSON (transforms + heights only), project file (`.map.json`, embeds models), heightmap PNG, and **▶ Play** opens a first-person playtest. |

## Controls

Right-drag orbit · middle-drag pan · wheel zoom · left-click select/place/sculpt · Shift/Ctrl+click add to selection · left-drag on empty space box-selects · `Ctrl+A` select all · hold `Shift` while scaling to scale one side.
**Fly:** hold right mouse + `WASD` (`Q/E` down/up, `Shift` faster, wheel changes speed); the mouse looks around while flying. Arrow keys and `PageUp/PageDown` fly without holding the mouse.
`W/E/R` gizmo · `Q` world/local · `X` snap · hold `Ctrl` flip snap · `Shift+S` snap selection to grid · `B` sculpt · `[ ]` brush size · `1–6` brush tool ·
`F` focus · `G` drop to ground · `Ctrl+D` duplicate · `Del` delete · `Ctrl+Z / Ctrl+Shift+Z` undo/redo ·
`Ctrl+S` save project · `Ctrl+E` export · `Shift+click` keep placing · `Esc` cancel. Press `?` in the app for the full list.

## Using an exported map in your game

### Option A: plain GLTFLoader

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const gltf = await new GLTFLoader().loadAsync('/maps/level1.glb');
scene.add(gltf.scene);

gltf.scene.traverse((node) => {
  const d = node.userData;            // game data from the editor
  if (d.marker === 'spawn') player.position.copy(node.position);
  if (d.tags?.includes('enemy')) spawnEnemy(node, d.props);
  if (node.isMesh) { node.castShadow = d.castShadow ?? true; node.receiveShadow = true; }
});
```

### Option B: `MapLoader.js` (recommended)

Copy `src/runtime/MapLoader.js` into your game. It only depends on `three`.

```js
import { loadMap, applyEnvironment } from './MapLoader.js';

const map = await loadMap('/maps/level1.glb');
scene.add(map.root);
applyEnvironment(scene, map.environment, { renderer, shadowExtent: 100 }); // sky, fog, sun, ambient

const spawn = map.spawns[0];            // { position, rotationY, quaternion, params }
const y = map.getHeightAt(x, z);        // fast bilinear terrain height (no raycast)
map.getSurfaceAt(x, z, maxY);           // highest walkable surface (terrain, box tops, ramp slopes) at or below maxY
map.colliders;                          // [{ node, type, box: Box3, isStatic, surfaceAt(), overlaps(), pushOut() }]
map.triggers[0].contains(playerPos);    // rotated/scaled volume test
map.findByTag('loot');                  // nodes tagged in the editor
map.byId.get(id);                       // stable ids survive re-export
```

The playtest shows a performance overlay (toggle with `F3`): FPS, frame and CPU time, draw calls, triangles, and the GPU memory the page has allocated (textures, buffers, render targets, canvas), measured with [webgl-memory](https://github.com/greggman/webgl-memory). Browsers don't report total VRAM use, so this counts only what the page allocated.

`src/game/main.js` is a complete working example: first-person movement, terrain-following, rotated box collisions, step-up, walkable ramps and stairs, sliding off slopes steeper than 50°, and trigger events.

#### Colliders
Each collider is oriented with its object (rotation and scale) and built from the object's local bounds.
- `collider.surfaceAt(x, z, radius = 0, normal?)` returns the world Y of its walkable top at that point (or `null` if the point is more than `radius` outside the footprint), and writes the surface normal into `normal`. The top is flat for `box`/`sphere`/`mesh`. For `ramp` it is a slope that rises toward the object's local **−Z**, which is the direction the editor's ramp and stairs primitives climb. On stairs the slope runs through the middle of each riser, so the player glides up and down them.
- `collider.overlaps(pos, radius)` and `collider.pushOut(pos, radius)` test and resolve a circle (the player) against the footprint on the XZ plane.
- You can set `ramp` on an imported GLB (for example a staircase model). Rotate it so it climbs toward its local −Z.

### Node `userData` schema

```jsonc
{
  "mapType": "primitive" | "asset" | "marker" | "terrain",
  "id": "k3j2…",                 // stable across edits
  "collider": "none" | "box" | "ramp" | "sphere" | "mesh" | "trigger" | "heightfield",
  "static": true,
  "tags": ["crate", "breakable"],
  "props": { "health": 100 },     // your custom properties (numbers/bools/JSON parsed)
  "castShadow": true, "receiveShadow": true,
  "primitive": "box", "params": { "width": 2, "height": 2, "depth": 2 },   // primitives
  "asset": "tree",                                                          // models
  "marker": "spawn" | "waypoint" | "trigger" | "pointLight"                 // markers
}
```

The scene root's `userData` has `{ mapFormat, version, name, environment, terrain: { size, segments } }`.
Terrain vertices form a grid: `index = iz * (segments + 1) + ix`, `x = ix * size / segments - size / 2` (z is the same).

### Notes
- Primitives and markers have their **pivot at the base**, so a `position` is the point on the ground.
- Spawn markers face **−Z**, which is the same as a three.js camera's forward direction.
- GLTFLoader cleans up node names (`"Player Spawn"` becomes `"Player_Spawn"`). The original name is kept in `userData.name`, and `map.findByName()` accepts either one.
- Animations inside imported models are not re-exported in the map GLB. Load animated characters separately in your game and place them using markers or tags.
- Flat shading is a material setting and isn't stored in glTF.

## Project layout

```
src/editor/   Editor core: Terrain, Primitives, Markers, Entities, AssetLibrary, History, Project, Export
src/ui/       Panels, Inspector, DOM helpers
src/runtime/  MapLoader.js: drop-in loader for your game
src/game/     First-person playtest demo (game.html)
public/       Draco + Basis decoders for compressed GLBs
```

## License

[MIT](LICENSE). The Draco and Basis decoders in `public/` come from three.js and keep their own licenses (Apache-2.0).
