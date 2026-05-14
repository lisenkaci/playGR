// Pointer-driven scene editing: drag existing particles, drag-out new ones
// from empty space, and throw any of them on release.
//
// Drag of an existing body uses a raycast against every alive particle mesh;
// on hit, a drag plane perpendicular to the camera at the particle's depth
// is set up, and pointer motion is projected onto that plane. Position
// updates are pushed into WASM via `bridge.teleport(id, [x,y,z])`, which
// also resets the particle's history ring buffer so retarded-field "ghost
// trails" don't form.
//
// Drag-out spawn: when click-to-spawn is enabled and the user presses on
// empty space, we project the pointer onto a plane perpendicular to the
// camera through the orbit target, fire the spawn IMMEDIATELY at that
// world point, and enter a "spawn drag" state. Subsequent pointer motion
// teleports the just-spawned body so it tracks the cursor exactly, giving
// the user pixel-precise placement before commit. The same throw-on-
// release logic applies as for existing-body drags.
//
// Throw on release: while either drag mode is active, we record
// (position, time) samples in a small ring buffer pruned to the last
// 200 ms. On pointer-up we estimate the cursor's recent world-space
// velocity from the samples within the THROW_WINDOW (most recent ~120 ms)
// and apply it as the body's velocity. Stopping the cursor for >120 ms
// before release produces a clean zero-vel drop; flicking the mouse
// imparts proportional velocity, so the user can throw masses into orbit.
// No amplification -- the imparted speed equals the cursor's recent
// on-plane speed in m/s.

import * as THREE from 'three';
import { visualToPhys } from './scale.js';

// How long we retain pointer samples during a drag (ms). Anything older is
// pruned each move so the ring stays bounded.
const SAMPLE_RETENTION_MS = 200;
// Time window (ms) used to estimate the throw velocity on release. Smaller =
// snappier feel but more sensitive to jitter; larger = smoother but lags the
// most recent flick. 120 ms is a good middle ground for hand-tracked
// pointing.
const THROW_WINDOW_MS = 120;

export class InteractionHandler {
  /**
   * @param {object} ctx
   * @param {HTMLCanvasElement} ctx.canvas
   * @param {THREE.PerspectiveCamera} ctx.camera
   * @param {import('three/addons/controls/OrbitControls.js').OrbitControls} ctx.controls
   * @param {THREE.Group} ctx.particleGroup
   * @param {import('./physicsBridge.js').PhysicsBridge} ctx.bridge
   * @param {(world:THREE.Vector3) => void} ctx.onSpawnAt
   * @param {() => boolean} ctx.shouldSpawnOnClick - returns true if click-to-spawn is enabled
   * @param {() => THREE.Mesh[]} [ctx.getGridHandles] - returns the eight
   *        corner-handle meshes of the spacetime lattice (empty array if
   *        the lattice is hidden). Used for hit-testing the resize drag.
   * @param {(handle: THREE.Mesh|null) => void} [ctx.setGridHoverHandle] -
   *        callback for hover feedback (highlight one handle on mouseover).
   * @param {(newHalfVisual: number) => void} [ctx.onGridResize] - called
   *        every pointer-move while dragging a corner handle, with the
   *        proposed new half-extent of the lattice cube in visual units.
   * @param {(id:number|null) => void} [ctx.onSelect] - called with a body's
   *        id when the user clicks (or starts dragging) it. Called with null
   *        when the user clicks empty space without spawning. Used by the
   *        Body Inspector UI panel.
   */
  constructor({
    canvas, camera, controls, particleGroup, bridge, onSpawnAt, shouldSpawnOnClick,
    getGridHandles, setGridHoverHandle, onGridResize, onSelect,
  }) {
    this.canvas = canvas;
    this.camera = camera;
    this.controls = controls;
    this.particleGroup = particleGroup;
    this.bridge = bridge;
    this.onSpawnAt = onSpawnAt;
    this.shouldSpawnOnClick = shouldSpawnOnClick;
    this.getGridHandles      = getGridHandles      || (() => []);
    this.setGridHoverHandle  = setGridHoverHandle  || (() => {});
    this.onGridResize        = onGridResize        || (() => {});
    this.onSelect            = onSelect            || (() => {});

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.dragPlane = new THREE.Plane();
    this.dragOffset = new THREE.Vector3();
    // Spawn plane is recomputed each click to be camera-perpendicular through
    // the current orbit target -- gives intuitive 3D placement.
    this.spawnPlane = new THREE.Plane();
    /** @type {THREE.Mesh|null} */ this.dragMesh    = null;
    /** @type {THREE.Mesh|null} */ this.hoverMesh   = null;
    /** @type {THREE.Mesh|null} */ this.dragHandle  = null;
    /** @type {THREE.Mesh|null} */ this.hoverHandle = null;

    // Drag-out spawn: ID of the body that was created on pointer-down and
    // is currently following the cursor. The mesh for this body may not
    // exist yet on the first frame after spawn, so we identify it by ID
    // and look up the mesh lazily during pointer-move to update its
    // visible position without waiting for the next snapshot-sync.
    /** @type {number|null} */ this.spawnDragId  = null;

    // Ring buffer of recent drag samples for the throw-velocity estimate.
    // Each entry: { x, y, z, t } -- world-space (visual-unit) position and
    // performance.now() timestamp in ms. Pruned to SAMPLE_RETENTION_MS.
    /** @type {Array<{x:number,y:number,z:number,t:number}>|null} */
    this._dragSamples = null;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp   = this._onPointerUp.bind(this);
    canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup',   this._onPointerUp);

    canvas.style.cursor = 'default';
  }

  _setPointer(ev) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  }

  _pickParticle() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.particleGroup.children, false);
    return hits.length > 0 ? hits[0] : null;
  }

  _pickGridHandle() {
    const arr = this.getGridHandles();
    if (!arr || arr.length === 0) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(arr, false);
    return hits.length > 0 ? hits[0] : null;
  }

  _onPointerDown(ev) {
    if (ev.button !== 0) return; // left-click only
    this._setPointer(ev);

    // Grid-resize handles take priority over particle drag so the user can
    // grab a corner cube even when a particle is behind it.
    const handleHit = this._pickGridHandle();
    if (handleHit) {
      ev.preventDefault();
      this.dragHandle = handleHit.object;
      this.controls.enabled = false;
      const camDir = new THREE.Vector3();
      this.camera.getWorldDirection(camDir);
      this.dragPlane.setFromNormalAndCoplanarPoint(camDir, this.dragHandle.position);
      this.canvas.style.cursor = 'nwse-resize';
      try { this.canvas.setPointerCapture(ev.pointerId); } catch (_) {}
      return;
    }

    const hit = this._pickParticle();
    if (hit) {
      ev.preventDefault();
      this.dragMesh = hit.object;
      this.controls.enabled = false; // disable orbit during drag

      // Notify the Inspector that this body is now selected. Selection
      // happens on pointer-down whether or not the user goes on to drag.
      const pickedId = this.dragMesh.userData && this.dragMesh.userData.id;
      if (typeof pickedId === 'number') this.onSelect(pickedId);

      // Set drag plane perpendicular to camera, through the particle.
      const camDir = new THREE.Vector3();
      this.camera.getWorldDirection(camDir);
      this.dragPlane.setFromNormalAndCoplanarPoint(camDir, this.dragMesh.position);
      // Compute offset between the picked point on the plane and the particle
      // centre, so the drag feels anchored under the cursor.
      const hitPoint = new THREE.Vector3();
      this.raycaster.ray.intersectPlane(this.dragPlane, hitPoint);
      this.dragOffset.copy(this.dragMesh.position).sub(hitPoint);

      // Start a fresh sample ring for the throw-velocity estimate. Seed
      // with the initial pick point so we have at least one anchor in
      // case the user releases without ever moving (which produces zero
      // throw, as expected).
      this._dragSamples = [{
        x: this.dragMesh.position.x,
        y: this.dragMesh.position.y,
        z: this.dragMesh.position.z,
        t: performance.now(),
      }];

      this.canvas.style.cursor = 'grabbing';
      try { this.canvas.setPointerCapture(ev.pointerId); } catch (_) {}
      return;
    }

    // Empty space + click-to-spawn enabled: spawn immediately at the
    // pointer's world-projected point and enter drag-out placement mode.
    // The body follows the cursor until release, at which point throw-
    // velocity sampling decides whether to commit it at rest or with
    // momentum. If spawn fails (e.g. weak-field guard rejects the spec)
    // we leave the camera-orbit drag enabled so the click acts as a
    // no-op for the user.
    if (this.shouldSpawnOnClick && this.shouldSpawnOnClick() && this.onSpawnAt) {
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const camDir = new THREE.Vector3();
      this.camera.getWorldDirection(camDir);
      this.spawnPlane.setFromNormalAndCoplanarPoint(camDir, this.controls.target);
      const hitPoint = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.spawnPlane, hitPoint)) {
        const result = this.onSpawnAt(hitPoint);
        if (result && result.ok && typeof result.id === 'number') {
          ev.preventDefault();
          this.spawnDragId = result.id;
          this.controls.enabled = false;
          // Drag plane = camera-perpendicular through the spawn point, so
          // subsequent pointer moves stay on the depth the user clicked
          // at. dragOffset = 0 because the body is anchored exactly under
          // the cursor (the click point and the spawn point coincide).
          this.dragPlane.setFromNormalAndCoplanarPoint(camDir, hitPoint);
          this.dragOffset.set(0, 0, 0);
          this.onSelect(result.id);
          this._dragSamples = [{
            x: hitPoint.x, y: hitPoint.y, z: hitPoint.z, t: performance.now(),
          }];
          this.canvas.style.cursor = 'grabbing';
          try { this.canvas.setPointerCapture(ev.pointerId); } catch (_) {}
        }
      }
    }
  }

  _onPointerMove(ev) {
    this._setPointer(ev);

    // Grid-corner resize drag: project the pointer ray onto the camera-perp
    // plane through the dragged corner, then map that point to a uniform
    // half-extent via projection onto the corner's outward diagonal.
    //
    // The cube sits at the origin with corners at (sx*h, sy*h, sz*h). The
    // outward direction is (sx,sy,sz); dot of corner_pos with (sx,sy,sz) is
    // h*(sx^2+sy^2+sz^2) = 3*h. So h = dot(point, (sx,sy,sz)) / 3.
    if (this.dragHandle) {
      const hitPoint = new THREE.Vector3();
      this.raycaster.setFromCamera(this.pointer, this.camera);
      if (this.raycaster.ray.intersectPlane(this.dragPlane, hitPoint)) {
        const { signX, signY, signZ } = this.dragHandle.userData;
        const newH = (hitPoint.x * signX + hitPoint.y * signY + hitPoint.z * signZ) / 3;
        this.onGridResize(newH);
      }
      return;
    }

    if (this.dragMesh) {
      const hitPoint = new THREE.Vector3();
      if (this.raycaster.setFromCamera(this.pointer, this.camera),
          this.raycaster.ray.intersectPlane(this.dragPlane, hitPoint)) {
        const newVisualPos = hitPoint.add(this.dragOffset);
        this.dragMesh.position.copy(newVisualPos);
        const phys = visualToPhys([newVisualPos.x, newVisualPos.y, newVisualPos.z]);
        const id = this.dragMesh.userData.id;
        // Velocity zeroed during the drag so the body tracks the cursor
        // exactly instead of drifting under physics. The throw-velocity
        // is applied once, on pointer-up.
        this.bridge.teleport(id, phys, [0, 0, 0]);
        this._pushDragSample(newVisualPos);
      }
      return;
    }

    if (this.spawnDragId !== null) {
      // Drag-out placement of a just-spawned body. We don't have a mesh
      // reference at the very first move (the renderer creates it after
      // the next snapshot sync), so we look it up by id every frame and
      // copy the cursor position directly when available to avoid the
      // 1-frame snapshot-sync lag.
      const hitPoint = new THREE.Vector3();
      this.raycaster.setFromCamera(this.pointer, this.camera);
      if (this.raycaster.ray.intersectPlane(this.dragPlane, hitPoint)) {
        const newVisualPos = hitPoint.add(this.dragOffset);
        const phys = visualToPhys([newVisualPos.x, newVisualPos.y, newVisualPos.z]);
        this.bridge.teleport(this.spawnDragId, phys, [0, 0, 0]);
        const mesh = this._findMeshById(this.spawnDragId);
        if (mesh) mesh.position.copy(newVisualPos);
        this._pushDragSample(newVisualPos);
      }
      return;
    }

    // Hover priority: grid handles first (they're the resize controls), then
    // particles. We also reset hover state when the pointer leaves either.
    const handleHit = this._pickGridHandle();
    if (handleHit) {
      if (this.hoverHandle !== handleHit.object) {
        this.hoverHandle = handleHit.object;
        this.setGridHoverHandle(this.hoverHandle);
      }
      if (this.hoverMesh) this.hoverMesh = null;
      this.canvas.style.cursor = 'nwse-resize';
      return;
    }
    if (this.hoverHandle) {
      this.hoverHandle = null;
      this.setGridHoverHandle(null);
    }

    const hit = this._pickParticle();
    if (hit !== null && this.hoverMesh !== hit.object) {
      this.hoverMesh = hit.object;
      this.canvas.style.cursor = 'grab';
    } else if (hit === null && this.hoverMesh) {
      this.hoverMesh = null;
      this.canvas.style.cursor = this.shouldSpawnOnClick && this.shouldSpawnOnClick() ? 'crosshair' : 'default';
    } else if (hit === null) {
      this.canvas.style.cursor = this.shouldSpawnOnClick && this.shouldSpawnOnClick() ? 'crosshair' : 'default';
    }
  }

  _onPointerUp(ev) {
    if (this.dragHandle) {
      this.dragHandle = null;
      this.controls.enabled = true;
      this.canvas.style.cursor = 'default';
      try { this.canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
      return;
    }

    if (this.dragMesh) {
      const throwV = this._computeThrowVelocity();
      const id = this.dragMesh.userData.id;
      const pos = this.dragMesh.position;
      this.bridge.teleport(
        id,
        visualToPhys([pos.x, pos.y, pos.z]),
        throwV,
      );

      this.dragMesh = null;
      this._dragSamples = null;
      this.controls.enabled = true;
      this.canvas.style.cursor = 'default';
      try { this.canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
      return;
    }

    if (this.spawnDragId !== null) {
      const throwV = this._computeThrowVelocity();
      // Read current position from the mesh if it exists by now (1+ frames
      // after spawn); otherwise fall back to the most recent drag sample.
      let physPos = null;
      const mesh = this._findMeshById(this.spawnDragId);
      if (mesh) {
        physPos = visualToPhys([mesh.position.x, mesh.position.y, mesh.position.z]);
      } else if (this._dragSamples && this._dragSamples.length > 0) {
        const last = this._dragSamples[this._dragSamples.length - 1];
        physPos = visualToPhys([last.x, last.y, last.z]);
      }
      if (physPos) {
        this.bridge.teleport(this.spawnDragId, physPos, throwV);
      }

      this.spawnDragId = null;
      this._dragSamples = null;
      this.controls.enabled = true;
      this.canvas.style.cursor = 'default';
      try { this.canvas.releasePointerCapture(ev.pointerId); } catch (_) {}
      return;
    }
  }

  /**
   * Push a new (position, timestamp) sample for the throw-velocity
   * estimate, then prune anything older than SAMPLE_RETENTION_MS so the
   * ring stays bounded.
   *
   * @param {THREE.Vector3} pos - world-space position in visual units.
   */
  _pushDragSample(pos) {
    if (!this._dragSamples) return;
    const now = performance.now();
    this._dragSamples.push({ x: pos.x, y: pos.y, z: pos.z, t: now });
    const cutoff = now - SAMPLE_RETENTION_MS;
    while (this._dragSamples.length > 0 && this._dragSamples[0].t < cutoff) {
      this._dragSamples.shift();
    }
  }

  /**
   * Compute the throw velocity (in m/s, physical units) from samples
   * inside the most recent THROW_WINDOW_MS. Returns [0, 0, 0] when the
   * cursor was stationary in that window or there aren't enough samples
   * to interpolate, which gives a clean zero-velocity drop.
   *
   * @returns {[number, number, number]}
   */
  _computeThrowVelocity() {
    if (!this._dragSamples || this._dragSamples.length < 2) return [0, 0, 0];
    const now = performance.now();
    const winStart = now - THROW_WINDOW_MS;
    let oldestInWin = null;
    let newestInWin = null;
    for (const s of this._dragSamples) {
      if (s.t >= winStart) {
        if (oldestInWin === null) oldestInWin = s;
        newestInWin = s;
      }
    }
    if (!oldestInWin || !newestInWin || newestInWin === oldestInWin) return [0, 0, 0];
    const dtSec = (newestInWin.t - oldestInWin.t) / 1000;
    if (dtSec <= 0.01) return [0, 0, 0];
    const vx = (newestInWin.x - oldestInWin.x) / dtSec;
    const vy = (newestInWin.y - oldestInWin.y) / dtSec;
    const vz = (newestInWin.z - oldestInWin.z) / dtSec;
    return visualToPhys([vx, vy, vz]);
  }

  /**
   * Locate the rendered mesh for a given body id, by scanning the
   * particle group. Returns null if no mesh has been created yet for that
   * id (which is the case during the first frame after a drag-out spawn,
   * before the renderer's next snapshot-sync).
   *
   * @param {number} id - body id assigned by bridge.spawn.
   * @returns {THREE.Mesh|null}
   */
  _findMeshById(id) {
    if (!this.particleGroup) return null;
    for (const child of this.particleGroup.children) {
      if (child.userData && child.userData.id === id) return child;
    }
    return null;
  }
}
