// 3D spacetime lattice with flowing "river" pulses.
//
// The lattice is a uniform NxNxN cube of points connected by axis-aligned line
// segments (X-, Y-, and Z-running). Every frame:
//
//   1. main.js calls setVisualBounds(cx, cy, cz, halfVisual) with the
//      centroid and extent of the live bodies (in scene/visual units). The
//      lattice's rest positions are laid out to cover that region. Because
//      every other thing in the scene uses the same scale.js conversion
//      (SCENE_SCALE_M_PER_UNIT metres per visual unit), the lattice's wells
//      always sit exactly on top of the rendered bodies.
//
//   2. Each vertex is displaced from its rest position toward the local
//      gravitational gradient -∇Φ, by an amount equal to the signed-log of
//      |Φ/c²| (so weak fields and strong fields are both legible).
//
//   3. Each segment's vertex colours interpolate from "cool blue" (flat
//      space) to "warm amber" (deep well), so the lattice itself glows
//      toward the masses.
//
//   4. K luminous "pulses" travel along each segment at a rate equal to the
//      projection of -∇Φ̂ onto the segment direction at its midpoint. Pulses
//      on segments well aligned with the gravitational flow stream toward
//      the mass; misaligned segments drift slowly.
//
// All gradient/potential computations use the same uniform-sphere Newtonian
// formula as physicsBridge._potentialJS, so the visualization matches the
// physics it represents.

import * as THREE from 'three';
import { SCENE_SCALE_M_PER_UNIT } from './scale.js';

// Permitted range of vertices-per-axis. The lattice cost scales as N^3 so
// the upper cap keeps the per-frame potential-sampling loop honest. The user
// chooses N via the "Cell density" slider in the panel.
export const N_MIN = 6;
export const N_MAX = 25;
export const N_DEFAULT = 11;

const DEFAULT_HALF = 10;   // visual half-extent when no bodies are present
const PULSES_PER_SEG = 3;  // luminous dots per segment
const C = 2.997_924_58e8;
const C2 = C * C;

// Colour endpoints for the lattice line gradient.
const COOL_R = 0.30, COOL_G = 0.55, COOL_B = 0.95;
const HOT_R  = 1.00, HOT_G  = 0.78, HOT_B  = 0.45;

export class SpacetimeGrid {
  constructor() {
    // === Lattice line mesh (geometries rebuilt by _rebuildTopology) ===
    const segMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), segMat);

    const pulseMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(0xb6dcff) },
      },
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = 4.0 * (12.0 / max(-mv.z, 0.1));
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        uniform vec3 uColor;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d) * 2.0;
          if (r > 1.0) discard;
          float intensity = pow(1.0 - r, 1.6) * vAlpha;
          gl_FragColor = vec4(uColor * (0.55 + intensity * 1.2), intensity * 0.95);
        }
      `,
    });
    this.pulsePoints = new THREE.Points(new THREE.BufferGeometry(), pulseMat);

    // === Corner resize handles ===
    // Eight small grab-cubes at the corners of the lattice cube. The user
    // can click and drag any of them to scale the lattice uniformly (the
    // pointer-drag mapping lives in interaction.js / main.js). They are
    // intentionally bright and slightly oversized so they read as
    // grab-able controls even at a distance.
    const handleGeom = new THREE.BoxGeometry(1, 1, 1);
    this._handleMatIdle = new THREE.MeshStandardMaterial({
      color: 0x6ad1ff,
      emissive: 0x1f5a8c,
      emissiveIntensity: 1.6,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    this._handleMatHover = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffae54,
      emissiveIntensity: 3.0,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    this.cornerHandles = new THREE.Group();
    /** @type {THREE.Mesh[]} */
    this._handles = [];
    for (let c = 0; c < 8; c++) {
      const sx = (c & 1) ? +1 : -1;
      const sy = (c & 2) ? +1 : -1;
      const sz = (c & 4) ? +1 : -1;
      const m = new THREE.Mesh(handleGeom, this._handleMatIdle);
      m.userData = { isGridCornerHandle: true, signX: sx, signY: sy, signZ: sz };
      m.renderOrder = 10;
      this._handles.push(m);
      this.cornerHandles.add(m);
    }

    this.mesh = new THREE.Group();
    this.mesh.add(this.lines);
    this.mesh.add(this.pulsePoints);
    this.mesh.add(this.cornerHandles);

    // Snapshot caches (resized lazily).
    this._smass = new Float64Array(64);
    this._sR    = new Float64Array(64);
    this._sx    = new Float64Array(64);
    this._sy    = new Float64Array(64);
    this._sz    = new Float64Array(64);
    // Spin angular momentum per body (S_x, S_y, S_z) -- needed by the
    // gravitomagnetic vector potential A_g, which is what makes the lattice
    // swirl around spinning bodies (the frame-dragging visualisation).
    this._sSx   = new Float64Array(64);
    this._sSy   = new Float64Array(64);
    this._sSz   = new Float64Array(64);

    // Visual bounds: cube of half-extent _halfVisual centred at _cx,_cy,_cz.
    // main.js updates these every frame to cover the bodies.
    this._cx = 0; this._cy = 0; this._cz = 0;
    this._halfVisual = DEFAULT_HALF;
    this._N = 0;

    // Build the initial topology. Cell count is user-controlled via
    // setCellCount; the cube extent and cell count are independent dials.
    this._rebuildTopology(N_DEFAULT);
    this._computeRest();

    this.visualGain = 1.0;
  }

  /**
   * Set how many vertices the lattice has along each axis. Clamps to
   * [N_MIN, N_MAX]. A topology rebuild is triggered only if the value
   * actually changes; otherwise this is a no-op.
   *
   * @param {number} n - desired vertex count per axis.
   */
  setCellCount(n) {
    const clamped = Math.max(N_MIN, Math.min(N_MAX, Math.round(n)));
    if (clamped === this._N) return;
    this._rebuildTopology(clamped);
    this._computeRest();
  }

  /** Current vertices-per-axis. */
  getCellCount() { return this._N; }

  /**
   * Allocate every N-dependent buffer and refresh the line/pulse
   * BufferGeometries to match. Called from the constructor and from
   * setVisualBounds whenever the desired cell count changes (i.e. when the
   * user has resized the cube enough that the cell density would otherwise
   * drift away from TARGET_CELL_SIZE).
   *
   * @param {number} newN - new vertices-per-axis count, in [N_MIN, N_MAX].
   */
  _rebuildTopology(newN) {
    if (newN === this._N) return;
    const N = newN;
    const Nm1 = N - 1;
    const verts = N * N * N;
    const segs = 3 * N * N * Nm1;
    this._N = N;
    this._verts = verts;
    this._segs = segs;

    // Normalised rest positions in [-1, 1]^3.
    this._restNorm = new Float32Array(verts * 3);
    let vi = 0;
    for (let k = 0; k < N; k++) {
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          this._restNorm[3 * vi + 0] = (i / Nm1) * 2 - 1;
          this._restNorm[3 * vi + 1] = (j / Nm1) * 2 - 1;
          this._restNorm[3 * vi + 2] = (k / Nm1) * 2 - 1;
          vi++;
        }
      }
    }
    this._rest = new Float32Array(verts * 3);
    this._current = new Float32Array(verts * 3);

    // Segment endpoint vertex indices.
    this._segStart = new Uint32Array(segs);
    this._segEnd = new Uint32Array(segs);
    const idx = (i, j, k) => i + j * N + k * N * N;
    let s = 0;
    for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < Nm1; i++) {
      this._segStart[s] = idx(i, j, k); this._segEnd[s] = idx(i + 1, j, k); s++;
    }
    for (let k = 0; k < N; k++) for (let j = 0; j < Nm1; j++) for (let i = 0; i < N; i++) {
      this._segStart[s] = idx(i, j, k); this._segEnd[s] = idx(i, j + 1, k); s++;
    }
    for (let k = 0; k < Nm1; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      this._segStart[s] = idx(i, j, k); this._segEnd[s] = idx(i, j, k + 1); s++;
    }

    // Replace the line BufferGeometry with one sized for the new segment count.
    this._segPositions = new Float32Array(segs * 2 * 3);
    this._segColors    = new Float32Array(segs * 2 * 3);
    const segGeom = new THREE.BufferGeometry();
    segGeom.setAttribute('position', new THREE.BufferAttribute(this._segPositions, 3));
    segGeom.setAttribute('color',    new THREE.BufferAttribute(this._segColors,    3));
    if (this.lines.geometry) this.lines.geometry.dispose();
    this.lines.geometry = segGeom;

    // Flow pulses.
    const pulses = segs * PULSES_PER_SEG;
    this._numPulses = pulses;
    this._pulseT = new Float32Array(pulses);
    for (let i = 0; i < pulses; i++) {
      const phase = (i % PULSES_PER_SEG) / PULSES_PER_SEG;
      const jitter = (Math.random() - 0.5) * (1 / PULSES_PER_SEG);
      let t = phase + jitter;
      if (t < 0) t += 1;
      if (t >= 1) t -= 1;
      this._pulseT[i] = t;
    }
    this._pulsePositions = new Float32Array(pulses * 3);
    this._pulseAlphas    = new Float32Array(pulses);
    const pulseGeom = new THREE.BufferGeometry();
    pulseGeom.setAttribute('position', new THREE.BufferAttribute(this._pulsePositions, 3));
    pulseGeom.setAttribute('alpha',    new THREE.BufferAttribute(this._pulseAlphas,    1));
    if (this.pulsePoints.geometry) this.pulsePoints.geometry.dispose();
    this.pulsePoints.geometry = pulseGeom;

    // Per-vertex scratch.
    this._vertGlow = new Float32Array(verts);
    this._smoothed = new Float32Array(verts * 3);
    this._neighbours = new Int32Array(verts * 6);
    {
      const nbrs = this._neighbours;
      for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const v = idx(i, j, k);
        nbrs[6 * v + 0] = i > 0     ? idx(i - 1, j, k) : -1;
        nbrs[6 * v + 1] = i < N - 1 ? idx(i + 1, j, k) : -1;
        nbrs[6 * v + 2] = j > 0     ? idx(i, j - 1, k) : -1;
        nbrs[6 * v + 3] = j < N - 1 ? idx(i, j + 1, k) : -1;
        nbrs[6 * v + 4] = k > 0     ? idx(i, j, k - 1) : -1;
        nbrs[6 * v + 5] = k < N - 1 ? idx(i, j, k + 1) : -1;
      }
    }
  }

  /**
   * Place the lattice in scene/visual space. (cx, cy, cz) is the cube's
   * centre; halfVisual is its half-extent. The cell count is independent of
   * this -- a bigger cube with the same N just means bigger cells. The user
   * chooses N via setCellCount (UI slider). Physical sampling uses the
   * global SCENE_SCALE_M_PER_UNIT conversion so wells line up with bodies.
   */
  setVisualBounds(cx, cy, cz, halfVisual) {
    const h = Math.max(1.0, halfVisual);
    if (cx === this._cx && cy === this._cy && cz === this._cz && h === this._halfVisual) return;
    this._cx = cx; this._cy = cy; this._cz = cz;
    this._halfVisual = h;
    this._computeRest();
  }

  _computeRest() {
    const cx = this._cx, cy = this._cy, cz = this._cz, h = this._halfVisual;
    const r = this._restNorm;
    const rest = this._rest;
    const cur = this._current;
    for (let v = 0; v < this._verts; v++) {
      const x = cx + r[3 * v + 0] * h;
      const y = cy + r[3 * v + 1] * h;
      const z = cz + r[3 * v + 2] * h;
      rest[3 * v + 0] = x; rest[3 * v + 1] = y; rest[3 * v + 2] = z;
      cur[3 * v + 0]  = x; cur[3 * v + 1]  = y; cur[3 * v + 2]  = z;
    }
    // Re-place the corner handles. Their size stays in a narrow visual range
    // regardless of cube size so they don't shrink to invisibility on a small
    // cube or balloon over the lattice on a big one.
    const handleSize = Math.max(0.4, Math.min(1.4, h * 0.05));
    for (const handle of this._handles) {
      const { signX, signY, signZ } = handle.userData;
      handle.position.set(cx + signX * h, cy + signY * h, cz + signZ * h);
      handle.scale.setScalar(handleSize);
    }
  }

  setVisible(v) { this.mesh.visible = v; }
  setGain(g)    { this.visualGain = g; }

  /** Array of the eight corner-handle meshes (for raycasting). */
  getCornerHandles() { return this._handles; }

  /**
   * Swap the material of one corner handle to the hover style. Pass null
   * to clear the current hover.
   * @param {THREE.Mesh|null} handle
   */
  setHoveredHandle(handle) {
    if (this._hoveredHandle === handle) return;
    if (this._hoveredHandle) this._hoveredHandle.material = this._handleMatIdle;
    this._hoveredHandle = handle;
    if (handle) handle.material = this._handleMatHover;
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
    this._sSx   = new Float64Array(cap);
    this._sSy   = new Float64Array(cap);
    this._sSz   = new Float64Array(cap);
  }

  /**
   * Re-deform the lattice toward the current snapshot's bodies and advance
   * the flow pulses by `wallDtSec` of real time.
   */
  update(wallDtSec, snap, fpp, G) {
    const SCENE = SCENE_SCALE_M_PER_UNIT;
    const inv_c2 = 1.0 / C2;
    const gain = this.visualGain;

    const rest = this._rest;
    const cur  = this._current;
    const verts = this._verts;
    const np = (snap.length / fpp) | 0;

    this._ensureCaches(np);
    const sm = this._smass, sR = this._sR, sx = this._sx, sy = this._sy, sz = this._sz;
    const sSx = this._sSx, sSy = this._sSy, sSz = this._sSz;
    let anySpin = false;
    for (let m = 0, k = 0; m < np; m++, k += fpp) {
      sm[m] = snap[k + 2];
      sR[m] = Math.max(snap[k + 4], 1e-6);
      sx[m] = snap[k + 5];
      sy[m] = snap[k + 6];
      sz[m] = snap[k + 7];
      // Snapshot layout: spin x/y/z live at offsets 11, 12, 13 (see
      // wasm/src/lib.rs refresh_snapshot). These angular-momentum vectors
      // are what produces the gravitomagnetic vector potential A_g, which
      // is the field that frame-drags the lattice tangentially.
      const Sx = snap[k + 11], Sy = snap[k + 12], Sz = snap[k + 13];
      sSx[m] = Sx; sSy[m] = Sy; sSz[m] = Sz;
      if (Sx !== 0 || Sy !== 0 || Sz !== 0) anySpin = true;
    }
    // Gravitomagnetic vector-potential prefactor matching Wikipedia/Mashhoon:
    //   A_g = -G / (2 c^2) * (S x r) / r^3 (per source, summed)
    // This is the *only* term in the GEM potential structure that produces a
    // tangential ("swirl") component of the field around a body, so it is
    // exactly what makes frame dragging visible in the lattice. If no body
    // has spin we skip the entire A_g loop for the per-vertex hot path.
    const K_AG = -G / (2 * C2);

    const vertGlow = this._vertGlow;
    // Soft cap (asymptotic): displacement = CAP * tanh(rawDisp / CAP).
    // Smoothly saturates as rawDisp grows large, instead of clamping all
    // near-body vertices to the same value (which produces the cone-spike).
    const CAP = this._halfVisual * 0.42;
    const inv_S = 1.0 / SCENE;
    // Tiny gap (visual units) between the deformed lattice vertex and the
    // body surface so the vertex sits *just* outside the visible sphere
    // instead of being clipped exactly to it.
    const SURFACE_GAP = 0.03;

    // Tangential swirl cap & scale.
    //
    // The swirl is allowed to grow to AT MOST ~0.35 of the radial cap.
    // That keeps it a clearly-subordinate twist on top of the gravity
    // bowl, instead of a competing deformation -- important once you have
    // two or more spinning bodies whose A_g fields add vectorially.
    //
    // SWIRL_SCALE = 1e7 was chosen as a balance: motor-slow
    // (S ~ 3e32) still produces a visible ~0.3-unit twist a few visual
    // units from the body, while motor-fast and the Kerr-like preset
    // saturate cleanly at SWIRL_CAP. Earlier values (1e8) made every
    // spinning body's swirl saturate everywhere, which destroyed the
    // gravity bowl shape when more than one spinning body was present.
    const SWIRL_CAP = CAP * 0.35;
    const SWIRL_SCALE = 1.0e7;

    // === 1. Deform every lattice vertex ===
    //
    // Each body contributes its OWN log-scaled bowl. We do not sum the bare
    // potentials and then take a single log of the sum -- that loses every
    // less-massive body in the noise of the dominant one. (Example: a
    // solar-mass body has |Phi| ~ 1e6x the |Phi| of an Earth-mass body at
    // any comparable distance, so the summed potential is essentially the
    // solar value, and the Earth's well disappears from the visual.)
    //
    // Instead we compute body-local Phi_i, log-compress it to a per-body
    // displacement magnitude, multiply by the unit gradient direction of
    // that body alone, and sum the resulting *vectors*. The final
    // displacement is the summed vector, then tanh-saturated as a whole.
    // Each body's bowl is then visible, superposed cleanly on the others.
    for (let v = 0; v < verts; v++) {
      const restX = rest[3 * v + 0];
      const restY = rest[3 * v + 1];
      const restZ = rest[3 * v + 2];

      const px = restX * SCENE;
      const py = restY * SCENE;
      const pz = restZ * SCENE;

      // Gravitomagnetic vector potential A_g at this vertex, summed over
      // all spinning sources. Kept in SI (m/s) for now; we log-scale it
      // below before converting to a visual displacement.
      let agx = 0, agy = 0, agz = 0;
      // Per-body log-scaled radial displacement, accumulated as a vector.
      let dispX = 0, dispY = 0, dispZ = 0;
      // Max per-body raw displacement, used to drive the "glow" colour
      // so a vertex sitting near any well brightens (not just near the
      // dominant body).
      let maxBodyRaw = 0;

      for (let m = 0; m < np; m++) {
        const mass = sm[m];
        const R = sR[m];
        const dx = px - sx[m];
        const dy = py - sy[m];
        const dz = pz - sz[m];
        const r2 = dx * dx + dy * dy + dz * dz;
        const r = Math.sqrt(r2);
        const gm = G * mass;
        let gxi, gyi, gzi, phi_i;
        if (r >= R) {
          const inv_r3 = 1.0 / (r2 * r);
          gxi = -gm * dx * inv_r3;
          gyi = -gm * dy * inv_r3;
          gzi = -gm * dz * inv_r3;
          phi_i = -gm / r;
        } else {
          const inv_R3 = 1.0 / (R * R * R);
          gxi = -gm * dx * inv_R3;
          gyi = -gm * dy * inv_R3;
          gzi = -gm * dz * inv_R3;
          phi_i = -(gm / (2 * R)) * (3 - r2 / (R * R));
        }

        const magI = Math.abs(phi_i) * inv_c2;
        const rawI = Math.log10(1 + magI * 1e12) * gain;
        if (rawI > maxBodyRaw) maxBodyRaw = rawI;

        const fmI = Math.sqrt(gxi * gxi + gyi * gyi + gzi * gzi);
        if (fmI > 1e-30 && rawI > 0) {
          const inv_fm = 1.0 / fmI;
          dispX += gxi * inv_fm * rawI;
          dispY += gyi * inv_fm * rawI;
          dispZ += gzi * inv_fm * rawI;
        }

        // A_g contribution from this body. Wikipedia GEM:
        //   A_g(r) = -G / (2 c^2) * (S x r_vec) / |r_vec|^3
        // where r_vec is the vector FROM the body TO the probe and S is
        // the body's spin angular momentum. Inside the body we use the
        // surface value (R^3 in the denominator) so the swirl stays
        // bounded as the vertex passes through the body's bulk.
        if (anySpin) {
          const Sxm = sSx[m], Sym = sSy[m], Szm = sSz[m];
          if (Sxm !== 0 || Sym !== 0 || Szm !== 0) {
            const inv_den = (r >= R) ? (1.0 / (r2 * r)) : (1.0 / (R * R * R));
            const cx = Sym * dz - Szm * dy;
            const cy = Szm * dx - Sxm * dz;
            const cz = Sxm * dy - Sym * dx;
            agx += K_AG * cx * inv_den;
            agy += K_AG * cy * inv_den;
            agz += K_AG * cz * inv_den;
          }
        }
      }

      vertGlow[v] = Math.min(1.0, maxBodyRaw * 0.35);

      // Soft-cap the SUMMED per-body displacement. When two bodies pull
      // a vertex in opposite directions the components partially cancel
      // first; when they pull in the same direction the sum grows and
      // tanh keeps the total bounded.
      const dispMag = Math.sqrt(dispX * dispX + dispY * dispY + dispZ * dispZ);
      if (dispMag > 1e-30) {
        const capped = CAP * Math.tanh(dispMag / CAP);
        const k = capped / dispMag;
        dispX *= k; dispY *= k; dispZ *= k;
      }

      if (anySpin) {
        const agMag = Math.sqrt(agx * agx + agy * agy + agz * agz);
        if (agMag > 1e-30) {
          const rawSwirl = Math.log10(1 + agMag * SWIRL_SCALE) * gain;
          const dSwirl = SWIRL_CAP * Math.tanh(rawSwirl / SWIRL_CAP);
          if (dSwirl > 0) {
            const inv_ag = 1.0 / agMag;
            dispX += agx * inv_ag * dSwirl;
            dispY += agy * inv_ag * dSwirl;
            dispZ += agz * inv_ag * dSwirl;
          }
        }
      }

      let outX = restX + dispX;
      let outY = restY + dispY;
      let outZ = restZ + dispZ;

      // Body-surface clamp: if the proposed final position lies inside
      // ANY body's visual sphere (radial pull, swirl, or both combined
      // tunneled the vertex through it), project it back out to that
      // sphere's surface plus a small visual gap. This handles arbitrary
      // displacement directions (including the swirl), unlike the
      // previous ray-vs-sphere "entry-distance" clip which only worked
      // for the radial leg.
      for (let m = 0; m < np; m++) {
        const bx = sx[m] * inv_S;
        const by = sy[m] * inv_S;
        const bz = sz[m] * inv_S;
        const dxC = outX - bx;
        const dyC = outY - by;
        const dzC = outZ - bz;
        const distSq = dxC * dxC + dyC * dyC + dzC * dzC;
        const Rv = sR[m] * inv_S + SURFACE_GAP;
        if (distSq < Rv * Rv) {
          if (distSq > 1e-12) {
            const dist = Math.sqrt(distSq);
            const factor = Rv / dist;
            outX = bx + dxC * factor;
            outY = by + dyC * factor;
            outZ = bz + dzC * factor;
          } else {
            // Vertex landed exactly at the body's centre. Push it back
            // out along the rest-position direction (a stable fall-back
            // that never reads NaN).
            const dxR = restX - bx, dyR = restY - by, dzR = restZ - bz;
            const distR = Math.sqrt(dxR * dxR + dyR * dyR + dzR * dzR);
            if (distR > 1e-9) {
              const f = Rv / distR;
              outX = bx + dxR * f;
              outY = by + dyR * f;
              outZ = bz + dzR * f;
            } else {
              outX = restX; outY = restY; outZ = restZ;
            }
          }
        }
      }

      cur[3 * v + 0] = outX;
      cur[3 * v + 1] = outY;
      cur[3 * v + 2] = outZ;
    }

    // === 1b. Two passes of Laplacian smoothing on the deformed positions.
    // Each pass blends each vertex 50/50 with the average of its axial
    // neighbours, which softens any remaining sharp spikes (e.g. where the
    // log dispMag of near-body vertices all hit the cap together). We
    // weight the original toward the rest position for boundary vertices
    // so the lattice's outer cube edges stay roughly straight.
    const sm2 = this._smoothed;
    const nbrs = this._neighbours;
    for (let pass = 0; pass < 2; pass++) {
      for (let v = 0; v < verts; v++) {
        let sx2 = cur[3 * v + 0];
        let sy2 = cur[3 * v + 1];
        let sz2 = cur[3 * v + 2];
        let count = 1;
        for (let n = 0; n < 6; n++) {
          const ni = nbrs[6 * v + n];
          if (ni < 0) continue;
          sx2 += cur[3 * ni + 0];
          sy2 += cur[3 * ni + 1];
          sz2 += cur[3 * ni + 2];
          count++;
        }
        const inv = 1 / count;
        const ax = sx2 * inv, ay = sy2 * inv, az = sz2 * inv;
        // Blend 60% averaged + 40% original to keep some sharpness.
        sm2[3 * v + 0] = 0.6 * ax + 0.4 * cur[3 * v + 0];
        sm2[3 * v + 1] = 0.6 * ay + 0.4 * cur[3 * v + 1];
        sm2[3 * v + 2] = 0.6 * az + 0.4 * cur[3 * v + 2];
      }
      // swap cur <- sm2 (copy back; arrays are length-equal so we just memcpy)
      cur.set(sm2);
    }

    // === 2. Pack line-segment positions & colours ===
    const segs = this._segs;
    const segStart = this._segStart;
    const segEnd   = this._segEnd;
    const segPos   = this._segPositions;
    const segCols  = this._segColors;

    for (let s = 0; s < segs; s++) {
      const a = segStart[s], b = segEnd[s];
      const ai = a * 3, bi = b * 3;
      const k = s * 6;
      segPos[k + 0] = cur[ai + 0]; segPos[k + 1] = cur[ai + 1]; segPos[k + 2] = cur[ai + 2];
      segPos[k + 3] = cur[bi + 0]; segPos[k + 4] = cur[bi + 1]; segPos[k + 5] = cur[bi + 2];

      const ga = vertGlow[a], gb = vertGlow[b];
      segCols[k + 0] = COOL_R + (HOT_R - COOL_R) * ga;
      segCols[k + 1] = COOL_G + (HOT_G - COOL_G) * ga;
      segCols[k + 2] = COOL_B + (HOT_B - COOL_B) * ga;
      segCols[k + 3] = COOL_R + (HOT_R - COOL_R) * gb;
      segCols[k + 4] = COOL_G + (HOT_G - COOL_G) * gb;
      segCols[k + 5] = COOL_B + (HOT_B - COOL_B) * gb;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;

    // === 3. Advance pulses along each segment ===
    const pulseT      = this._pulseT;
    const pulsePos    = this._pulsePositions;
    const pulseAlpha  = this._pulseAlphas;
    const ppe = PULSES_PER_SEG;

    for (let s = 0; s < segs; s++) {
      const a = segStart[s], b = segEnd[s];
      const ai = a * 3, bi = b * 3;
      const ax = cur[ai + 0], ay = cur[ai + 1], az = cur[ai + 2];
      const bx = cur[bi + 0], by = cur[bi + 1], bz = cur[bi + 2];

      let lx = bx - ax, ly = by - ay, lz = bz - az;
      const llen2 = lx * lx + ly * ly + lz * lz;
      if (llen2 < 1e-24) continue;
      const inv_l = 1.0 / Math.sqrt(llen2);
      lx *= inv_l; ly *= inv_l; lz *= inv_l;

      const mvx = (ax + bx) * 0.5;
      const mvy = (ay + by) * 0.5;
      const mvz = (az + bz) * 0.5;
      const mpx = mvx * SCENE;
      const mpy = mvy * SCENE;
      const mpz = mvz * SCENE;

      // Pulse flow: same per-body decomposition as the vertex-displacement
      // loop. We accumulate a body-weighted "flow vector" whose magnitude
      // along each body's local Phi-log is added independently. That way a
      // segment near the Earth-mass body still flows toward Earth even
      // when a much heavier solar body is also in the scene -- which would
      // otherwise drown out Earth's gradient in a single summed Phi.
      let flowAcc = 0;          // signed flow along the segment direction l
      let escSpeedMax = 0;      // max single-body escape speed at midpoint
      // Gravitomagnetic vector potential A_g at the segment midpoint.
      // Adding its projection onto the segment direction makes pulses
      // SPIRAL around spinning bodies rather than only flowing radially
      // in -- the visual signature of frame dragging.
      let agx = 0, agy = 0, agz = 0;
      for (let m = 0; m < np; m++) {
        const mass = sm[m];
        const R = sR[m];
        const dx = mpx - sx[m];
        const dy = mpy - sy[m];
        const dz = mpz - sz[m];
        const r2 = dx * dx + dy * dy + dz * dz;
        const r = Math.sqrt(r2);
        const gm = G * mass;
        let gxi, gyi, gzi, phi_i;
        if (r >= R) {
          const inv_r3 = 1.0 / (r2 * r);
          gxi = -gm * dx * inv_r3;
          gyi = -gm * dy * inv_r3;
          gzi = -gm * dz * inv_r3;
          phi_i = -gm / r;
        } else {
          const inv_R3 = 1.0 / (R * R * R);
          gxi = -gm * dx * inv_R3;
          gyi = -gm * dy * inv_R3;
          gzi = -gm * dz * inv_R3;
          phi_i = -(gm / (2 * R)) * (3 - r2 / (R * R));
        }

        const fmI = Math.sqrt(gxi * gxi + gyi * gyi + gzi * gzi);
        if (fmI > 1e-30) {
          const dotI = (gxi * lx + gyi * ly + gzi * lz) / fmI;
          const escI = Math.sqrt(2 * Math.abs(phi_i));
          if (escI > escSpeedMax) escSpeedMax = escI;
          const speedI = 0.18 + 0.55 * Math.log10(1 + escI * 1e-4);
          flowAcc += dotI * speedI;
        }

        if (anySpin) {
          const Sxm = sSx[m], Sym = sSy[m], Szm = sSz[m];
          if (Sxm !== 0 || Sym !== 0 || Szm !== 0) {
            const inv_den = (r >= R) ? (1.0 / (r2 * r)) : (1.0 / (R * R * R));
            const cx = Sym * dz - Szm * dy;
            const cy = Szm * dx - Sxm * dz;
            const cz = Sxm * dy - Sym * dx;
            agx += K_AG * cx * inv_den;
            agy += K_AG * cy * inv_den;
            agz += K_AG * cz * inv_den;
          }
        }
      }

      let flowRate = flowAcc;
      let brightness = 0.06;
      if (escSpeedMax > 0) {
        const escFactor = Math.log10(1 + escSpeedMax * 1e-4);
        // Pulse brightness scales with the strongest single-body well
        // *and* with how well the segment aligns with that flow.
        const align = Math.min(1.0, Math.abs(flowAcc));
        brightness = Math.min(0.95,
          0.05 + 0.95 * align * Math.min(1.0, 0.4 + 0.6 * escFactor)
        );
      }
      // Tangential (frame-dragging) contribution to the pulse flow.
      // A_g is orthogonal to the radial direction by construction, so this
      // adds a true swirl component independent of the radial inflow.
      if (anySpin) {
        const agMag = Math.sqrt(agx * agx + agy * agy + agz * agz);
        if (agMag > 1e-30) {
          const dotA = (agx * lx + agy * ly + agz * lz) / agMag;
          const swirlSpeed = 0.22 * Math.log10(1 + agMag * SWIRL_SCALE);
          flowRate += dotA * swirlSpeed;
          // Brighten pulses on segments well aligned with the swirl so
          // the frame-dragging stream is actually visible against the
          // radial-infall stream.
          brightness = Math.min(0.95, Math.max(brightness,
            0.08 + 0.85 * Math.abs(dotA) * Math.min(1.0, 0.3 + 0.7 * swirlSpeed)
          ));
        }
      }

      for (let p = 0; p < ppe; p++) {
        const pi = s * ppe + p;
        let t = pulseT[pi] + flowRate * wallDtSec;
        t -= Math.floor(t);
        pulseT[pi] = t;
        pulsePos[3 * pi + 0] = ax + (bx - ax) * t;
        pulsePos[3 * pi + 1] = ay + (by - ay) * t;
        pulsePos[3 * pi + 2] = az + (bz - az) * t;
        pulseAlpha[pi] = brightness;
      }
    }
    this.pulsePoints.geometry.attributes.position.needsUpdate = true;
    this.pulsePoints.geometry.attributes.alpha.needsUpdate = true;
  }
}
