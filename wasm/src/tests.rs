// Verification suite. Run with `cargo test --release` (with DEVELOPER_DIR set
// on macOS Xcode-less hosts) or `wasm-pack test --node`.
//
// Each test exercises a property of the physics, not a snapshot of numbers,
// so they remain meaningful as the integrator evolves.

use crate::constants::{C, EPS0, G, K_E};
use crate::particle::{velocity_from_momentum, Particle};
use crate::physics::{
    fields_from_source, find_retarded_state, lorentz_force, newtonian_potential_at,
    total_fields_on,
};
use crate::vec3::Vec3;
use crate::world::{SpawnError, SpawnSpec, World};

const PI: f64 = std::f64::consts::PI;

fn approx(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol * (1.0 + a.abs().max(b.abs()))
}

fn vec_approx(a: Vec3, b: Vec3, tol: f64) -> bool {
    approx(a.x, b.x, tol) && approx(a.y, b.y, tol) && approx(a.z, b.z, tol)
}

// ----------------------------------------------------------------------
// 1. Static Coulomb's law: a stationary charge produces a 1/(4 pi eps0) q / r^2
//    field at the probe, with B = 0.
// ----------------------------------------------------------------------
#[test]
fn coulomb_static() {
    let mut w = World::new(8, 1.0e-6);
    let q = 1.0e-6;
    let r = 1.0;
    w.spawn(SpawnSpec {
        mass: 1.0, charge: q, radius: 0.01,
        r: Vec3::ZERO, v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();

    // Sample the field at (r, 0, 0). With one source, total_fields_on requires
    // an observer particle; spawn a tiny test charge there with zero spin/mass
    // -- but mass must be > 0 to satisfy the guard.  We use a test mass of 1 kg
    // so we can also probe the force, but the *field* is independent of it.
    w.spawn(SpawnSpec {
        mass: 1.0, charge: 0.0, radius: 0.01,
        r: Vec3::new(r, 0.0, 0.0),
        v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();

    let fields = total_fields_on(&w.particles, 1, w.t);
    let expected_e = K_E * q / (r * r);
    assert!(approx(fields.e.x, expected_e, 1.0e-12), "Ex = {}, want {}", fields.e.x, expected_e);
    assert!(fields.e.y.abs() < 1.0e-20);
    assert!(fields.e.z.abs() < 1.0e-20);
    assert!(fields.b.norm() < 1.0e-25);
}

// ----------------------------------------------------------------------
// 2. Like charges repel: the force on a positive test charge points away
//    from a positive source.
// ----------------------------------------------------------------------
#[test]
fn like_charges_repel() {
    let mut w = World::new(8, 1.0e-6);
    w.spawn(SpawnSpec {
        mass: 1.0, charge: 1.0e-6, radius: 0.01,
        r: Vec3::ZERO, v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();
    w.spawn(SpawnSpec {
        mass: 1.0, charge: 1.0e-6, radius: 0.01,
        r: Vec3::new(1.0, 0.0, 0.0),
        v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();

    let fields_on_1 = total_fields_on(&w.particles, 1, w.t);
    let f = lorentz_force(&w.particles[1], fields_on_1);
    assert!(f.x > 0.0, "force should push +x particle further along +x, got {:?}", f);
}

// ----------------------------------------------------------------------
// 3. Masses attract: the GEM E_g on a test mass points TOWARDS the source.
// ----------------------------------------------------------------------
#[test]
fn masses_attract() {
    let mut w = World::new(8, 1.0e-6);
    let m_src = 1.0e20;
    w.spawn(SpawnSpec {
        mass: m_src, charge: 0.0, radius: 1.0e3,
        r: Vec3::ZERO, v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();
    let probe_r = Vec3::new(1.0e6, 0.0, 0.0);
    w.spawn(SpawnSpec {
        mass: 1.0, charge: 0.0, radius: 0.01,
        r: probe_r, v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();

    let fields = total_fields_on(&w.particles, 1, w.t);
    // E_g should point in -x (toward the source). For a static source the
    // force on the test mass is m * E_g, which should be -G m_src m / r^2 along x.
    let expected_eg_x = -G * m_src / (probe_r.x * probe_r.x);
    assert!(approx(fields.eg.x, expected_eg_x, 1.0e-9),
            "E_g.x = {}, expected {}", fields.eg.x, expected_eg_x);
}

// ----------------------------------------------------------------------
// 4. Static Coulomb force matches the closed-form formula on the line.
// ----------------------------------------------------------------------
#[test]
fn coulomb_force_closed_form() {
    let mut w = World::new(8, 1.0e-6);
    let q1 = 2.0e-6;
    let q2 = -3.0e-6;
    let dist = 0.5;
    w.spawn(SpawnSpec {
        mass: 1.0, charge: q1, radius: 0.001,
        r: Vec3::ZERO, v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();
    w.spawn(SpawnSpec {
        mass: 1.0, charge: q2, radius: 0.001,
        r: Vec3::new(dist, 0.0, 0.0),
        v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();

    let fields = total_fields_on(&w.particles, 1, w.t);
    let f = lorentz_force(&w.particles[1], fields);
    // The test masses are 1 kg each, so their mutual gravity also contributes
    // -G m1 m2 / r^2 (attractive, same sign as the opposite-charge Coulomb force).
    let expected_fx = K_E * q1 * q2 / (dist * dist)
                    - G * w.particles[0].mass * w.particles[1].mass / (dist * dist);
    assert!(approx(f.x, expected_fx, 1.0e-12),
            "Fx = {}, expected {}", f.x, expected_fx);
}

// ----------------------------------------------------------------------
// 5. Retarded-time Newton iteration: for a static source, t_ret = t_now - r/c.
// ----------------------------------------------------------------------
#[test]
fn retarded_time_static_source() {
    let mut w = World::new(8, 1.0e-6);
    w.spawn(SpawnSpec {
        mass: 1.0, charge: 1.0, radius: 0.01,
        r: Vec3::ZERO, v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();
    // Advance time without movement by pushing additional history entries.
    for i in 1..6 {
        let t = i as f64 * 1.0e-6;
        w.particles[0].push_history(t, Vec3::ZERO);
    }
    w.t = 5.0e-6;

    let probe = Vec3::new(300.0, 0.0, 0.0);
    let s = find_retarded_state(probe, w.t, &w.particles[0].history).unwrap();
    let expected_t = w.t - 300.0 / C;
    assert!(approx(s.t, expected_t, 1.0e-9),
            "retarded t = {}, expected {}", s.t, expected_t);
}

// ----------------------------------------------------------------------
// 6. Magnetic dipole near-field: aligning the spin along z, B_z on the +z
//    axis is 2 K_B mu / r^3 (the textbook formula).
// ----------------------------------------------------------------------
#[test]
fn em_dipole_axial_field() {
    let q = 1.0e-3;
    let m = 1.0e-3;
    let s_mag = 1.0; // gives mu = (q/2m) S = 0.5 along z
    let mu = q / (2.0 * m) * s_mag;
    let r = 2.0;
    let src_state = crate::particle::State {
        t: 0.0,
        r: Vec3::ZERO, v: Vec3::ZERO, a: Vec3::ZERO,
    };
    let probe = Vec3::new(0.0, 0.0, r);
    let f = fields_from_source(probe, &src_state, m, q, Vec3::new(0.0, 0.0, s_mag));
    // Velocity-field part is zero (static source); only dipole remains.
    let mu0 = crate::constants::MU0;
    let expected = (mu0 / (4.0 * PI)) * 2.0 * mu / (r * r * r);
    assert!(approx(f.b.z, expected, 1.0e-12),
            "Bz = {}, expected {}", f.b.z, expected);
    assert!(f.b.x.abs() + f.b.y.abs() < 1.0e-18);
}

// ----------------------------------------------------------------------
// 7. Gravitomagnetic dipole near-field has the same shape as the EM
//    magnetic dipole, with prefactor -G/(2 c^2) (Wikipedia's convention):
//
//      B_g = (G / (2 c^2)) * [L - 3 (L . r_hat) r_hat] / r^3
//
//    On the +z axis with L = S z_hat the shape factor reduces to -2 S,
//    so the closed-form value is  B_g.z = -G * S / (c^2 r^3).
// ----------------------------------------------------------------------
#[test]
fn gem_dipole_axial_field() {
    let m = 1.0e30;
    let s_mag = 1.0e40; // big enough that f64 can see the result
    let r = 1.0e6;
    let src_state = crate::particle::State { t: 0.0, r: Vec3::ZERO, v: Vec3::ZERO, a: Vec3::ZERO };
    let f = fields_from_source(
        Vec3::new(0.0, 0.0, r),
        &src_state,
        m, 0.0,
        Vec3::new(0.0, 0.0, s_mag),
    );
    // Shape factor on +z axis: [3 (S.n) n - S] = 3 S z_hat - S z_hat = 2 S z_hat.
    // With K_BG = -G/(2 c^2): Bg.z = -G * s_mag / (c^2 r^3).
    let expected = -G * s_mag / (C * C * r * r * r);
    assert!(approx(f.bg.z, expected, 1.0e-10),
            "Bg.z = {}, expected {}", f.bg.z, expected);
}

// ----------------------------------------------------------------------
// 8. Weak-field guard rejects black-hole-density spawn.
// ----------------------------------------------------------------------
#[test]
fn weak_field_guard_rejects_black_hole() {
    let mut w = World::new(8, 1.0e-6);
    // Schwarzschild radius for the sun is ~3 km, so 1 solar mass in a 1 km
    // sphere should be well past the 0.05 limit.
    let result = w.spawn(SpawnSpec {
        mass: 1.989e30, charge: 0.0, radius: 1.0e3,
        r: Vec3::ZERO, v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    });
    assert!(matches!(result, Err(SpawnError::WeakFieldExceeded)));
}

// ----------------------------------------------------------------------
// 9. Superluminal-velocity guard.
// ----------------------------------------------------------------------
#[test]
fn superluminal_guard() {
    let mut w = World::new(8, 1.0e-6);
    let result = w.spawn(SpawnSpec {
        mass: 1.0, charge: 0.0, radius: 0.1,
        r: Vec3::ZERO, v: Vec3::new(C, 0.0, 0.0), spin: Vec3::ZERO,
        allow_merger: false,
    });
    assert!(matches!(result, Err(SpawnError::SuperluminalVelocity)));
}

// ----------------------------------------------------------------------
// 10. Momentum -> velocity round trip stays bounded as p -> infinity.
// ----------------------------------------------------------------------
#[test]
fn velocity_capped_by_c() {
    let huge_p = Vec3::new(1.0e30, 0.0, 0.0);
    let v = velocity_from_momentum(huge_p, 1.0);
    assert!(v.norm() < C);
    assert!(v.norm() > 0.999 * C);
}

// ----------------------------------------------------------------------
// 11. Energy conservation in a slow Kepler-like pair over many steps.
//
// Two equal masses on bound elliptical-ish orbits. The Newtonian limit of GEM
// is just gravity, so the total relativistic energy should drift only at the
// level of the integrator's O(dt^2) truncation error.
// ----------------------------------------------------------------------
#[test]
fn kepler_energy_conservation() {
    let mut w = World::new(2048, 1.0e1);
    let m = 1.0e22;
    let separation = 1.0e8;
    // Circular orbit speed: v = sqrt(G M / r) for one mass orbiting a fixed
    // center; for equal-mass binary, each orbits the COM at half-separation
    // with v = 0.5 sqrt(G M_tot / r). M_tot = 2 m, r_orbit = separation/2.
    let v_orbit = 0.5 * (G * (2.0 * m) / (separation / 2.0)).sqrt();

    w.spawn(SpawnSpec {
        mass: m, charge: 0.0, radius: 1.0e3,
        r: Vec3::new(-separation / 2.0, 0.0, 0.0),
        v: Vec3::new(0.0, -v_orbit, 0.0),
        spin: Vec3::ZERO, allow_merger: false,
    }).unwrap();
    w.spawn(SpawnSpec {
        mass: m, charge: 0.0, radius: 1.0e3,
        r: Vec3::new(separation / 2.0, 0.0, 0.0),
        v: Vec3::new(0.0, v_orbit, 0.0),
        spin: Vec3::ZERO, allow_merger: false,
    }).unwrap();

    let e0 = w.total_energy();
    let p0 = w.total_momentum();

    // Advance ~1/8 of a Kepler orbit. T = 2 pi sqrt(a^3 / GM_tot), a = separation/2.
    let a = separation / 2.0;
    let period = 2.0 * PI * (a * a * a / (G * 2.0 * m)).sqrt();
    let total = period / 8.0;
    w.advance(total, period / 200.0);

    let e1 = w.total_energy();
    let p1 = w.total_momentum();

    let de = (e1 - e0).abs() / e0.abs();
    let dp = (p1 - p0).norm() / e0.abs() * C; // dimensionless comparison

    assert!(de < 1.0e-4, "energy drift {} > 1e-4", de);
    assert!(dp < 1.0e-6, "momentum drift {} > 1e-6", dp);
}

// ----------------------------------------------------------------------
// 12. Newtonian-limit gravitational acceleration matches GMm/r^2.
//
// A test mass placed near a much larger one should accelerate at GM/r^2
// toward the source in the first substep. Easier and faster than a Kepler
// orbit, and pins down our sign conventions.
// ----------------------------------------------------------------------
#[test]
fn newtonian_acceleration_magnitude() {
    let mut w = World::new(8, 1.0e-3);
    let m_src = 1.0e24;
    let r = 1.0e6;
    w.spawn(SpawnSpec {
        mass: m_src, charge: 0.0, radius: 1.0e3,
        r: Vec3::ZERO, v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();
    w.spawn(SpawnSpec {
        mass: 1.0, charge: 0.0, radius: 0.01,
        r: Vec3::new(r, 0.0, 0.0),
        v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();

    let fields = total_fields_on(&w.particles, 1, w.t);
    let f = lorentz_force(&w.particles[1], fields);
    let a_x = f.x / w.particles[1].mass; // Newtonian, v=0
    let expected = -G * m_src / (r * r);
    assert!(approx(a_x, expected, 1.0e-9),
            "a_x = {}, expected {}", a_x, expected);
}

// ----------------------------------------------------------------------
// 13. Newtonian potential function returns the textbook sum.
// ----------------------------------------------------------------------
#[test]
fn newtonian_potential_sum() {
    let mut w = World::new(8, 1.0e-3);
    let m1 = 1.0e22;
    let m2 = 2.0e22;
    w.spawn(SpawnSpec {
        mass: m1, charge: 0.0, radius: 1.0e3,
        r: Vec3::new(-1.0e6, 0.0, 0.0),
        v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();
    w.spawn(SpawnSpec {
        mass: m2, charge: 0.0, radius: 1.0e3,
        r: Vec3::new(1.0e6, 0.0, 0.0),
        v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();

    let probe = Vec3::new(0.0, 1.0e6, 0.0);
    let phi = newtonian_potential_at(&w.particles, probe);
    let r1 = (probe - w.particles[0].r).norm();
    let r2 = (probe - w.particles[1].r).norm();
    let expected = -G * m1 / r1 - G * m2 / r2;
    assert!(approx(phi, expected, 1.0e-12), "phi {} vs {}", phi, expected);
}

// ----------------------------------------------------------------------
// 14. Hard-sphere collision: two equal masses, equal-and-opposite x-velocity,
//     post-collision velocities must be reversed (elastic bounce).
// ----------------------------------------------------------------------
#[test]
fn elastic_bounce_reverses_velocity() {
    let mut w = World::new(8, 1.0e-3);
    w.spawn(SpawnSpec {
        mass: 1.0e10, charge: 0.0, radius: 1.0,
        r: Vec3::new(-3.0, 0.0, 0.0),
        v: Vec3::new(100.0, 0.0, 0.0),
        spin: Vec3::ZERO, allow_merger: false,
    }).unwrap();
    w.spawn(SpawnSpec {
        mass: 1.0e10, charge: 0.0, radius: 1.0,
        r: Vec3::new(3.0, 0.0, 0.0),
        v: Vec3::new(-100.0, 0.0, 0.0),
        spin: Vec3::ZERO, allow_merger: false,
    }).unwrap();

    // Walk them into contact with small substeps. Self-gravity is negligible.
    w.advance(0.04, 1.0e-3);

    let v0 = velocity_from_momentum(w.particles[0].p, w.particles[0].mass);
    let v1 = velocity_from_momentum(w.particles[1].p, w.particles[1].mass);
    // After bounce, particle 0 should be moving in -x and particle 1 in +x.
    assert!(v0.x < 0.0 && v1.x > 0.0,
            "post-bounce: v0={:?}, v1={:?}", v0, v1);
    // Energy conserved (within drift bound).
    let v0n = v0.norm();
    let v1n = v1.norm();
    assert!(approx(v0n, 100.0, 1.0e-3));
    assert!(approx(v1n, 100.0, 1.0e-3));
}

// ----------------------------------------------------------------------
// 15. Frame-dragging: at the equator of a mass with spin S along +z, the
//     gravitomagnetic field B_g must point along +z, and the Lorentz-analogue
//     force F = m * 4 (v x B_g) on a prograde-orbiting test mass must point
//     radially outward. This is the qualitative signature of Lense-Thirring
//     drag on equatorial prograde orbits.
// ----------------------------------------------------------------------
#[test]
fn frame_dragging_equatorial_orientation() {
    let mut w = World::new(8, 1.0e-3);
    let m = 1.0e25;
    let s = Vec3::new(0.0, 0.0, 1.0e35);
    w.spawn(SpawnSpec {
        mass: m, charge: 0.0, radius: 1.0e3,
        r: Vec3::ZERO, v: Vec3::ZERO, spin: s,
        allow_merger: false,
    }).unwrap();
    // Probe particle on the equator at +x, orbiting prograde (+y).
    let r_probe = 1.0e6;
    let v_orb = 100.0;
    w.spawn(SpawnSpec {
        mass: 1.0, charge: 0.0, radius: 0.01,
        r: Vec3::new(r_probe, 0.0, 0.0),
        v: Vec3::new(0.0, v_orb, 0.0),
        spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();
    let f = total_fields_on(&w.particles, 1, w.t);
    // Wikipedia closed-form: at the equator (S . r_hat = 0) the shape
    // factor [3 (S.n) n - S] reduces to -S, and with K_BG = -G/(2 c^2)
    // we get  B_g.z = (G / (2 c^2)) * S_z / r^3.
    let expected_bg_z = G * s.z / (2.0 * C * C * r_probe.powi(3));
    assert!(approx(f.bg.z, expected_bg_z, 1.0e-9),
            "B_g.z at equator = {}, expected {}", f.bg.z, expected_bg_z);
    assert!(f.bg.x.abs() < 1.0e-30 && f.bg.y.abs() < 1.0e-30);

    // Force on the prograde-orbiting probe: v x B_g = (0,v,0) x (0,0,Bgz)
    // = (v Bgz, 0, 0).  Times 4 m gives outward radial force component.
    let force = lorentz_force(&w.particles[1], f);
    // Total force = gravity (inward, -x) + frame-drag (outward, +x). The
    // gravitational term dominates by ~v_orb^2/c^2 vs (G/r) typically, but
    // here we just verify the GEM contribution has the right sign.
    let f_gem_radial = 4.0 * w.particles[1].mass * v_orb * f.bg.z;
    assert!(f_gem_radial > 0.0,
            "GEM-only radial force should be outward, got {}", f_gem_radial);
    // And the total force is still net inward (gravity wins).
    assert!(force.x < 0.0);
}

// ----------------------------------------------------------------------
// 16. Newtonian potential interior of a uniform sphere matches the
//     closed-form  Phi(r) = -GM/(2R) (3 - r^2/R^2).  This pins the
//     JS-side `_potentialJS` (which the lattice renderer uses on every
//     vertex) to the same formula as the Rust authoritative version.
// ----------------------------------------------------------------------
#[test]
fn newtonian_potential_inside_uniform_sphere() {
    let mut w = World::new(8, 1.0e-3);
    let m = 5.0e23;
    let radius = 1.0e6;
    w.spawn(SpawnSpec {
        mass: m, charge: 0.0, radius,
        r: Vec3::ZERO, v: Vec3::ZERO, spin: Vec3::ZERO,
        allow_merger: false,
    }).unwrap();

    // Probe at the centre, at half-radius, and at the surface.
    let phi_centre  = newtonian_potential_at(&w.particles, Vec3::ZERO);
    let phi_half    = newtonian_potential_at(&w.particles, Vec3::new(0.5 * radius, 0.0, 0.0));
    let phi_surface = newtonian_potential_at(&w.particles, Vec3::new(radius, 0.0, 0.0));
    let phi_outside = newtonian_potential_at(&w.particles, Vec3::new(2.0 * radius, 0.0, 0.0));

    // Closed-form references.
    let phi_centre_ref  = -G * m / (2.0 * radius) * 3.0;
    let phi_half_ref    = -G * m / (2.0 * radius) * (3.0 - 0.25);
    let phi_surface_ref = -G * m / radius;
    let phi_outside_ref = -G * m / (2.0 * radius);

    assert!(approx(phi_centre,  phi_centre_ref,  1.0e-12),
            "centre {} vs {}",  phi_centre,  phi_centre_ref);
    assert!(approx(phi_half,    phi_half_ref,    1.0e-12),
            "half-r {} vs {}",  phi_half,    phi_half_ref);
    assert!(approx(phi_surface, phi_surface_ref, 1.0e-12),
            "surface {} vs {}", phi_surface, phi_surface_ref);
    assert!(approx(phi_outside, phi_outside_ref, 1.0e-12),
            "outside {} vs {}", phi_outside, phi_outside_ref);

    // Continuity at the surface: -GM/R from both sides.
    let phi_just_inside  = newtonian_potential_at(&w.particles,
        Vec3::new(radius * 0.999_999, 0.0, 0.0));
    let phi_just_outside = newtonian_potential_at(&w.particles,
        Vec3::new(radius * 1.000_001, 0.0, 0.0));
    assert!((phi_just_inside - phi_just_outside).abs() / phi_surface.abs() < 1.0e-5,
            "potential not C^0 at r=R: in={} out={}", phi_just_inside, phi_just_outside);
}

// ----------------------------------------------------------------------
// 17. Merger conservation laws.
//
//   - Total linear momentum is preserved exactly (sum of p before == p after).
//   - Total charge is preserved exactly.
//   - Total mass is preserved exactly.
//   - Total angular momentum about the world origin is preserved (the
//     orbital component about the new centre-of-mass is absorbed into spin).
// ----------------------------------------------------------------------
#[test]
fn merger_conserves_linear_momentum_and_charge() {
    let mut w = World::new(8, 1.0e-3);
    let m1 = 3.0e22;
    let m2 = 5.0e22;
    let q1 = 1.0e-3;
    let q2 = -4.0e-3;
    let v1 = Vec3::new( 100.0,  20.0, -10.0);
    let v2 = Vec3::new(-50.0,  -40.0,  60.0);
    let r1 = Vec3::new(-0.5e3, 0.0, 0.0);
    let r2 = Vec3::new( 0.5e3, 0.0, 0.0);
    let radius = 1.0e3; // overlap with the other body of equal radius

    w.spawn(SpawnSpec {
        mass: m1, charge: q1, radius, r: r1, v: v1,
        spin: Vec3::new(1.0e30, 2.0e30, -3.0e30),
        allow_merger: true,
    }).unwrap();
    w.spawn(SpawnSpec {
        mass: m2, charge: q2, radius, r: r2, v: v2,
        spin: Vec3::new(-2.0e30, 0.5e30, 4.0e30),
        allow_merger: true,
    }).unwrap();

    let p_before = w.particles[0].p + w.particles[1].p;
    let q_before = w.particles[0].charge + w.particles[1].charge;
    let m_before = w.particles[0].mass + w.particles[1].mass;

    // Resolve will detect overlap and merge.
    let stats = crate::collisions::resolve(&mut w.particles);
    assert_eq!(stats.mergers, 1, "expected 1 merger, got {}", stats.mergers);

    let live: Vec<&Particle> = w.particles.iter().filter(|p| p.alive).collect();
    assert_eq!(live.len(), 1);

    let p_after = live[0].p;
    let q_after = live[0].charge;
    let m_after = live[0].mass;

    let dp = (p_after - p_before).norm() / p_before.norm().max(1.0);
    assert!(dp < 1.0e-12, "linear momentum drift {}", dp);
    assert!(approx(q_after, q_before, 1.0e-12), "charge: {} vs {}", q_after, q_before);
    assert!(approx(m_after, m_before, 1.0e-12), "mass:   {} vs {}", m_after, m_before);
}

#[test]
fn merger_conserves_total_angular_momentum() {
    let mut w = World::new(8, 1.0e-3);
    let m1 = 3.0e22;
    let m2 = 5.0e22;
    let v1 = Vec3::new( 0.0,  150.0, 0.0);
    let v2 = Vec3::new( 0.0, -100.0, 0.0);
    let r1 = Vec3::new(-0.5e3, 0.0, 0.0);
    let r2 = Vec3::new( 0.5e3, 0.0, 0.0);
    let radius = 1.0e3;
    let s1 = Vec3::new(1.0e30,  2.0e30, -3.0e30);
    let s2 = Vec3::new(-2.0e30, 0.5e30, 4.0e30);

    w.spawn(SpawnSpec {
        mass: m1, charge: 0.0, radius, r: r1, v: v1, spin: s1,
        allow_merger: true,
    }).unwrap();
    w.spawn(SpawnSpec {
        mass: m2, charge: 0.0, radius, r: r2, v: v2, spin: s2,
        allow_merger: true,
    }).unwrap();

    let l_orbit_before =
        w.particles[0].r.cross(w.particles[0].p) +
        w.particles[1].r.cross(w.particles[1].p);
    let l_total_before = l_orbit_before + s1 + s2;

    let stats = crate::collisions::resolve(&mut w.particles);
    assert_eq!(stats.mergers, 1);

    let live: Vec<&Particle> = w.particles.iter().filter(|p| p.alive).collect();
    let p = live[0];
    let l_total_after = p.r.cross(p.p) + p.spin;

    let dl = (l_total_after - l_total_before).norm() / l_total_before.norm().max(1.0);
    assert!(dl < 1.0e-9,
            "angular momentum drift {} (before {:?}, after {:?})",
            dl, l_total_before, l_total_after);
}

// ----------------------------------------------------------------------
// 18. Bounce conservation laws.
//
//   - Total linear momentum is preserved (action-reaction impulse).
//   - For equal masses and head-on contact, kinetic energy is preserved.
// ----------------------------------------------------------------------
#[test]
fn bounce_conserves_linear_momentum_and_energy() {
    let mut w = World::new(8, 1.0e-3);
    let m = 1.0e10;
    let radius = 1.0;
    // Position the bodies so they already overlap; resolve() will fire.
    w.spawn(SpawnSpec {
        mass: m, charge: 0.0, radius,
        r: Vec3::new(-0.5, 0.0, 0.0),
        v: Vec3::new( 80.0, 0.0, 0.0),
        spin: Vec3::ZERO, allow_merger: false,
    }).unwrap();
    w.spawn(SpawnSpec {
        mass: m, charge: 0.0, radius,
        r: Vec3::new( 0.5, 0.0, 0.0),
        v: Vec3::new(-80.0, 0.0, 0.0),
        spin: Vec3::ZERO, allow_merger: false,
    }).unwrap();

    let p_before = w.particles[0].p + w.particles[1].p;
    let e_before: f64 = w.particles.iter().filter(|p| p.alive).map(|p| p.energy()).sum();

    let stats = crate::collisions::resolve(&mut w.particles);
    assert_eq!(stats.bounces, 1);

    let p_after = w.particles[0].p + w.particles[1].p;
    let e_after: f64 = w.particles.iter().filter(|p| p.alive).map(|p| p.energy()).sum();

    // Total momentum: zero before, zero after, exactly.
    let dp = (p_after - p_before).norm();
    assert!(dp < 1.0e-6, "linear momentum drift {} (before {:?}, after {:?})",
            dp, p_before, p_after);
    // Energy is conserved to (v/c)^4-ish precision for this non-relativistic
    // bounce.
    let de = (e_after - e_before).abs() / e_before.abs();
    assert!(de < 1.0e-10, "kinetic energy drift {}", de);

    // After head-on equal-mass elastic bounce, the velocities should be
    // *reversed* in sign and equal in magnitude.
    let v0 = velocity_from_momentum(w.particles[0].p, w.particles[0].mass);
    let v1 = velocity_from_momentum(w.particles[1].p, w.particles[1].mass);
    assert!(v0.x < 0.0 && v1.x > 0.0, "velocities not reversed: {:?} {:?}", v0, v1);
    assert!(approx(v0.norm(), 80.0, 1.0e-9));
    assert!(approx(v1.norm(), 80.0, 1.0e-9));
}

#[test]
fn vec_helpers_are_used() {
    // Touch helpers so they aren't dead in test build (silences warnings).
    let _ = approx(0.0, 0.0, 1.0);
    let _ = vec_approx(Vec3::ZERO, Vec3::ZERO, 1.0);
    let _ = EPS0;
}
