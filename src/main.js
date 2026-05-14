// Entry point. Boots the WASM physics engine, sets up the Three.js scene, and
// runs the animation loop. One wall-clock frame =
//
//   1. Read wall-clock delta time.
//   2. Convert to a physics-time delta via the UI's time-scale slider.
//   3. Step the WASM physics by that delta (subdivided adaptively by Rust).
//   4. Pull a snapshot of (positions, velocities, gamma, ...) into a
//      Float64Array view of WASM linear memory (zero copy).
//   5. Push that snapshot to the renderer, grid, jets, and (if enabled)
//      force-vector overlay.
//   6. Render Three.js.

import * as THREE from 'three';
import { PhysicsBridge } from './physicsBridge.js';
import { Renderer } from './renderer.js';
import { SpacetimeGrid } from './grid.js';
import { SpacetimeFlow } from './flow.js';
import { JetField } from './jets.js';
import { ForceOverlay } from './debug.js';
import { UI } from './ui.js';
import { InteractionHandler } from './interaction.js';
import { SCENE_SCALE_M_PER_UNIT, physRadiusToVisual } from './scale.js';

async function main() {
  const canvas = document.getElementById('viewport');

  const bridge = new PhysicsBridge();
  await bridge.init();

  const renderer = new Renderer(canvas);
  const grid = new SpacetimeGrid();
  renderer.scene.add(grid.mesh);
  const flow = new SpacetimeFlow({ count: 1200 });
  renderer.scene.add(flow.mesh);
  const jets = new JetField();
  renderer.scene.add(jets.group);
  const forces = new ForceOverlay();
  renderer.scene.add(forces.group);
  forces.setVisible(false);

  // Forward declarations so the UI callbacks below can mutate the loop state.
  // eslint-disable-next-line prefer-const
  let resetExtent = () => {};

  // Spawn anchor: start at the camera's orbit target, then offset laterally
  // (camera-right) until the new body's *true physical radius* clears every
  // existing body's true physical radius (plus a small margin). We compare
  // physical radii via SCENE_SCALE -- not physRadiusToVisual, which is a
  // logarithmic display scale that does NOT reflect collision geometry. A
  // solar-mass body has a 70-visual-unit physical extent (7e6 m / 1e5
  // m/unit), so two of them must be ~140 units apart visually to avoid the
  // hard-sphere collision/merger that was eating new spawns silently.
  const _tmpVec = new THREE.Vector3();
  const _camDir = new THREE.Vector3();
  const _right  = new THREE.Vector3();
  const _anchor = new THREE.Vector3();
  function getSpawnAnchorPhys() {
    const t = renderer.controls.target;
    renderer.camera.getWorldDirection(_camDir);
    _right.crossVectors(_camDir, renderer.camera.up).normalize();
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);

    const snap = bridge.snapshotView();
    const fpp = bridge.floatsPerParticle;
    const invS = 1.0 / SCENE_SCALE_M_PER_UNIT;

    // The largest already-alive body's TRUE radius (visual units = phys/scale).
    // We assume the new body is at least this big in the worst case, so
    // required separation between centres is >= 2 * maxTrueRadius + margin.
    let maxTrueRadius = 0;
    for (let k = 0; k < snap.length; k += fpp) {
      const tr = snap[k + 4] * invS;
      if (tr > maxTrueRadius) maxTrueRadius = tr;
    }
    const MARGIN = 4; // visual units of free space between surfaces
    const SEP = 2 * maxTrueRadius + MARGIN;

    _anchor.copy(t);
    for (let i = 0; i < 32; i++) {
      let safe = true;
      for (let k = 0; k < snap.length; k += fpp) {
        _tmpVec.set(snap[k + 5] * invS, snap[k + 6] * invS, snap[k + 7] * invS);
        const trueR = snap[k + 4] * invS;
        // The new body's worst-case radius is maxTrueRadius. Need centre-to-
        // centre distance >= trueR + maxTrueRadius + MARGIN.
        if (_anchor.distanceTo(_tmpVec) < trueR + maxTrueRadius + MARGIN) {
          safe = false; break;
        }
      }
      if (safe) break;
      _anchor.copy(t).addScaledVector(_right, (i + 1) * SEP);
    }
    return [
      _anchor.x * SCENE_SCALE_M_PER_UNIT,
      _anchor.y * SCENE_SCALE_M_PER_UNIT,
      _anchor.z * SCENE_SCALE_M_PER_UNIT,
    ];
  }

  // Lattice extent stays a fixed lab frame -- never grows with body position.
  // Dragging a body off-screen does NOT expand the cube to engulf the view.
  // The user can override the size by dragging any of the 8 corner handles
  // on the grid (see InteractionHandler), in which case auto-grow shuts off
  // and the manually-set extent is respected.
  const LATTICE_MIN = 8;
  const LATTICE_MAX_AUTO = 14;
  const LATTICE_MIN_DRAG = 3;
  const LATTICE_MAX_DRAG = 800;
  let latticeHalfVisual = LATTICE_MIN;
  let latticeUserOverride = false;
  resetExtent = () => {
    latticeHalfVisual = LATTICE_MIN;
    latticeUserOverride = false;
  };

  // Build a bounding box that always contains the stationary lattice cube
  // at the origin AND every alive body's visible sphere. The "Frame all
  // bodies" button feeds this into renderer.frameBox so the camera never
  // ends up far from the grid -- even when bodies have flown thousands of
  // visual units away from the origin (which happens routinely after a few
  // hundred sim-seconds of solar-mass close encounters).
  function computeFrameAllBox() {
    const box = new THREE.Box3();
    const h = latticeHalfVisual;
    box.expandByPoint(new THREE.Vector3(-h, -h, -h));
    box.expandByPoint(new THREE.Vector3( h,  h,  h));
    const snap = bridge.snapshotView();
    const fpp = bridge.floatsPerParticle;
    const invS = 1.0 / SCENE_SCALE_M_PER_UNIT;
    for (let k = 0; k < snap.length; k += fpp) {
      const x = snap[k + 5] * invS;
      const y = snap[k + 6] * invS;
      const z = snap[k + 7] * invS;
      const rv = physRadiusToVisual(snap[k + 4]);
      box.expandByPoint(new THREE.Vector3(x - rv, y - rv, z - rv));
      box.expandByPoint(new THREE.Vector3(x + rv, y + rv, z + rv));
    }
    return box;
  }

  const ui = new UI({
    bridge, grid, flow, jets, forces,
    getSpawnAnchorPhys,
    onFrameAll: () => renderer.frameBox(computeFrameAllBox()),
    onReset: () => { resetExtent(); ui && ui.setSelected(null); },
  });

  // Pointer interaction: click on a particle to grab and drag, click an empty
  // space (with "Click in viewport to spawn" enabled) to drop a new one, or
  // grab one of the eight corner cubes of the spacetime lattice to resize
  // the grid. Wired after UI so the toggle state can be queried.
  // eslint-disable-next-line no-unused-vars
  const interaction = new InteractionHandler({
    canvas,
    camera: renderer.camera,
    controls: renderer.controls,
    particleGroup: renderer.particleGroup,
    bridge,
    onSpawnAt: (worldPoint) => ui.spawnAtVisualPoint(worldPoint),
    shouldSpawnOnClick: () => ui.clickToSpawn,
    getGridHandles: () => (grid.mesh.visible ? grid.getCornerHandles() : []),
    setGridHoverHandle: (h) => grid.setHoveredHandle(h),
    onGridResize: (newH) => {
      latticeHalfVisual = Math.max(LATTICE_MIN_DRAG, Math.min(LATTICE_MAX_DRAG, newH));
      latticeUserOverride = true;
    },
    onSelect: (id) => ui.setSelected(id),
  });

  let lastWall = performance.now();
  const DT_MAX = 1.0e-3; // upper bound on internal substep, seconds

  function frame(now) {
    const wallDt = Math.min((now - lastWall) / 1000, 0.1);
    lastWall = now;

    if (!ui.paused) {
      const physDt = wallDt * ui.timeScale;
      if (physDt > 0) bridge.advance(physDt, DT_MAX);
    }

    const snap = bridge.snapshotView();
    bridge.setSnapshotForPotentials(snap);
    const fpp = bridge.floatsPerParticle;

    renderer.syncParticles(snap, fpp);

    // Lattice extent: fixed-size lab frame, slightly larger than the biggest
    // alive body's visual radius. Critically: NOT proportional to body
    // position. Dragging the body away does not enlarge the cube.
    //
    // If the user has manually resized the cube (by dragging a corner
    // handle), latticeUserOverride is true and auto-grow is disabled --
    // the cube stays exactly the size the user set, with no further
    // adjustment, until the scene is cleared.
    let maxVisualRadius = 0;
    for (let k = 0; k < snap.length; k += fpp) {
      const rv = physRadiusToVisual(snap[k + 4]);
      if (rv > maxVisualRadius) maxVisualRadius = rv;
    }
    let halfVisual;
    if (latticeUserOverride) {
      halfVisual = latticeHalfVisual;
    } else {
      const requiredHalf = Math.max(LATTICE_MIN, 3 * maxVisualRadius + 6);
      halfVisual = Math.min(LATTICE_MAX_AUTO, Math.max(latticeHalfVisual, requiredHalf));
      latticeHalfVisual = halfVisual;
    }

    if (grid.mesh.visible) {
      grid.setVisualBounds(0, 0, 0, halfVisual);
      grid.update(wallDt, snap, fpp, bridge.constants.G);
    }
    if (flow.mesh.visible) {
      flow.setBounds(0, 0, 0, halfVisual);
      flow.update(wallDt, snap, fpp, bridge.constants.G);
    }
    if (jets.group.visible) jets.syncFromSnapshot(snap, fpp);
    if (ui.showForces) forces.update(snap, fpp, (x, y, z) => bridge.sampleFields(x, y, z));

    // Auto-fit on spawn is intentionally NOT done here.
    //
    // The renderer already auto-fits on the empty -> populated transition
    // (see `_wasEmpty` in renderer.syncParticles), so a fresh scene's first
    // spawn frames itself. After that we leave the camera alone: refitting
    // on every count-increase was disorienting because the fit dolly is
    // sized by the *furthest* body from the origin. With one body thrown
    // out into a wide orbit and the user spawning another near the camera
    // target, the camera would yank back to the origin and zoom way out
    // to engulf the orbiting body -- the user-reported "zoom sketches
    // out" behaviour. The "Frame all bodies" button is still available
    // for an explicit user-initiated refit.

    ui.refreshDiagnostics(bridge);
    ui.refreshInspector(snap, fpp);
    renderer.render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  const root = document.getElementById('app') || document.body;
  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;inset:20px;background:#1a0010;color:#ff8080;padding:16px;border-radius:8px;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;z-index:99';
  box.textContent = `Failed to initialise:\n${err && err.stack ? err.stack : err}`;
  root.appendChild(box);
});
