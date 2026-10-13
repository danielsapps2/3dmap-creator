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
| **Game objects** | Any object can have child objects. Drag rows onto each other in the Scene list (or set **Parent** in the Inspector) to parent them, and onto *Map & Terrain* to move them back to the top level. Children move, hide, duplicate, delete and export with their parent. **Empty** game objects group others. A child of a rigged model can be attached to one of its bones (**Attach to**). |
| **tinyimgen** | The Models tab lists tinyimgen's rigged characters and holdable props (see [Characters and held props](#characters-and-held-props)). Click one to place it. |
| **Game data** | Per-object collider type (box, ramp, sphere, mesh, trigger), static flag, tags, custom key/value properties. Ramps and stairs default to the walkable `ramp` collider. These are exported as glTF extras, so in three.js they show up in `object.userData`. |
| **Editing** | Multi-select (Shift/Ctrl+click, box-drag, Ctrl+A, outliner ranges) and transform, duplicate, delete, drop or snap the whole selection together. Hold **Shift while scaling** to scale one side only. Hold **Alt while dragging** the gizmo to duplicate and drag the copy. Move/rotate/scale gizmo with grid snapping (objects snap by their bounding-box edges, so any size lines up with the grid and each other; markers snap by their pivot; move step = grid cell, rotate step in degrees, scale step), hold Ctrl to toggle snapping temporarily, snap-to-grid for existing objects, and a grid drawn on the terrain surface. Also: undo/redo, duplicate, drop-to-ground, outliner, autosave to IndexedDB. |
| **Output** | `.glb` / `.gltf` map, layout JSON (transforms + heights only), project folder (scripts as `.js` files, for VS Code) or single project file (`.map.json`, embeds models), heightmap PNG. **▶ Play** runs a playtest inside the editor (**↗** opens it in a tab). |

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

### Characters and held props

With tinyimgen running (`server.py`, port 7860), the **Models** tab lists every character built with *Rig + animations* and every prop saved in tinyimgen's Prop Editor (*Make holdable ✋*). Clicking one downloads it into the project (props bring their `grip.json`) and places it.

To give a character something to hold:
- drag the prop onto the character in the Scene list, or
- select the character and click the prop in the Models tab, or
- use the Inspector's **Hands** section on the character (*Hold* → *In right hand* / *In left hand*).

The prop becomes a child of the character attached to its `RightHand_Socket` or `LeftHand_Socket`, with the prop's `Grip_Primary` on the socket. Its collider is set to `none` so it doesn't block whoever holds it. The editor shows the character in the first frame of its Idle clip, holding the prop the way the playtest does: the finger curls saved in the Prop Editor, the ready pose and support hand for two-handed props, and the carry pose for props with static arms. You can still move or rotate a held prop. **Snap grip to hand** puts it back on the socket, and **Swap to left/right hand** moves it to the other hand.

**The player:** select a **Player Spawn** and set it up in the Inspector:
- **Player:** pick a human model from the library or from tinyimgen. Replacing the model hands its props to the new one. **Height (m)** resizes it; the playtest uses the same height, and the animation speed scales with it.
- **Hands:** put props in its right or left hand.
- **Hold · \<prop\>:** one section per held prop, also on the prop's own Inspector:
  - **Hand**, **Hold** (*upright* or *forward*, for two-handed props), **Arms** (*animated*, or *static* with the carry pose saved in the Prop Editor)
  - finger curls per finger for each hand (**Open**, **Relaxed** and **Fist** presets)
  - the grip offset from the hand socket
  
  These edits apply to that copy only, on top of the prop's `grip.json`. **Reset to saved grip** drops them.
- **Camera:** start in first or third person, facing mode, third-person distance, eye height.
- **Movement:** walk and run speed (first person; in third person the character moves at its animation speed), jump speed, gravity, step height, max slope, collision radius and height.

You can also drag a character onto the spawn in the Scene list. ▶ Play uses the spawn's character as the player: it plays the character's own GLB with tinyimgen's locomotion, holding everything it holds in the editor. It is preselected on the pause card, and you can still pick another character there. The spawn's settings are exported in its `userData.params`.

Exported maps keep a held prop as a node under the hand socket node, so it follows the hand in any engine that plays the character's animations. Use `map.held` and `src/runtime/hold.js` to pose the hand each frame:

```js
import { heldProp, poseHeld } from './hold.js';   // with props.js (a copy of tinyimgen's static/props.js)

for (const h of map.held) {                       // { node, parent, bone, attachedTo, grip }
  const held = heldProp(h.node, h.bone, h.grip);  // null unless it's a gripped prop in a hand socket
  if (held) poseHeld(characterModel, held);       // after your mixer.update(dt): fingers, support hand, carry pose
}
```

### Project folders and the Files tab

In Chrome and Edge, a project is a folder of ordinary files, so you can open it in VS Code or keep it in git:

```
My map/
  project.json                the map: environment, objects (with their scripts' params), camera, settings, and an index of the files
  scripts/**/Door.js          one file per script (subfolders are fine)
  assets/**/knight.glb        the models
  clips/**/Wave.clip.json     one file per animation clip
  terrain/heights.f32, terrain/colors.f32   the terrain grid (raw Float32)
```

**File → Save project** (`Ctrl+S`) picks the folder the first time, and **Open project folder…** (`Ctrl+O`) opens one. From then on, scripts, models and clips are **written as soon as they change**: a new or renamed script, an imported model, an edited clip. `Ctrl+S` saves the map itself (`project.json` and the terrain). Without a folder, the same files live in the editor (and its autosave) until the first save.

The **Files** tab shows them:

- **scripts/**: double-click to edit. Drag a script onto an object in the viewport, a row in the Scene list, or the Inspector to attach it. Right-click for New, New from template, Import .js, Rename, Duplicate or Delete.
- **assets/**: click a model to place it. Right-click to import, rename or delete (deleting also removes its placed copies).
- **clips/**: double-click to open in the animation editor. Right-click to rename, duplicate or delete.
- **Engine**: what the editor provides, which is the script templates and the tinyimgen models. Using one copies it into the project: clicking or dragging a template writes `scripts/<Template>.js` (the Inspector's **+ Add script…** offers them too), and clicking a tinyimgen model writes it to `assets/` and places it.

The editor watches the folder while it's open. Scripts and clips saved, added (including in subfolders) or deleted outside the editor show up, and a GLB dropped into `assets/` becomes a model (replacing one updates its placed copies). A script you save in VS Code reloads the running game. Writes never overwrite a file that changed on disk unless the editor changed it too, and if both changed you're told. If `project.json` changes on disk, the editor offers to reload the project. After a page reload the editor reconnects to the folder (the browser may ask again) and takes script edits made while it was closed. The status bar shows the open folder.

The single-file format (`.map.json`, everything embedded) is still under **File → Open / Save as single file**, and it's what other browsers use. Folders saved with the older `clips.json` still open.

### Scripts

Scripts are JavaScript files in the project's `scripts/` folder (see the **Files** tab above): classes you attach to objects, like components in Unity. Start one from an engine template (Spin, Bob, Door, Pickup, Message zone, Flicker, Animate, NPC states, Moving platform, Player controller, or Empty), edit it in the built-in code editor (autocomplete for `this.` and `this.game.`, with an API reference next to the code) or in VS Code, and attach it by dragging it onto an object or from the object's Inspector. A script's `params` become fields in the Inspector, and each object keeps its own values.

```js
export const params = {
  speed: { type: 'number', default: 90, label: 'Speed (°/s)' },  // also: text, bool, color, select (with options)
};

export default class Spin {
  start() {}                     // once, before the first update
  update(dt) { this.object.rotation.y += this.THREE.MathUtils.degToRad(this.params.speed) * dt; }
  // onTriggerEnter(player) / onTriggerExit(player)  on a Trigger Volume, when the player walks in or out
  // onInteract(player)          the player pressed E nearby (this.prompt sets the hint: "E · Open")
  // onDestroy()
}
```

Each instance has `this.object` (its node in the loaded map), `this.params`, `this.THREE`, and `this.game`: `time`, `player` (`position`, `teleport()`, `playClip(name)` for animation library clips), `find(name)`, `findByTag(tag)`, `message(text)`, `input.isDown(code)` / `input.pressed(code)`, `on(event, fn)` / `emit(event, data)` (a Trigger Volume's event name fires when the player enters it), `destroy(object)`, `setCollidable(object, on)` and `distanceToPlayer(object)`. Colliders follow objects that scripts move. Scripts can't `import`.

Scripts run in the playtest, and saving one reloads an open playtest tab. A script that throws is stopped and reported on screen, and the others keep running. They're saved in the project and exported inside the map GLB, so your game can run them with the drop-in `src/runtime/scripts.js` (next to `MapLoader.js`):

```js
import { runScripts } from './scripts.js';
const scripts = await runScripts(map, { player: { position: playerFeet }, message: (text) => showOnHud(text) });
// every frame: scripts.update(dt). When the player enters or leaves a trigger: scripts.triggerEnter(t.node) / triggerExit(t.node).
// "use" key: scripts.interactables() lists [{ node, prompt }]; call scripts.interact(node).
```

Scripts are code that runs in the page with full access to it, so only run maps whose scripts you trust.

#### Animation states

Any tinyimgen character in the map can be animated from a script. It can play clips from the animation library, which is exported inside the map, as well as the characters' own Idle, Walk and Run. A `clip` param shows up in the Inspector as a dropdown of those clips.

```js
const anim = this.game.animator(this.object);              // null if it isn't a tinyimgen character
anim.play('Salute', { fade: 0.25 }).then(() => anim.play('Idle'));   // a one-shot's promise resolves when it ends

this.fsm = this.game.stateMachine({                        // updated every frame for you
  object: this.object,
  initial: 'idle',
  states: {
    idle:    { clip: 'Idle', update: () => (this.game.distanceToPlayer(this.object) < 3 ? 'greet' : null) },
    greet:   { clip: 'Salute', loop: false, next: 'idle', enter: () => this.game.message('Hello!') },
    sitting: { clip: 'Sitting Idle' },
  },
});
this.fsm.go('sitting');                                    // or switch from anywhere
```

A state can have `clip`, `loop`, `fade` and `speed`. It can also have `enter(sm, data)` and `exit(sm)`, and `update(dt, sm)`, which switches state when it returns a state's name. `next` moves to another state when a one-shot clip ends, or after `duration` seconds. A character holding a prop keeps its grip while it animates. The *Animate* and *NPC states* templates show both. For your own game, use `src/runtime/animator.js` (`Animator`, `createStateMachine`).

#### Player controller

How the player moves is a script too, and its params are the movement and camera settings. In the Player Spawn's Inspector, **Make a player controller script** turns the built-in controller into this map's own script. The spawn's current settings carry over, and the spawn's Movement and Camera fields give way to the script's. You can change the code freely: speeds, jumping, air control, the first-person and third-person cameras, mouse look, and the V / T / R / Space keys. It uses `this.game.physics.move(dt, { radius, height, step, maxSlope })` for collisions, plus `this.game.view`, `this.game.input.mouse` and `this.game.player`.

A script becomes the controller by exporting `controlsPlayer = true`. Maps without a controller, including older maps, run the default one (`src/runtime/PlayerController.script.js`) with the spawn's settings. If a controller crashes, the default takes over, so the player can still move.

### Animation editor (🎬 Animate)

A keyframe editor for tinyimgen characters. Every tinyimgen rig has the same skeleton with unrotated rest joints, so a clip made on one character plays on all of them. Each clip remembers the skeleton it was made on, and on another character it's fitted to that body's proportions (bone by bone, lining up the rest directions), so arms and legs land where they should. In the game, characters use their own Idle, Walk and Run unless the library has a clip by that name. Clips live in one shared library: it's kept in the browser, saved inside project files (opening a project adds its clips), and handed to the playtest by ▶ Play.

- **Clips:** start an empty clip (from the rest pose) or one from the pose on screen, import one of the preview character's own clips (its mocap Idle, Walk, Run…), or import from [Mesh2Motion](https://github.com/Mesh2Motion/mesh2motion-app)'s 178 free (CC0) human animations, retargeted to tinyimgen's skeleton. An imported clip's motion becomes its *base*, and your keys are corrections on top of it.
- **Posing:** click a joint, then rotate it with the gizmo (`E`) or type the angles. The hips can also be moved (`W`). Posing keys the current frame. `K` keys the selected bone, `Shift+K` the whole pose, `M` mirrors the pose left to right, and `Ctrl+C` / `Ctrl+V` copy and paste poses.
- **Timeline:** scrub on the ruler, click keys to select them (`Shift` adds), drag them to retime, and `Delete` removes them. Keys are smoothed (Catmull-Rom) or linear, and looping clips wrap around. `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo.
- **In the playtest:** clips named `Idle`, `Walk`, `Run`, `WalkBackward`, `StrafeLeft` or `StrafeRight` replace the character's own clip of that name. The rest play on keys `1`–`9` in library order: the character stands still while one plays, a one-shot fades out at its end, and a loop runs until you move or press its key again. Closing the editor with changes reloads an open playtest tab.

### Play mode

**▶ Play** (or `Ctrl+P`) runs the playtest inside the editor's viewport, so you can try things without leaving it. It's the same game as in a tab, with the same scripts, player controller, animation and physics. It starts playing as soon as it loads: the keyboard works right away, and clicking the game captures the mouse for looking around. There's no pop-up at any point: `Esc` frees the mouse, and a second `Esc` (or `Ctrl+P`, or **⏹ Stop**) returns to editing. The bar above the game pauses it, restarts it, opens it in a tab (**↗**, also next to ▶ Play), and shows the **Console**: what scripts write with `this.game.log(…)`, plus warnings and errors (an error opens the console).

The editor stays usable while the game runs. Edits to the map show up after **↻ Restart**, which says *edited* when there's something new. Saving a script reloads the game straight away.

### Playtest (▶ Play / ↗)

The map starts playing as soon as it loads, with no "click to play" screen (only a small "Loading map…" label while it loads). Keys work straight away. Click the game to capture the mouse for looking around. `Esc` frees the mouse and opens the menu (character, view), and `Esc` again closes it.

- **First or third person:** switch with `V` or on the pause card. In third person the mouse orbits the camera, the wheel zooms, and the camera pulls in instead of clipping through walls. `T` switches facing between *free turn* (the character turns toward where it walks) and *strafe* (it faces the camera; A/D strafe, S walks backwards).
- **Character:** pick one on the pause card. Your choice is remembered. If the map has a character under its Player Spawn (see above), that one is used.
  - **tinyimgen characters:** with tinyimgen running (`server.py`, port 7860), every model built with *Rig + animations* is listed with its thumbnail. They're driven by tinyimgen's locomotion runtime (`src/game/locomotion.js`, a copy of tinyimgen's `static/locomotion.js`), which blends Idle, Walk, Run, WalkBackward and the strafes by velocity, so the feet stay planted. The dev server proxies tinyimgen under `/tinyimgen` (set `TINYIMGEN_URL` to point elsewhere).
  - **Any rigged .glb:** clips named like idle / walk / run are crossfaded by speed. Models in other units are rescaled to 1.8 m.
  - **Capsule:** a placeholder with no model.
- Movement in third person comes from the animation (tinyimgen's walk is about 1.4 m/s and its jog about 2.9 m/s), while ramps, stairs, walls, gravity and jumping use the same physics as first person.

The playtest shows a performance overlay (toggle with `F3`): FPS, frame and CPU time, draw calls, triangles, and the GPU memory the page has allocated (textures, buffers, render targets, canvas), measured with [webgl-memory](https://github.com/greggman/webgl-memory). Browsers don't report total VRAM use, so this counts only what the page allocated.

`src/game/main.js` is a complete working example: first-person movement, terrain-following, rotated box collisions, step-up, walkable ramps and stairs, sliding off slopes steeper than 50°, and trigger events.

#### Colliders
Each collider is oriented with its object (rotation and scale) and built from the object's local bounds.
- `collider.surfaceAt(x, z, radius = 0, normal?)` returns the world Y of its walkable top at that point (or `null` if the point is more than `radius` outside the footprint), and writes the surface normal into `normal`. The top is flat for `box`/`sphere`/`mesh`. For `ramp` it is a slope that rises toward the object's local **−Z**, which is the direction the editor's ramp and stairs primitives climb. On stairs the slope runs through the middle of each riser, so the player glides up and down them.
- `collider.overlaps(pos, radius)` and `collider.pushOut(pos, radius)` test and resolve a circle (the player) against the footprint on the XZ plane.
- You can set `ramp` on an imported GLB (for example a staircase model). Rotate it so it climbs toward its local −Z.
- `capsule` is an upright capsule, the default for rigged models (characters). It's the same shape as the player, so people bump into each other instead of into a box around outstretched arms. Its radius comes from the model's thickness, and `collider.rayDistance(origin, dir, far)` tests a ray against it. The playtest camera uses that for characters instead of raycasting their skinned meshes, because three.js skins every vertex to raycast a skinned mesh (about 50 ms per ray for a tinyimgen character). Projects saved before this switch their characters from `box` to `capsule` when opened.

### Node `userData` schema

```jsonc
{
  "mapType": "primitive" | "asset" | "marker" | "group" | "terrain",
  "id": "k3j2…",                 // stable across edits
  "parentId": "x81f…",           // child objects: the id of the object they belong to
  "attachedTo": "RightHand_Socket", // children attached to one of their parent's bones (they're parented to it)
  "collider": "none" | "box" | "ramp" | "sphere" | "capsule" | "mesh" | "trigger" | "heightfield",
  "static": true,
  "tags": ["crate", "breakable"],
  "props": { "health": 100 },     // your custom properties (numbers/bools/JSON parsed)
  "castShadow": true, "receiveShadow": true,
  "primitive": "box", "params": { "width": 2, "height": 2, "depth": 2 },   // primitives
  "asset": "tree",                                                          // models
  "tinyimgen": { "id": "1791…", "role": "character" | "prop" },             // models pulled from tinyimgen
  "rig": { "sockets": ["LeftHand_Socket", "RightHand_Socket"] },            // rigged models
  "grip": { "hands": 1, "hold": "upright", "fingers": {…}, "arms": "animated", "carry": null }, // holdable props (grip.json)
  "marker": "spawn" | "waypoint" | "trigger" | "pointLight",                // markers
  "scripts": [{ "script": "a1b2…", "name": "Door", "params": { "angle": 90 } }] // attached scripts (sources on the root)
}
```

The scene root's `userData` has `{ mapFormat, version, name, environment, terrain: { size, segments }, scripts: { id: { name, source } }, clips: [animation clips] }`. Rigged models' `rig` also records `restHips`, which the animator needs because models are exported in the editor's pose.
Terrain vertices form a grid: `index = iz * (segments + 1) + ix`, `x = ix * size / segments - size / 2` (z is the same).

### Notes
- Primitives and markers have their **pivot at the base**, so a `position` is the point on the ground.
- Spawn markers face **−Z**, which is the same as a three.js camera's forward direction.
- GLTFLoader cleans up node names (`"Player Spawn"` becomes `"Player_Spawn"`). The original name is kept in `userData.name`, and `map.findByName()` accepts either one.
- Animations inside imported models are not re-exported in the map GLB. Rigged models are exported in the pose the editor shows them in. Load animated characters separately in your game and place them using markers or tags. The playtest does this for the character under the Player Spawn.
- GLTFLoader also renames duplicate node names (`Grip_Primary_1`); `hold.js`'s `findNamed()` matches the original name.
- Map objects are nested in the GLB: a child's transform is local to its parent (or to the bone it's attached to), and colliders cover only an object's own meshes, not its children. In the layout JSON, objects are listed with parents first and carry `parentId` / `attachedTo`.
- Flat shading is a material setting and isn't stored in glTF.

## Project layout

```
src/editor/   Editor core: Terrain, Primitives, Markers, Entities, AssetLibrary, History, Project, Export, Rig, Tinyimgen
src/ui/       Panels, Inspector, DOM helpers
src/core/     Shared helpers, including the tinyimgen client (tinyimgen.js)
src/runtime/  MapLoader.js: drop-in loader for your game; scripts.js: runs the map's scripts; animator.js: clips + state machines for characters;
              PlayerController.script.js: the default player controller; hold.js + props.js: props held in a character's hand
src/anim/     Animation editor: clip library + evaluation (clips.js), skeleton, Mesh2Motion retargeting, AnimEditor
src/game/     First-person playtest demo (game.html)
public/       Draco + Basis decoders for compressed GLBs
```

## License

[MIT](LICENSE). The Draco and Basis decoders in `public/` come from three.js and keep their own licenses (Apache-2.0).
