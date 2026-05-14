// Relativistic Velocity-Verlet (a.k.a. "momentum-Verlet") integrator.
//
// State per particle is (r, p) with p = gamma m v.  One substep:
//
//   1.  Kick A: p_{n+1/2} = p_n + (dt/2) F_n
//   2.  Drift:  r_{n+1}   = r_n + dt * v(p_{n+1/2})
//   3.  Push new (t, r, v, a) to history ring buffer (a from previous substep).
//   4.  Recompute F_{n+1} at the new positions using retarded fields.
//   5.  Kick B: p_{n+1} = p_{n+1/2} + (dt/2) F_{n+1}
//   6.  Stash F_{n+1} on the particle for the next substep's kick A.
//
// Step 4 is the O(N^2) cost; everything else is O(N).
//
// The kinematic-acceleration field stored in history is a := dv/dt converted
// from F via relativistic_acceleration() so the Lienard-Wiechert evaluator
// sees the correct retarded beta_dot.

use crate::constants::{BETA_CAP, C, BETA_CAP_2};
use crate::particle::{velocity_from_momentum, Particle};
use crate::physics::{lorentz_force, relativistic_acceleration, total_fields_on, Fields};
use crate::vec3::Vec3;

/// Compute the live (non-retarded, current-time) Lorentz force on every
/// particle. This is what we use *for* a substep's kick; it relies on the
/// retarded fields evaluated against every other particle's history.
pub fn compute_all_forces(particles: &[Particle], t_now: f64) -> Vec<(Vec3, Fields)> {
    let n = particles.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        if !particles[i].alive {
            out.push((Vec3::ZERO, Fields::default()));
            continue;
        }
        let fields = total_fields_on(particles, i, t_now);
        let f = lorentz_force(&particles[i], fields);
        out.push((f, fields));
    }
    out
}

/// One full substep. Mutates particles in place.
///
/// `forces_prev` must contain F_n for every particle (computed at the previous
/// substep's end, or at simulation init for the first substep). On return, the
/// same slot in `forces_prev` is overwritten with F_{n+1} for the next call.
pub fn step(
    particles: &mut [Particle],
    forces_prev: &mut [(Vec3, Fields)],
    t_now: f64,
    dt: f64,
) {
    let n = particles.len();
    debug_assert_eq!(forces_prev.len(), n);

    // Step 1: half-kick using F_n
    for i in 0..n {
        if !particles[i].alive { continue; }
        particles[i].snapshot_safe();
        let (f_n, _) = forces_prev[i];
        particles[i].p += f_n * (0.5 * dt);
    }

    // Step 2: drift, with soft cap on |v| at BETA_CAP * c
    for i in 0..n {
        if !particles[i].alive { continue; }
        let mass = particles[i].mass;
        let mut v = velocity_from_momentum(particles[i].p, mass);
        let v2 = v.norm_sq();
        let v2_cap = BETA_CAP_2 * C * C;
        if v2 > v2_cap {
            v = v * (v2_cap / v2).sqrt();
            // Project momentum back to the capped velocity.
            particles[i].p = crate::particle::momentum_from_velocity(v, mass);
        }
        particles[i].r += v * dt;
    }

    // Step 3: push history entry at the new time, using the *previous* dv/dt as
    // the acceleration field.  This is the value that will be lerped at t_{n+1}
    // by future retarded-time lookups; using a_prev is fine because we update
    // it with the new value as soon as we recompute forces below.
    let t_new = t_now + dt;
    for i in 0..n {
        if !particles[i].alive { continue; }
        let a_prev = particles[i].a_prev;
        particles[i].push_history(t_new, a_prev);
    }

    // Step 4: recompute forces at the new state.
    let forces_new = compute_all_forces(particles, t_new);

    // Step 5: second half-kick using F_{n+1}, and update a_prev so the next
    // substep's history-write picks up the correct dv/dt at t_{n+1}.
    for i in 0..n {
        if !particles[i].alive {
            forces_prev[i] = forces_new[i];
            continue;
        }
        let (f_new, _) = forces_new[i];
        particles[i].p += f_new * (0.5 * dt);

        let v = particles[i].velocity();
        let gamma = particles[i].gamma();
        let a = relativistic_acceleration(f_new, v, gamma, particles[i].mass);
        particles[i].a_prev = a;

        forces_prev[i] = forces_new[i];

        // NaN sentinel: roll back if any non-finite leaked through.
        if !particles[i].is_finite_state() {
            particles[i].rollback();
            particles[i].a_prev = Vec3::ZERO;
            forces_prev[i] = (Vec3::ZERO, Fields::default());
        }
    }
}

/// Recommend a maximum stable substep dt given the scene. Heuristic blend of:
///   - light-crossing fraction of the closest pair (Courant-style)
///   - cyclotron / gyration period for the strongest local magnetic field
///   - acceleration timescale  sqrt(r_min / |a_max|)
pub fn recommend_dt(particles: &[Particle], forces: &[(Vec3, Fields)], fallback: f64) -> f64 {
    let mut dt = fallback;
    for (i, p) in particles.iter().enumerate() {
        if !p.alive { continue; }
        let (f, fields) = forces[i];
        let mass = p.mass.max(1.0e-300);
        let a_norm = (f * (1.0 / mass)).norm();
        if a_norm > 0.0 {
            let v_norm = p.velocity().norm().max(1.0);
            // limit dv per substep to 1% of current speed
            dt = dt.min(0.01 * v_norm / a_norm);
        }
        let b_mag = fields.b.norm() + fields.bg.norm();
        if b_mag > 0.0 && p.charge != 0.0 {
            // limit angle per substep to 0.01 rad of an EM gyration
            let omega_c = (p.charge.abs() / mass) * b_mag;
            if omega_c > 0.0 {
                dt = dt.min(0.01 / omega_c);
            }
        }
    }
    // Hard floor so we never grind to dt = 0.
    dt.max(1.0e-18)
}

#[allow(dead_code)] const _BETA_CAP_KEEP: f64 = BETA_CAP;
