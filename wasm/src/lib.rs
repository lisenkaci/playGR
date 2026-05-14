// wasm-bindgen surface for the JavaScript side.
//
// The high-level entry point is `World`. JS:
//
//   1.  const w = World.new_default()
//   2.  w.spawn(mass, charge, radius, rx,ry,rz, vx,vy,vz, sx,sy,sz, allow_merger)
//   3.  w.advance(dt_seconds, dt_max)
//   4.  const len = w.refresh_snapshot()
//       const ptr = w.snapshot_ptr()
//       const view = new Float64Array(memory.buffer, ptr, len)
//   5.  diagnostics: w.total_energy(), w.max_gamma(), ...
//
// All math is f64. Float64Array on the JS side gives lossless round-trip.

use wasm_bindgen::prelude::*;

mod constants;
mod vec3;
mod ring_buffer;
mod particle;
mod physics;
mod integrator;
mod collisions;
mod world;

#[cfg(test)]
mod tests;

use vec3::Vec3;
use world::{SpawnError, SpawnSpec};

pub const FLOATS_PER_PARTICLE: usize = 16;
// Layout per particle in the snapshot buffer:
//   0:  id (as f64)
//   1:  alive (1.0 / 0.0)
//   2:  mass
//   3:  charge
//   4:  radius
//   5..8:   position (rx, ry, rz)
//   8..11:  velocity (vx, vy, vz)
//   11..14: spin (sx, sy, sz)
//   14: gamma
//   15: total energy

#[wasm_bindgen]
pub struct World {
    inner: world::World,
    snapshot: Vec<f64>,
    potential_in: Vec<f64>,
    potential_out: Vec<f64>,
    field_out: Vec<f64>,
    last_error_code: u32,
}

#[wasm_bindgen]
impl World {
    /// Default sandbox: history 1024 deep, recommended substep upper bound 1 ms.
    pub fn new_default() -> World {
        Self::new_custom(1024, 1.0e-3)
    }

    /// Construct with explicit history capacity and an upper bound on substep size.
    pub fn new_custom(history_capacity: usize, default_dt: f64) -> World {
        World {
            inner: world::World::new(history_capacity.max(2), default_dt.max(1.0e-15)),
            snapshot: Vec::new(),
            potential_in: Vec::new(),
            potential_out: Vec::new(),
            field_out: vec![0.0; 12],
            last_error_code: 0,
        }
    }

    pub fn clear(&mut self) {
        self.inner.clear();
        self.snapshot.clear();
        self.last_error_code = 0;
    }

    /// Spawn one particle. Returns the assigned id on success, or 0 on
    /// rejection (in which case `last_error()` is set: 1=non-positive mass,
    /// 2=non-positive radius, 3=v >= c, 4=weak-field guard, 5=NaN/inf input).
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &mut self,
        mass: f64,
        charge: f64,
        radius: f64,
        rx: f64, ry: f64, rz: f64,
        vx: f64, vy: f64, vz: f64,
        sx: f64, sy: f64, sz: f64,
        allow_merger: bool,
    ) -> u32 {
        let spec = SpawnSpec {
            mass, charge, radius,
            r: Vec3::new(rx, ry, rz),
            v: Vec3::new(vx, vy, vz),
            spin: Vec3::new(sx, sy, sz),
            allow_merger,
        };
        match self.inner.spawn(spec) {
            Ok(id) => { self.last_error_code = 0; id }
            Err(err) => {
                self.last_error_code = match err {
                    SpawnError::NonPositiveMass => 1,
                    SpawnError::NonPositiveRadius => 2,
                    SpawnError::SuperluminalVelocity => 3,
                    SpawnError::WeakFieldExceeded => 4,
                    SpawnError::NonFiniteInput => 5,
                };
                0
            }
        }
    }

    pub fn remove(&mut self, id: u32) -> bool { self.inner.remove(id) }

    /// Teleport particle `id` to absolute position (rx, ry, rz) with new
    /// velocity (vx, vy, vz). Used by the JS-side drag-and-drop handler. The
    /// particle's history ring buffer is reset so retarded fields stop seeing
    /// the pre-teleport position. Returns false if no live particle with that
    /// id exists.
    #[allow(clippy::too_many_arguments)]
    pub fn teleport(
        &mut self,
        id: u32,
        rx: f64, ry: f64, rz: f64,
        vx: f64, vy: f64, vz: f64,
    ) -> bool {
        self.inner.teleport(
            id,
            Vec3::new(rx, ry, rz),
            Vec3::new(vx, vy, vz),
        )
    }

    /// Advance the physics by `dt_seconds` of simulation time, in adaptive
    /// substeps no larger than `dt_max`.
    pub fn advance(&mut self, dt_seconds: f64, dt_max: f64) {
        let cap = dt_max.max(1.0e-15);
        self.inner.advance(dt_seconds, cap);
    }

    // ---- diagnostic getters ----

    pub fn t(&self) -> f64 { self.inner.t }
    pub fn alive_count(&self) -> usize { self.inner.alive_count() }
    pub fn total_energy(&self) -> f64 { self.inner.total_energy() }
    pub fn total_momentum_x(&self) -> f64 { self.inner.total_momentum().x }
    pub fn total_momentum_y(&self) -> f64 { self.inner.total_momentum().y }
    pub fn total_momentum_z(&self) -> f64 { self.inner.total_momentum().z }
    pub fn max_gamma(&self) -> f64 { self.inner.max_gamma() }
    pub fn max_bg(&self) -> f64 { self.inner.max_bg() }
    pub fn last_step_count(&self) -> u32 { self.inner.last_step_count }
    pub fn mergers_total(&self) -> u32 { self.inner.mergers_total }
    pub fn bounces_total(&self) -> u32 { self.inner.bounces_total }
    pub fn last_error(&self) -> u32 { self.last_error_code }

    // ---- snapshot ----

    pub fn floats_per_particle(&self) -> usize { FLOATS_PER_PARTICLE }

    /// Refresh the snapshot buffer with the latest state. Returns the *number
    /// of floats* now valid in the buffer (= alive_count * FLOATS_PER_PARTICLE).
    pub fn refresh_snapshot(&mut self) -> usize {
        let alive = self.inner.alive_count();
        let needed = alive * FLOATS_PER_PARTICLE;
        if self.snapshot.len() < needed { self.snapshot.resize(needed, 0.0); }

        let mut k = 0usize;
        for p in self.inner.particles.iter().filter(|p| p.alive) {
            let v = p.velocity();
            self.snapshot[k     ] = p.id as f64;
            self.snapshot[k +  1] = 1.0;
            self.snapshot[k +  2] = p.mass;
            self.snapshot[k +  3] = p.charge;
            self.snapshot[k +  4] = p.radius;
            self.snapshot[k +  5] = p.r.x;
            self.snapshot[k +  6] = p.r.y;
            self.snapshot[k +  7] = p.r.z;
            self.snapshot[k +  8] = v.x;
            self.snapshot[k +  9] = v.y;
            self.snapshot[k + 10] = v.z;
            self.snapshot[k + 11] = p.spin.x;
            self.snapshot[k + 12] = p.spin.y;
            self.snapshot[k + 13] = p.spin.z;
            self.snapshot[k + 14] = p.gamma();
            self.snapshot[k + 15] = p.energy();
            k += FLOATS_PER_PARTICLE;
        }
        needed
    }

    pub fn snapshot_ptr(&self) -> *const f64 { self.snapshot.as_ptr() }

    // ---- spacetime grid potential ----

    /// Compute the Newtonian potential Phi = -sum G m_i / r_i at each probe
    /// point. `points_ptr` is a pointer to 3 * n_points consecutive f64 values
    /// (x0,y0,z0, x1,y1,z1, ...). Returns a pointer to an internal output
    /// buffer containing one f64 per point.
    pub fn potentials_for(&mut self, points_ptr: *const f64, n_points: usize) -> *const f64 {
        if self.potential_in.len() < n_points * 3 {
            self.potential_in.resize(n_points * 3, 0.0);
        }
        if self.potential_out.len() < n_points {
            self.potential_out.resize(n_points, 0.0);
        }
        // SAFETY: JS hands us a pointer to a Float64Array of length 3 * n_points
        // residing in the same wasm linear memory. We copy immediately and
        // never retain the raw pointer afterwards.
        unsafe {
            std::ptr::copy_nonoverlapping(points_ptr, self.potential_in.as_mut_ptr(), n_points * 3);
        }
        for i in 0..n_points {
            let r = Vec3::new(
                self.potential_in[3 * i],
                self.potential_in[3 * i + 1],
                self.potential_in[3 * i + 2],
            );
            self.potential_out[i] = self.inner.newtonian_potential(r);
        }
        self.potential_out.as_ptr()
    }

    // ---- field probe ----

    /// Sample retarded E, B, E_g, B_g at probe point (rx, ry, rz). Returns a
    /// pointer to 12 f64s: [e.xyz, b.xyz, eg.xyz, bg.xyz].
    pub fn sample_fields(&mut self, rx: f64, ry: f64, rz: f64) -> *const f64 {
        let probe = Vec3::new(rx, ry, rz);
        let mut e = Vec3::ZERO; let mut b = Vec3::ZERO;
        let mut eg = Vec3::ZERO; let mut bg = Vec3::ZERO;
        for src in self.inner.particles.iter().filter(|p| p.alive) {
            if let Some(s) = physics::find_retarded_state(probe, self.inner.t, &src.history) {
                let f = physics::fields_from_source(probe, &s, src.mass, src.charge, src.spin);
                e += f.e; b += f.b; eg += f.eg; bg += f.bg;
            }
        }
        self.field_out[0] = e.x;  self.field_out[1] = e.y;  self.field_out[2]  = e.z;
        self.field_out[3] = b.x;  self.field_out[4] = b.y;  self.field_out[5]  = b.z;
        self.field_out[6] = eg.x; self.field_out[7] = eg.y; self.field_out[8]  = eg.z;
        self.field_out[9] = bg.x; self.field_out[10] = bg.y; self.field_out[11] = bg.z;
        self.field_out.as_ptr()
    }
}

// ---- physical-constant getters (so JS can display real SI values) ----

#[wasm_bindgen] pub fn c_light() -> f64 { constants::C }
#[wasm_bindgen] pub fn g_grav() -> f64  { constants::G }
#[wasm_bindgen] pub fn eps0()   -> f64  { constants::EPS0 }
#[wasm_bindgen] pub fn mu0()    -> f64  { constants::MU0 }
#[wasm_bindgen] pub fn weak_field_limit() -> f64 { constants::WEAK_FIELD_LIMIT }
#[wasm_bindgen] pub fn beta_cap() -> f64 { constants::BETA_CAP }
