// Thin wrapper around the wasm-bindgen-generated module.
//
// The WASM linear memory is shared via wasm.memory.buffer. Every typed-array
// "view" we return is a window into that buffer with no copy. Whenever WASM
// grows its heap (which it can on potentials_for() or spawn()), every existing
// view becomes invalid; we re-mint views on every frame to be safe.

import init, {
  World,
  c_light,
  g_grav,
  eps0,
  mu0,
  weak_field_limit,
  beta_cap,
} from '../wasm/pkg/spacetime_sandbox.js';

const SPAWN_ERRORS = {
  1: 'mass must be > 0',
  2: 'radius must be > 0',
  3: 'velocity must be < c',
  4: 'weak-field guard: G m / (r c^2) >= 0.05 (would form a black hole)',
  5: 'non-finite input',
};

export class PhysicsBridge {
  /** @type {World|null} */ world = null;
  /** @type {WebAssembly.Memory|null} */ memory = null;
  /** @type {number} */ floatsPerParticle = 16;
  /** @type {{C:number,G:number,EPS0:number,MU0:number,WEAK_LIMIT:number,BETA_CAP:number}|null} */
  constants = null;

  // Scratch buffers in WASM memory used for grid potential queries.
  _gridPointsAddr = 0;
  _gridPointsLen = 0;

  async init() {
    const wasm = await init();
    this.memory = wasm.memory;
    this.world = World.new_default();
    this.floatsPerParticle = this.world.floats_per_particle();
    this.constants = {
      C: c_light(),
      G: g_grav(),
      EPS0: eps0(),
      MU0: mu0(),
      WEAK_LIMIT: weak_field_limit(),
      BETA_CAP: beta_cap(),
    };
  }

  /**
   * @param {object} spec
   * @returns {{id:number, ok:boolean, error?:string}}
   */
  spawn(spec) {
    const {
      mass = 1,
      charge = 0,
      radius = 1,
      r = [0, 0, 0],
      v = [0, 0, 0],
      spin = [0, 0, 0],
      allow_merger = false,
    } = spec;
    const id = this.world.spawn(
      mass,
      charge,
      radius,
      r[0], r[1], r[2],
      v[0], v[1], v[2],
      spin[0], spin[1], spin[2],
      !!allow_merger,
    );
    if (id === 0) {
      const code = this.world.last_error();
      return { id: 0, ok: false, error: SPAWN_ERRORS[code] || `code ${code}` };
    }
    return { id, ok: true };
  }

  remove(id) { return this.world.remove(id); }
  clear() { this.world.clear(); }

  /**
   * Teleport a particle to a new (r, v). Resets its history buffer so other
   * particles' retarded-field evaluations stop seeing the old position trail.
   * @returns {boolean} true on success
   */
  teleport(id, r, v = [0, 0, 0]) {
    return this.world.teleport(id, r[0], r[1], r[2], v[0], v[1], v[2]);
  }

  /**
   * Advance physics time by `dtSeconds`, in adaptive substeps no larger than
   * `dtMax`.
   */
  advance(dtSeconds, dtMax) {
    this.world.advance(dtSeconds, dtMax);
  }

  /** Refresh the snapshot buffer and return a Float64Array view of it. */
  snapshotView() {
    const len = this.world.refresh_snapshot();
    const ptr = this.world.snapshot_ptr();
    return new Float64Array(this.memory.buffer, ptr, len);
  }

  /**
   * Sample retarded E, B, E_g, B_g at a probe point. Returns a 12-element
   * Float64Array [e.xyz, b.xyz, eg.xyz, bg.xyz].
   */
  sampleFields(x, y, z) {
    const ptr = this.world.sample_fields(x, y, z);
    return new Float64Array(this.memory.buffer, ptr, 12);
  }

  /**
   * Compute the Newtonian potential Phi at each of `nPoints` 3D positions.
   * `pointsXYZ` must be a Float64Array of length 3 * nPoints. Returns a
   * Float64Array of length nPoints (one Phi per point).
   *
   * Implementation note (see ARCHITECTURE.md "Why a separate JS-side
   * potential sampler"): the WASM crate already has an authoritative
   * `newtonian_potential_at(x, y, z)` that we *could* call once per point,
   * but a single WASM round-trip per grid vertex (typically tens of
   * thousands per frame) is much more expensive than computing the same
   * closed-form in JS using a snapshot of the particle state. So we
   * duplicate the formula here and pin it against the Rust version with the
   * `newtonian_potential_sum` test in `wasm/src/tests.rs`. If you change
   * the formula in either place, you MUST change it in both.
   */
  newtonianPotentials(pointsXYZ, nPoints) {
    const out = new Float64Array(nPoints);
    for (let i = 0; i < nPoints; i++) {
      out[i] = this._potentialJS(
        pointsXYZ[3 * i],
        pointsXYZ[3 * i + 1],
        pointsXYZ[3 * i + 2],
      );
    }
    return out;
  }

  _cachedSnapshotForPhi = null;

  /**
   * JS-side Newtonian potential sampler, used per-grid-vertex.
   *
   * Uses the uniform-sphere closed-form so the field is continuous at the
   * body surface and varies smoothly inside:
   *
   *   r >= R:  Phi(r) = -G M / r
   *   r <  R:  Phi(r) = -G M / (2 R) * (3 - r^2 / R^2)
   *
   * which matches Rust's `physics::newtonian_potential_at`. Pinned by
   * `tests::newtonian_potential_sum`.
   */
  _potentialJS(x, y, z) {
    const snap = this._cachedSnapshotForPhi;
    if (!snap) return 0;
    const stride = this.floatsPerParticle;
    const G = this.constants.G;
    let phi = 0;
    for (let k = 0; k < snap.length; k += stride) {
      const mass = snap[k + 2];
      const R = Math.max(snap[k + 4], 1.0e-6);
      const dx = x - snap[k + 5];
      const dy = y - snap[k + 6];
      const dz = z - snap[k + 7];
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const gm = G * mass;
      if (r >= R) {
        phi -= gm / r;
      } else {
        phi -= gm / (2 * R) * (3 - (r * r) / (R * R));
      }
    }
    return phi;
  }

  /** Tell the bridge which snapshot to use when computing potentials. */
  setSnapshotForPotentials(snap) {
    this._cachedSnapshotForPhi = snap;
  }

  // ---- diagnostic getters that mirror Rust ----
  get t() { return this.world.t(); }
  get aliveCount() { return this.world.alive_count(); }
  get totalEnergy() { return this.world.total_energy(); }
  totalMomentum() {
    return [
      this.world.total_momentum_x(),
      this.world.total_momentum_y(),
      this.world.total_momentum_z(),
    ];
  }
  get maxGamma() { return this.world.max_gamma(); }
  get maxBg() { return this.world.max_bg(); }
  get lastStepCount() { return this.world.last_step_count(); }
  get mergersTotal() { return this.world.mergers_total(); }
  get bouncesTotal() { return this.world.bounces_total(); }
}
