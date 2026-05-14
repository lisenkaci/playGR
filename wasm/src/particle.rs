use crate::constants::{BETA_CAP_2, C2, C4};
use crate::ring_buffer::RingBuffer;
use crate::vec3::Vec3;

// Time-stamped historical snapshot of a particle, stored in the ring buffer for
// retarded-potential lookups. Mass / charge / spin can change in principle
// (e.g. on merger) but the lookup only ever queries r, v, a at past times -
// the source's *current* m, q, S are read from the Particle directly.
#[derive(Copy, Clone, Debug, Default)]
pub struct State {
    pub t: f64,
    pub r: Vec3, // position
    pub v: Vec3, // velocity (not momentum!)
    pub a: Vec3, // acceleration of v
}

impl State {
    pub fn lerp(a: &State, b: &State, alpha: f64) -> State {
        State {
            t: a.t + (b.t - a.t) * alpha,
            r: Vec3::lerp(a.r, b.r, alpha),
            v: Vec3::lerp(a.v, b.v, alpha),
            a: Vec3::lerp(a.a, b.a, alpha),
        }
    }
}

// One simulated body.
#[derive(Debug)]
pub struct Particle {
    pub id: u32,

    // Invariant ("rest") quantities
    pub mass: f64,   // kg, rest mass
    pub charge: f64, // C
    pub radius: f64, // m, hard-sphere collision radius

    // Spin: the rigid-body angular momentum vector S = I omega (SI units kg m^2 / s).
    // Treated as a constant magnetic/gravitomagnetic dipole moment in the field
    // calculation; collisions can transfer this momentum.
    pub spin: Vec3,

    // Live kinematic state. Position is updated by the Verlet drift; we store
    // momentum (not velocity) so we never have to compute 1/sqrt(1 - v^2/c^2),
    // which is the term that explodes near c. Velocity is recovered on demand.
    pub r: Vec3,
    pub p: Vec3,      // relativistic momentum gamma * m * v
    pub a_prev: Vec3, // acceleration from the previous substep (for Verlet)

    // Last-good kinematic state, used by the NaN sentinel to roll back a
    // particle that ended a substep with non-finite values.
    pub r_safe: Vec3,
    pub p_safe: Vec3,

    pub allow_merger: bool,
    pub alive: bool,

    pub history: RingBuffer,
}

impl Particle {
    // Particle construction takes every physical parameter explicitly so
    // callers can never accidentally default a value -- mass, charge,
    // radius, position, velocity, and spin are all required at construction
    // time. Wrapping these in a builder struct would add an indirection
    // for no real safety win, so we suppress the lint.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: u32,
        mass: f64,
        charge: f64,
        radius: f64,
        r: Vec3,
        v: Vec3,
        spin: Vec3,
        allow_merger: bool,
        history_capacity: usize,
        t_now: f64,
    ) -> Self {
        let p = momentum_from_velocity(v, mass);
        let mut history = RingBuffer::new(history_capacity);
        history.push(State {
            t: t_now,
            r,
            v,
            a: Vec3::ZERO,
        });
        Particle {
            id,
            mass,
            charge,
            radius,
            spin,
            r,
            p,
            a_prev: Vec3::ZERO,
            r_safe: r,
            p_safe: p,
            allow_merger,
            alive: true,
            history,
        }
    }

    #[inline]
    pub fn velocity(&self) -> Vec3 {
        velocity_from_momentum(self.p, self.mass)
    }

    #[inline]
    pub fn gamma(&self) -> f64 {
        gamma_from_momentum(self.p, self.mass)
    }

    #[allow(dead_code)]
    #[inline]
    pub fn beta(&self) -> Vec3 {
        self.velocity() * (1.0 / crate::constants::C)
    }

    /// Total relativistic energy, E^2 = (p c)^2 + (m c^2)^2.
    #[inline]
    pub fn energy(&self) -> f64 {
        let pc2 = self.p.norm_sq() * C2;
        let mc2 = self.mass * C2;
        (pc2 + mc2 * mc2).sqrt()
    }

    pub fn push_history(&mut self, t: f64, a: Vec3) {
        let v = self.velocity();
        self.history.push(State { t, r: self.r, v, a });
    }

    /// Teleport this particle to a new (r, v) at simulation time `t_now`. The
    /// history ring buffer is reset to a single fresh entry, so retarded-time
    /// lookups will see a static body until the buffer fills again. Used by
    /// the JS-side drag-and-drop handler.
    pub fn teleport(&mut self, new_r: Vec3, new_v: Vec3, t_now: f64) {
        self.r = new_r;
        self.p = momentum_from_velocity(new_v, self.mass);
        self.a_prev = Vec3::ZERO;
        self.snapshot_safe();
        self.history.clear();
        self.history.push(State {
            t: t_now,
            r: new_r,
            v: new_v,
            a: Vec3::ZERO,
        });
    }

    pub fn snapshot_safe(&mut self) {
        self.r_safe = self.r;
        self.p_safe = self.p;
    }

    pub fn rollback(&mut self) {
        self.r = self.r_safe;
        self.p = self.p_safe;
    }

    pub fn is_finite_state(&self) -> bool {
        self.r.is_finite() && self.p.is_finite()
    }
}

// ===== momentum <-> velocity helpers =====

#[inline]
pub fn momentum_from_velocity(v: Vec3, mass: f64) -> Vec3 {
    let v2 = v.norm_sq();
    if v2 <= 0.0 {
        return Vec3::ZERO;
    }
    if mass <= 0.0 {
        return Vec3::ZERO;
    }
    let beta2 = (v2 / C2).min(0.999_999_999_999);
    let gamma = 1.0 / (1.0 - beta2).sqrt();
    v * (gamma * mass)
}

#[inline]
pub fn velocity_from_momentum(p: Vec3, mass: f64) -> Vec3 {
    // v = p c^2 / sqrt(p^2 c^2 + m^2 c^4)
    // This form never blows up: as |p| -> infinity, |v| -> c smoothly.
    let p2 = p.norm_sq();
    let mc2 = mass * C2;
    let denom = (p2 * C2 + mc2 * mc2).sqrt();
    if denom == 0.0 {
        return Vec3::ZERO;
    }
    p * (C2 / denom)
}

#[inline]
pub fn gamma_from_momentum(p: Vec3, mass: f64) -> f64 {
    if mass <= 0.0 {
        return 1.0;
    }
    // E / (m c^2) = sqrt(1 + (p / m c)^2)
    let mc = mass * crate::constants::C;
    (1.0 + p.norm_sq() / (mc * mc)).sqrt()
}

/// Clamp a velocity to BETA_CAP * c without changing direction. Available as a
/// public helper for any caller that wants to gate velocities outside the
/// integrator's soft limiter.
#[allow(dead_code)]
#[inline]
pub fn clamp_velocity(v: Vec3) -> Vec3 {
    let v2 = v.norm_sq();
    let v2_cap = BETA_CAP_2 * C2;
    if v2 <= v2_cap {
        return v;
    }
    v * (v2_cap / v2).sqrt()
}

// C4 is referenced inside energy() above; this const stays in scope.
#[allow(dead_code)]
const _C4_KEEP: f64 = C4;
