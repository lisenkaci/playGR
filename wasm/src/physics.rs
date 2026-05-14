// Retarded-potential field evaluators.
//
// For each (observer A, source B != A) we solve for the retarded time t_ret
// using Newton's method against B's history ring buffer (linearly interpolating
// between adjacent stored states), then evaluate the Lienard-Wiechert E and B
// fields produced by B's point charge / mass at that retarded state.
//
// EM and GEM share exactly the same algebraic structure - GEM is obtained by
// the substitutions
//
//     1 / (4 pi eps0)  ->  -G           (gravitoelectric prefactor K_EG)
//     mu_0 / (4 pi)    ->  -G / (2 c^2) (gravitomagnetic prefactor K_BG;
//                                        the factor 1/2 is the spin-2 GEM
//                                        normalisation chosen so the
//                                        stationary spinning-body solution
//                                        B_g = G/(2c^2) [L - 3(L.r_hat)r_hat]/r^3
//                                        matches Wikipedia / Mashhoon)
//     q                ->  m
//     mu_em (dipole)   ->  S (rigid spin angular momentum)
//
// and the Lorentz-analogue force law
//
//     F = q (E + v x B) + m (E_g + 4 v x B_g)
//
// where the factor 4 on B_g is the Extended-GEM (Mashhoon) convention.

use crate::constants::{C, GEM_B_FACTOR, INV_C, INV_C2, K_B, K_BG, K_E, K_EG, R_CLAMP_FLOOR};
use crate::particle::{Particle, State};
use crate::ring_buffer::RingBuffer;
use crate::vec3::Vec3;

#[derive(Copy, Clone, Debug, Default)]
pub struct Fields {
    pub e: Vec3,
    pub b: Vec3,
    pub eg: Vec3,
    pub bg: Vec3,
}

impl Fields {
    #[inline]
    pub fn add(&mut self, other: Fields) {
        self.e += other.e;
        self.b += other.b;
        self.eg += other.eg;
        self.bg += other.bg;
    }
}

/// Solve for the retarded time t_ret given an observer state and a source
/// history. Returns the interpolated source state at t_ret, or `None` if the
/// history is empty.
///
/// Newton iteration on  f(t_ret) = R(t_ret) - c * (t_now - t_ret) = 0
/// where R(t) = |r_obs - r_src(t)|. The derivative is
///     f'(t_ret) = c * (1 - n_hat . beta_src) = c * kappa
/// so the update is t_ret <- t_ret - f / (c * kappa).
pub fn find_retarded_state(r_obs: Vec3, t_now: f64, src_history: &RingBuffer) -> Option<State> {
    let newest = src_history.newest()?;

    // Initial guess: pretend the source is static at its current position.
    let r0 = (r_obs - newest.r).norm();
    let mut t_ret = t_now - r0 * INV_C;

    // 4 iterations is plenty for f64 convergence when v < c.
    for _ in 0..4 {
        let s = src_history.sample_at(t_ret)?;
        let delta = r_obs - s.r;
        let r = delta.norm().max(R_CLAMP_FLOOR);
        let f = r - C * (t_now - t_ret);
        // n . beta = (delta / r) . (v / c)
        let n_dot_beta = delta.dot(s.v) / (r * C);
        let kappa = (1.0 - n_dot_beta).max(1.0e-6); // numerical floor
        let step = f / (C * kappa);
        t_ret -= step;
        if step.abs() < 1.0e-15 * t_now.abs().max(1.0) {
            break;
        }
    }

    src_history.sample_at(t_ret)
}

/// Compute Lienard-Wiechert E and B fields, plus the GEM analogues, at the
/// observer position `r_obs` from a single source particle's retarded state.
///
/// The source's instantaneous mass / charge / spin are passed in directly
/// (rather than read from history) because in this engine those quantities can
/// only change via discrete events (mergers), and a source that has already
/// merged out of existence does not radiate from the past.
pub fn fields_from_source(
    r_obs: Vec3,
    src_state: &State,
    src_mass: f64,
    src_charge: f64,
    src_spin: Vec3,
) -> Fields {
    let delta = r_obs - src_state.r;
    let r = delta.norm().max(R_CLAMP_FLOOR);
    let n = delta / r;
    let beta = src_state.v * INV_C;
    let beta_dot = src_state.a * INV_C;
    let beta2 = beta.norm_sq().min(0.999_999_999);
    let kappa = (1.0 - n.dot(beta)).max(1.0e-6);
    let kappa3 = kappa * kappa * kappa;

    let r2 = r * r;
    let r3 = r2 * r;

    // ---- Velocity (1/R^2) Lienard-Wiechert field, shape factor ----
    let v_term = (n - beta) * ((1.0 - beta2) / (kappa3 * r2));

    // ---- Radiation (1/R) field, shape factor ----
    let n_minus_beta = n - beta;
    let rad_inner = n_minus_beta.cross(beta_dot);
    let rad_term = n.cross(rad_inner) * (INV_C / (kappa3 * r));

    let shape_em = v_term + rad_term;
    let e_em = shape_em * (K_E * src_charge);
    let b_em = n.cross(e_em) * INV_C;

    let e_g = shape_em * (K_EG * src_mass);
    let b_g = n.cross(e_g) * INV_C;

    // ---- Static dipole contribution from spin ----
    //
    // EM magnetic dipole moment of a spinning point body with classical
    // gyromagnetic ratio g = 1:  mu_em = (q / 2m) S.
    //
    // Near-field B = (mu0 / 4pi) [3 (mu . n) n - mu] / R^3 = K_B [...].
    let mu_em = if src_mass > 0.0 {
        src_spin * (src_charge / (2.0 * src_mass))
    } else {
        Vec3::ZERO
    };
    let dip_em = (n * (3.0 * mu_em.dot(n))) - mu_em;
    let b_em = b_em + dip_em * (K_B / r3);

    // GEM gravitomagnetic dipole moment is simply S; the substitution
    // mu0/(4 pi) -> K_BG = -G / c^2 gives the near-field B_g.
    let dip_g = (n * (3.0 * src_spin.dot(n))) - src_spin;
    let b_g = b_g + dip_g * (K_BG / r3);

    Fields {
        e: e_em,
        b: b_em,
        eg: e_g,
        bg: b_g,
    }
}

/// Sum all retarded-source fields acting on observer particle `obs_idx`.
pub fn total_fields_on(particles: &[Particle], obs_idx: usize, t_now: f64) -> Fields {
    let obs = &particles[obs_idx];
    let mut sum = Fields::default();
    for (j, src) in particles.iter().enumerate() {
        if j == obs_idx || !src.alive {
            continue;
        }
        if let Some(s_ret) = find_retarded_state(obs.r, t_now, &src.history) {
            let f = fields_from_source(obs.r, &s_ret, src.mass, src.charge, src.spin);
            sum.add(f);
        }
    }
    sum
}

/// Compute the Lorentz-analogue force on observer particle `obs_idx`:
///     F = q (E + v x B) + m (E_g + 4 v x B_g)
#[inline]
pub fn lorentz_force(particle: &Particle, fields: Fields) -> Vec3 {
    let v = particle.velocity();
    let f_em = (fields.e + v.cross(fields.b)) * particle.charge;
    let f_gem = (fields.eg + v.cross(fields.bg) * GEM_B_FACTOR) * particle.mass;
    f_em + f_gem
}

/// Convert dp/dt = F into proper kinematic acceleration dv/dt.
///
/// Starting from p = gamma m v, F = dp/dt, one finds
///     dv/dt = (F - v (v . F) / c^2) / (gamma m).
/// In the low-v limit this is just F/m; near c it accounts for the increasing
/// inertia parallel to v while leaving perpendicular response as F_perp/(gamma m).
#[inline]
pub fn relativistic_acceleration(force: Vec3, v: Vec3, gamma: f64, mass: f64) -> Vec3 {
    if mass <= 0.0 {
        return Vec3::ZERO;
    }
    let v_dot_f = v.dot(force);
    let f_eff = force - v * (v_dot_f * INV_C2);
    f_eff * (1.0 / (gamma * mass))
}

/// Newtonian-limit gravitational potential at a point, summed over all live
/// particles. Used by the renderer's spacetime grid to compute g_tt curvature
/// without paying the full retarded-evaluation cost (the renderer only needs a
/// scalar field; the dynamics still pay the full price).
///
/// Uses the uniform-sphere closed-form so that the field is C^0 continuous at
/// the body surface and varies smoothly inside the body (rather than being
/// pinned to -GM/R for any r < R, which produces a flat disc in the grid):
///
///   r >= R:  Phi(r) = -G M / r
///   r <  R:  Phi(r) = -G M / (2 R) * (3 - r^2 / R^2)
///
/// This MUST stay in lockstep with `_potentialJS` in `src/physicsBridge.js`,
/// since the renderer reads its own copy of the formula for every grid vertex
/// (avoiding O(verts) WASM round-trips per frame). Pinned by the
/// `newtonian_potential_sum` test in `tests.rs`.
pub fn newtonian_potential_at(particles: &[Particle], probe: Vec3) -> f64 {
    let mut phi = 0.0_f64;
    let g = crate::constants::G;
    for p in particles.iter().filter(|p| p.alive) {
        let radius = p.radius.max(1.0e-6);
        let r = (probe - p.r).norm();
        let gm = g * p.mass;
        if r >= radius {
            phi -= gm / r.max(R_CLAMP_FLOOR);
        } else {
            phi -= gm / (2.0 * radius) * (3.0 - (r * r) / (radius * radius));
        }
    }
    phi
}
