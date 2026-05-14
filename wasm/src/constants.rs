// SI physical constants. No multipliers. f64 only.

pub const C: f64 = 2.997_924_58e8;
pub const C2: f64 = C * C;
pub const C4: f64 = C2 * C2;
pub const INV_C: f64 = 1.0 / C;
pub const INV_C2: f64 = 1.0 / C2;

pub const G: f64 = 6.674_30e-11;
#[allow(dead_code)] pub const G_OVER_C2: f64 = G * INV_C2;

pub const EPS0: f64 = 8.854_187_812_8e-12;
pub const MU0: f64 = 1.256_637_062_12e-6;

// Coulomb prefactor 1/(4 pi eps0)
pub const K_E: f64 = 1.0 / (4.0 * std::f64::consts::PI * EPS0);

// EM magnetic prefactor mu0 / (4 pi).  K_E / c^2 by Maxwell's relations.
pub const K_B: f64 = K_E * INV_C2;

// GEM "Coulomb-analogue" prefactor.  Negative because masses attract:
// substituting 1/(4 pi eps0) -> -G turns "like-charges repel" into "like-charges attract".
pub const K_EG: f64 = -G;

// GEM "magnetic-analogue" prefactor.  Wikipedia's stationary-spinning-body
// solution gives  B_g = (G / (2 c^2)) * [L - 3 (L . r_hat) r_hat] / r^3,
// i.e. the prefactor for the dipole shape  [3 (S . n) n - S] / r^3  is
// -G / (2 c^2)  (the leading minus comes from the spin-tensor sign in our
// shape factor and is the same sign convention as electromagnetism's
// mu_0 / (4 pi) once K_EG = -G is set).
//
// Earlier versions of this engine used K_BG = K_EG * INV_C^2 = -G/c^2,
// which made B_g twice as large as Wikipedia's. Combined with the factor 4
// in the Lorentz law that gave a Lense-Thirring force *2x* the textbook
// value. Halving K_BG here restores agreement with Wikipedia's GEM table.
pub const K_BG: f64 = K_EG * INV_C2 * 0.5;

// Extended-GEM factor multiplying B_g in the Lorentz-analogue force
// (Mashhoon convention, F = m (E_g + 4 v x B_g)).
pub const GEM_B_FACTOR: f64 = 4.0;

// Weak-field guard: reject spawn with G m / (r c^2) >= WEAK_FIELD_LIMIT.
// GEM is valid only for gravitational potentials << c^2.
pub const WEAK_FIELD_LIMIT: f64 = 0.05;

// Beta cap used by the soft acceleration limiter (0.9 c).
pub const BETA_CAP: f64 = 0.9;
pub const BETA_CAP_2: f64 = BETA_CAP * BETA_CAP;

// Hard lower bound on the distance clamp, in metres. Even if both colliding
// radii were zero, r is clamped to this so 1/r^2 stays finite.
pub const R_CLAMP_FLOOR: f64 = 1.0e-2;
