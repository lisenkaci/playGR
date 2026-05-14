// Spacetime "river" visualisation: the grid itself flowing into mass.
//
// Conceptually a Lagrangian transport of grid intersections through the local
// gravitational flow. Each tracer is a "lattice node" that moves along the
// gradient of the gravitational potential and leaves a short trail of its
// recent past positions behind it. The trail is drawn as a connected polyline,
// so its segments are always tangent to the local flow direction -- not axis
// aligned. When tracers are dense enough the union of trails reads as the
// grid lines being drained inward into each body, in the style of the
// ScienceClic / Gullstrand-Painlevé "river of space" visualisation.
//
// Per-body, log-compressed potential summation: each body contributes its
// own normalised gradient direction times log10(1 + |escape velocity|), and
// the contributions sum vectorially. This is the same trick grid.js uses to
// stop a heavy body from drowning out smaller wells -- without it a solar
// mass next to an Earth-mass body would steal all the flow.
//
// Tracers recycle when they are absorbed by a body, exceed their random
// lifetime, or drift outside the bounding cube. Recycled tracers respawn at
// a random point on an outer face of the cube with their entire trail
// collapsed to that point, so there is no visual "teleport line" artefact.
//
// Trail history is shifted on a fixed real-time cadence (SHIFT_INTERVAL),
// not per frame, so the trail length is independent of framerate.

import * as THREE from 'three';
import { SCENE_SCALE_M_PER_UNIT } from './scale.js';

const TRAIL_POINTS = 12;                          // head + 11 past samples
const SEGMENTS_PER_TRAIL = TRAIL_POINTS - 1;      // 11 line segments per tracer
const SHIFT_INTERVAL = 0.055;                     // seconds between history shifts
const FLOW_SPEED = 0.85;                          // visual units / s per unit log-escape

export class SpacetimeFlow {
  /**
   * @param {object} [opts]
   * @param {number} [opts.count=1000] number of streamline tracers.
   *   Each tracer renders 11 line segments, so 1000 tracers ~ 11k segments,
   *   comparable to one lattice update at N=11 cells per axis.
   */
  constructor(opts = {}) {
    this.N = Math.max(64, opts.count || 1000);

    // Tracer state (positions in visual units, life in seconds).
    // History layout: this._hist[3 * (TRAIL_POINTS * i + k) + axis]
    //   k = 0  -> head (most recent position)
    //   k = TRAIL_POINTS - 1 -> oldest position (end of trail)
    this._hist    = new Float32Array(this.N * TRAIL_POINTS * 3);
    this._life    = new Float32Array(this.N);
    this._lifeMax = new Float32Array(this.N);
    this._shiftAccum = 0;

    // Render geometry: one LineSegments mesh containing every segment of
    // every tracer. Each tracer contributes SEGMENTS_PER_TRAIL line
    // segments = 2 * SEGMENTS_PER_TRAIL verts = 6 * SEGMENTS_PER_TRAIL
    // position floats.
    const totalSegs = this.N * SEGMENTS_PER_TRAIL;
    this._segPos = new Float32Array(totalSegs * 6);
    this._segCol = new Float32Array(totalSegs * 6);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this._segPos, 3));
    geom.setAttribute('color',    new THREE.BufferAttribute(this._segCol, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.lines = new THREE.LineSegments(geom, mat);
    this.mesh = this.lines;
    this.mesh.visible = false;

    // Snapshot caches (grown lazily).
    this._smass = new Float64Array(64);
    this._sR    = new Float64Array(64);
    this._sx    = new Float64Array(64);
    this._sy    = new Float64Array(64);
    this._sz    = new Float64Array(64);

    // Visualisation cube (in visual units). Updated by main.js each frame.
    this._halfVisual = 10;
    this._cx = 0; this._cy = 0; this._cz = 0;

    // Initial spawn: arrange tracers on a uniform 3D grid filling the cube,
    // so the first rendered frame already shows a populated lattice rather
    // than slowly filling in from the boundary over the first few seconds.
    this._populateUniform();
  }

  setVisible(v) { this.mesh.visible = !!v; }

  /** Set the visualisation cube. Tracers respawn on its outer faces. */
  setBounds(cx, cy, cz, halfVisual) {
    this._cx = cx; this._cy = cy; this._cz = cz;
    this._halfVisual = Math.max(1.0, halfVisual);
  }

  /**
   * Resize the tracer pool. No-op if the count is already `n`. The trail
   * history, life buffers, and geometry are reallocated to fit the new
   * count, then the cube is re-seeded with a fresh uniform population so
   * the user sees an immediate density change instead of waiting for the
   * existing tracers to drift and expire.
   */
  setCount(n) {
    const clamped = Math.max(64, Math.round(n));
    if (clamped === this.N) return;
    this.N = clamped;
    this._hist    = new Float32Array(this.N * TRAIL_POINTS * 3);
    this._life    = new Float32Array(this.N);
    this._lifeMax = new Float32Array(this.N);
    const totalSegs = this.N * SEGMENTS_PER_TRAIL;
    this._segPos = new Float32Array(totalSegs * 6);
    this._segCol = new Float32Array(totalSegs * 6);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this._segPos, 3));
    geom.setAttribute('color',    new THREE.BufferAttribute(this._segCol, 3));
    if (this.lines.geometry) this.lines.geometry.dispose();
    this.lines.geometry = geom;
    this._populateUniform();
  }

  /** Current number of tracers. */
  getCount() { return this.N; }

  _populateUniform() {
    const nPerSide = Math.max(2, Math.ceil(Math.cbrt(this.N)));
    let idx = 0;
    const h = this._halfVisual;
    for (let kk = 0; kk < nPerSide && idx < this.N; kk++) {
      for (let jj = 0; jj < nPerSide && idx < this.N; jj++) {
        for (let ii = 0; ii < nPerSide && idx < this.N; ii++) {
          const fx = (ii + 0.5) / nPerSide - 0.5;
          const fy = (jj + 0.5) / nPerSide - 0.5;
          const fz = (kk + 0.5) / nPerSide - 0.5;
          const px = this._cx + 2 * h * fx;
          const py = this._cy + 2 * h * fy;
          const pz = this._cz + 2 * h * fz;
          this._setEntireTrail(idx, px, py, pz);
          this._lifeMax[idx] = 3.0 + Math.random() * 5.0;
          // Stagger initial lives so the first wave of respawns isn't
          // synchronised across all tracers.
          this._life[idx] = Math.random() * this._lifeMax[idx];
          idx++;
        }
      }
    }
    for (; idx < this.N; idx++) this._respawnAtBoundary(idx, true);
  }

  _setEntireTrail(i, x, y, z) {
    const base = TRAIL_POINTS * i;
    for (let k = 0; k < TRAIL_POINTS; k++) {
      this._hist[3 * (base + k) + 0] = x;
      this._hist[3 * (base + k) + 1] = y;
      this._hist[3 * (base + k) + 2] = z;
    }
  }

  _respawnAtBoundary(i, randomizePhase = false) {
    const h = this._halfVisual;
    const face = Math.floor(Math.random() * 6);
    const u = (Math.random() * 2 - 1) * h;
    const v = (Math.random() * 2 - 1) * h;
    let x, y, z;
    switch (face) {
      case 0: x = -h; y =  u; z =  v; break;
      case 1: x = +h; y =  u; z =  v; break;
      case 2: x =  u; y = -h; z =  v; break;
      case 3: x =  u; y = +h; z =  v; break;
      case 4: x =  u; y =  v; z = -h; break;
      default: x = u; y =  v; z = +h; break;
    }
    this._setEntireTrail(i, this._cx + x, this._cy + y, this._cz + z);
    this._lifeMax[i] = 3.0 + Math.random() * 5.0;
    this._life[i] = randomizePhase ? Math.random() * this._lifeMax[i] : 0;
  }

  _ensureCaches(np) {
    if (this._smass.length >= np) return;
    let cap = this._smass.length;
    while (cap < np) cap *= 2;
    this._smass = new Float64Array(cap);
    this._sR    = new Float64Array(cap);
    this._sx    = new Float64Array(cap);
    this._sy    = new Float64Array(cap);
    this._sz    = new Float64Array(cap);
  }

  /**
   * Advance every tracer by `wallDtSec` of wall-clock time. Cheap to call
   * when the mesh is hidden (we early-return after the visibility check).
   *
   * @param {number} wallDtSec - real-time seconds since previous call.
   * @param {Float64Array} snap - bridge snapshot (positions in metres).
   * @param {number} fpp - floats per particle in the snapshot.
   * @param {number} G - gravitational constant (SI).
   */
  update(wallDtSec, snap, fpp, G) {
    if (!this.mesh.visible) return;

    const SCENE = SCENE_SCALE_M_PER_UNIT;
    const inv_S = 1.0 / SCENE;
    const np = (snap.length / fpp) | 0;

    this._ensureCaches(np);
    const sm = this._smass, sR = this._sR;
    const sx = this._sx, sy = this._sy, sz = this._sz;
    for (let m = 0, k = 0; m < np; m++, k += fpp) {
      sm[m] = snap[k + 2];
      sR[m] = snap[k + 4] * inv_S; // visual-unit body radius
      sx[m] = snap[k + 5] * inv_S;
      sy[m] = snap[k + 6] * inv_S;
      sz[m] = snap[k + 7] * inv_S;
    }

    const cx = this._cx, cy = this._cy, cz = this._cz, h = this._halfVisual;

    // Shift trail history on a fixed cadence so trail *length* (and hence
    // the way it traces past motion) is independent of framerate.
    this._shiftAccum += wallDtSec;
    const shouldShift = this._shiftAccum >= SHIFT_INTERVAL;
    if (shouldShift) this._shiftAccum -= SHIFT_INTERVAL;

    const segPos = this._segPos;
    const segCol = this._segCol;
    const SPT = SEGMENTS_PER_TRAIL;

    for (let i = 0; i < this.N; i++) {
      const base = TRAIL_POINTS * i;
      // Head position (most recent point of the trail).
      let px = this._hist[3 * base + 0];
      let py = this._hist[3 * base + 1];
      let pz = this._hist[3 * base + 2];

      // === Flow velocity at head ===
      // Per-body log-compressed escape speed times normalised gradient
      // direction, summed across all bodies. This is exactly the
      // accumulation grid.js uses for the lattice flow pulses, so the two
      // visualisations stay consistent in the same scene.
      let vx = 0, vy = 0, vz = 0;
      let strongestSpeed = 0;
      for (let m = 0; m < np; m++) {
        const dx = px - sx[m];
        const dy = py - sy[m];
        const dz = pz - sz[m];
        const r2 = dx * dx + dy * dy + dz * dz;
        const r = Math.sqrt(r2);
        if (r < 1e-9) continue;
        const Rv = sR[m];
        const Rphys = Rv * SCENE;
        const rPhys = r * SCENE;
        const gm = G * sm[m];
        let phi_i;
        if (rPhys >= Rphys) {
          phi_i = -gm / rPhys;
        } else {
          phi_i = -(gm / (2 * Rphys)) * (3 - (rPhys * rPhys) / (Rphys * Rphys));
        }
        const escSpeed = Math.sqrt(2 * Math.abs(phi_i));
        const logSpeed = Math.log10(1 + escSpeed * 1e-4);
        if (logSpeed > strongestSpeed) strongestSpeed = logSpeed;
        const inv_r = 1.0 / r;
        vx -= dx * inv_r * logSpeed;
        vy -= dy * inv_r * logSpeed;
        vz -= dz * inv_r * logSpeed;
      }

      // Advance the head smoothly each frame.
      const dt = wallDtSec * FLOW_SPEED;
      px += vx * dt;
      py += vy * dt;
      pz += vz * dt;

      // Absorbed by any body?
      let absorbed = false;
      for (let m = 0; m < np; m++) {
        const dx = px - sx[m];
        const dy = py - sy[m];
        const dz = pz - sz[m];
        if (dx * dx + dy * dy + dz * dz < sR[m] * sR[m]) {
          absorbed = true;
          break;
        }
      }

      this._life[i] += wallDtSec;
      const expired = this._life[i] >= this._lifeMax[i];
      // Small slop past the cube boundary so tracers don't pop the instant
      // their drift takes them outside.
      const out = Math.abs(px - cx) > h * 1.15
               || Math.abs(py - cy) > h * 1.15
               || Math.abs(pz - cz) > h * 1.15;

      if (absorbed || expired || out) {
        // Collapse the entire trail to the new spawn point so the next
        // few frames don't draw a long line across space.
        this._respawnAtBoundary(i);
      } else {
        if (shouldShift) {
          // Slide every history slot one position toward the tail end of
          // the trail. The oldest sample falls off; the old head moves to
          // hist[1]; we then overwrite hist[0] with the new advanced head.
          for (let k = TRAIL_POINTS - 1; k > 0; k--) {
            const dst = 3 * (base + k);
            const src = 3 * (base + k - 1);
            this._hist[dst + 0] = this._hist[src + 0];
            this._hist[dst + 1] = this._hist[src + 1];
            this._hist[dst + 2] = this._hist[src + 2];
          }
        }
        this._hist[3 * base + 0] = px;
        this._hist[3 * base + 1] = py;
        this._hist[3 * base + 2] = pz;
      }

      // === Build segments ===
      // Connect each pair of consecutive history points. Brightness fades
      // along the trail (bright at head, dim at tail) and is modulated by
      // a life envelope (fade in / fade out) and proximity to the nearest
      // well so streamers brighten as they accelerate into a mass.
      const lifeFrac = this._life[i] / this._lifeMax[i];
      let env;
      if (lifeFrac < 0.18) env = lifeFrac / 0.18;
      else if (lifeFrac > 0.88) env = (1 - lifeFrac) / 0.12;
      else env = 1.0;
      const proximity = Math.min(1.0, strongestSpeed * 0.30);
      const baseBright = (0.20 + 0.80 * proximity) * env;

      const trailBase = i * SPT * 6;
      for (let seg = 0; seg < SPT; seg++) {
        const k1 = 3 * (base + seg);
        const k2 = 3 * (base + seg + 1);
        const g = trailBase + seg * 6;
        segPos[g + 0] = this._hist[k1 + 0];
        segPos[g + 1] = this._hist[k1 + 1];
        segPos[g + 2] = this._hist[k1 + 2];
        segPos[g + 3] = this._hist[k2 + 0];
        segPos[g + 4] = this._hist[k2 + 1];
        segPos[g + 5] = this._hist[k2 + 2];

        // Quadratic head->tail falloff produces a comet-tail look.
        const tA = seg / SPT;
        const tB = (seg + 1) / SPT;
        const bA = baseBright * (1 - tA) * (1 - tA);
        const bB = baseBright * (1 - tB) * (1 - tB);
        // Cool blue->white palette. Additive blending makes high values
        // bloom over the background fog.
        segCol[g + 0] = 0.55 * bA;
        segCol[g + 1] = 0.80 * bA;
        segCol[g + 2] = 1.00 * bA;
        segCol[g + 3] = 0.55 * bB;
        segCol[g + 4] = 0.80 * bB;
        segCol[g + 5] = 1.00 * bB;
      }
    }

    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }
}
