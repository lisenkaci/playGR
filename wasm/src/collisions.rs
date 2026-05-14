// Hard-sphere collision resolution.
//
// We do *not* let the Lienard-Wiechert evaluator handle near-zero r itself
// (the distance clamp keeps the math finite, but the resulting impulse would
// still be unphysical). Instead, after each drift we check every pair for
// sphere overlap and either elastically bounce them apart or, if both
// particles have `allow_merger = true`, merge them.
//
// "Elastic bounce" here means: equal-and-opposite normal impulses chosen so
// that the post-collision relative velocity along the line of centres is
// reversed. Tangential velocities are preserved. Both relativistic momentum
// and energy are conserved in the non-relativistic limit; for relativistic
// approach speeds the impulse is computed in momentum space directly so
// p1 + p2 is preserved exactly, with a small (controlled) drift in total
// rest+kinetic energy proportional to (v/c)^4.

use crate::particle::{momentum_from_velocity, velocity_from_momentum, Particle};
use crate::vec3::Vec3;

pub struct CollisionStats {
    pub bounces: u32,
    pub mergers: u32,
}

/// Resolve every pair-overlap in `particles`. Modifies particles in place.
pub fn resolve(particles: &mut [Particle]) -> CollisionStats {
    let mut bounces = 0u32;
    let mut mergers = 0u32;

    // Single pass is enough for the typical case (sparse overlaps). Repeated
    // overlaps after one pair-resolve are rare and resolved on the next substep.
    for i in 0..particles.len() {
        if !particles[i].alive {
            continue;
        }
        for j in (i + 1)..particles.len() {
            if !particles[j].alive {
                continue;
            }

            let delta = particles[j].r - particles[i].r;
            let dist2 = delta.norm_sq();
            let r_sum = particles[i].radius + particles[j].radius;
            if dist2 >= r_sum * r_sum {
                continue;
            }

            if particles[i].allow_merger && particles[j].allow_merger {
                merge_pair(particles, i, j);
                mergers += 1;
            } else {
                bounce_pair(particles, i, j, delta, dist2.sqrt(), r_sum);
                bounces += 1;
            }
        }
    }

    CollisionStats { bounces, mergers }
}

fn bounce_pair(particles: &mut [Particle], i: usize, j: usize, delta: Vec3, dist: f64, r_sum: f64) {
    // n points from i to j.
    let n = if dist > 0.0 {
        delta / dist
    } else {
        Vec3::new(1.0, 0.0, 0.0)
    };

    // First, separate them along n so they no longer overlap. We split the
    // penetration in inverse proportion to mass (lighter body moves more).
    let penetration = (r_sum - dist).max(0.0);
    let m_i = particles[i].mass.max(1.0e-300);
    let m_j = particles[j].mass.max(1.0e-300);
    let m_tot = m_i + m_j;
    let push_i = -n * (penetration * (m_j / m_tot));
    let push_j = n * (penetration * (m_i / m_tot));
    particles[i].r += push_i;
    particles[j].r += push_j;

    // Elastic collision impulse along n.  Working in momentum: with p_i, p_j
    // and reduced-velocity along n,
    //     v_rel_n = (v_j - v_i) . n
    //     impulse = - (1 + e) * mu * v_rel_n * n
    // where mu = m_i m_j / (m_i + m_j) is the reduced mass and e = 1 for fully
    // elastic. We use velocity (not gamma m v) for the reduced-mass formula,
    // then write the impulse directly into momentum (dp = F dt impulse form).
    let v_i = particles[i].velocity();
    let v_j = particles[j].velocity();
    let v_rel_n = (v_j - v_i).dot(n);
    if v_rel_n >= 0.0 {
        return;
    } // already separating

    let mu = (m_i * m_j) / m_tot;
    let jn = -2.0 * mu * v_rel_n;
    let impulse = n * jn;

    particles[i].p -= impulse;
    particles[j].p += impulse;
}

fn merge_pair(particles: &mut [Particle], i: usize, j: usize) {
    let m_i = particles[i].mass;
    let m_j = particles[j].mass;
    let m_tot = m_i + m_j;
    if m_tot <= 0.0 {
        return;
    }

    let p_i = particles[i].p;
    let p_j = particles[j].p;
    let p_tot = p_i + p_j;
    let q_tot = particles[i].charge + particles[j].charge;
    let r_i = particles[i].r;
    let r_j = particles[j].r;
    let r_com = (r_i * m_i + r_j * m_j) / m_tot;

    // Angular-momentum-conserving spin combination.
    //
    // Total angular momentum about the world origin before the merger:
    //     L_before = r_i x p_i + r_j x p_j + S_i + S_j
    //
    // After the merger the surviving body lives at r_com with momentum p_tot
    // and spin S_new, so its angular momentum about the origin is:
    //     L_after  = r_com x p_tot + S_new
    //
    // Requiring L_after == L_before and using p_tot = p_i + p_j gives
    //     S_new = S_i + S_j + (r_i - r_com) x p_i + (r_j - r_com) x p_j
    //
    // i.e. the orbital angular momentum of the two bodies *about the new
    // centre of mass* is absorbed into the merged body's spin, which is
    // exactly the textbook outcome of a perfectly inelastic merger.
    let l_orb_i = (r_i - r_com).cross(p_i);
    let l_orb_j = (r_j - r_com).cross(p_j);
    let s_tot = particles[i].spin + particles[j].spin + l_orb_i + l_orb_j;

    // New radius: conserve volume of uniform spheres so density stays sane.
    let r3 = particles[i].radius.powi(3) + particles[j].radius.powi(3);
    let new_radius = r3.cbrt();

    // Update the heavier particle in place; mark the lighter as dead.
    let (keep, kill) = if m_i >= m_j { (i, j) } else { (j, i) };
    particles[keep].mass = m_tot;
    particles[keep].charge = q_tot;
    particles[keep].r = r_com;
    particles[keep].p = p_tot;
    particles[keep].spin = s_tot;
    particles[keep].radius = new_radius;
    particles[keep].allow_merger = true;
    particles[keep].snapshot_safe();

    // Re-derive velocity from the new (p, m_tot) and stash a sane initial
    // history entry so retarded lookups at the merged body's previous state
    // do not blow up. (This re-write is a no-op when v < c since momentum_from
    // is the inverse of velocity_from, but it normalises any rounding drift.)
    let v_new = velocity_from_momentum(p_tot, m_tot);
    particles[keep].p = momentum_from_velocity(v_new, m_tot);

    particles[kill].alive = false;
}
