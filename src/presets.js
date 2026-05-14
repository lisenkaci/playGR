// Spawn presets. Every value is in SI units. No multipliers.
//
// Two families of presets:
//
//  1. Neutral massive bodies (asteroid, planet, star, neutron-star fragment,
//     spinning motors, binary).
//
//  2. Charged macroscopic bodies. These are NOT single elementary particles
//     (no electrons, no positrons, no point-charge clouds). They are real
//     extended objects -- asteroid- or planet-scale -- that carry a net
//     positive or negative charge so the user can study Coulomb dynamics
//     between objects on the same visual scale as the gravitational bodies.
//
// "Max-legal motor" presets are sized so that G m / (r c^2) is just under the
// weak-field guard limit (0.05). This is the densest a single body can be
// before the engine refuses to spawn it.

const G   = 6.67430e-11;
const C   = 2.997_924_58e8;
const C2  = C * C;
const K_E = 8.987_551_787e9; // Coulomb constant 1/(4 pi eps_0)
const WEAK_LIMIT = 0.05;

// Largest mass we can pack inside a sphere of radius `r` without tripping the
// weak-field guard.
function maxLegalMass(rMetres) {
  return 0.95 * WEAK_LIMIT * rMetres * C2 / G;
}

// Helper: a uniform-density solid sphere of mass m and radius r has moment of
// inertia I = 2/5 m r^2; spinning at angular speed omega gives S = I omega.
function spinAngularMomentum(mass, radius, omegaRadPerS, axis = [0, 1, 0]) {
  const I = 0.4 * mass * radius * radius;
  const S = I * omegaRadPerS;
  return [axis[0] * S, axis[1] * S, axis[2] * S];
}

// Charge magnitudes used by the "charged body" presets.
//
//   * LIGHT bodies are asteroid-scale (10^18 kg, 10 km radius). At that mass,
//     gravity between two of them is negligible at scene-scale separations,
//     so a charge of 1e10 C produces clearly visible Coulomb dynamics
//     (acceleration ~ 90 m/s^2 at 100 km separation).
//
//   * HEAVY bodies are planet-class (5.97e24 kg, 500 km radius). At that
//     mass, gravity is strong, so the charge has to be much larger for EM
//     to compete: 1.5e15 C puts |F_em| ~ 9 |F_grav| for two like-sign heavy
//     bodies at the same separation, which gives a satisfying "charged
//     dynamics dominate" feel without breaking the physics engine.
//
// These values were chosen so that the resulting accelerations stay well
// below relativistic limits over the first few hundred sim-seconds of
// typical play.
const Q_LIGHT = 1.0e10;
const Q_HEAVY = 1.5e15;

const M_LIGHT = 1.0e18;
const R_LIGHT = 1.0e4;
const M_HEAVY = 5.972e24;
const R_HEAVY = 5.0e5;

// Each section appears as its own labelled group in the spawn panel.
export const PRESET_SECTIONS = [
{
  label: 'Single masses',
  presets: [
  {
    id: 'asteroid',
    label: 'Small asteroid',
    desc: '~10^12 kg rock at rest. Negligible gravity, bounces elastically off others. Toggle "Force merger on new spawns" to make them coalesce instead.',
    spec: {
      mass: 1.0e12, charge: 0, radius: 1.0e2,
      r: [0, 0, 0], v: [0, 0, 0], spin: [0, 0, 0],
      allow_merger: false,
    },
  },
  {
    id: 'planet',
    label: 'Earth-mass body',
    desc: 'Earth-mass (5.97e24 kg) compact body, ~56 km radius. Bounces on contact. Toggle "Force merger on new spawns" to coalesce instead.',
    spec: {
      mass: M_HEAVY, charge: 0, radius: R_HEAVY / 9,
      r: [0, 0, 0], v: [0, 0, 0], spin: [0, 0, 0],
      allow_merger: false,
    },
  },
  {
    id: 'star',
    label: 'Solar mass body',
    desc: 'One solar mass (1.989e30 kg) compressed to 500 km. Bounces on contact. Toggle "Force merger on new spawns" to make collisions coalesce instead.',
    spec: {
      mass: 1.989e30, charge: 0, radius: 5.0e5,
      r: [0, 0, 0], v: [0, 0, 0], spin: [0, 0, 0],
      allow_merger: false,
    },
  },
  {
    id: 'neutron-star-fragment',
    label: 'Neutron-star fragment',
    desc: '~10^28 kg in a 1 km sphere (density ~ nuclear matter). Bounces elastically. Toggle "Force merger on new spawns" to coalesce.',
    spec: (() => {
      const radius = 1.0e3;
      const mass = maxLegalMass(radius);
      return {
        mass, charge: 0, radius,
        r: [0, 0, 0], v: [0, 0, 0], spin: [0, 0, 0],
        allow_merger: false,
      };
    })(),
  },
  ],
},
{
  label: 'Spinning bodies',
  presets: [
  {
    id: 'motor-slow',
    label: 'Motor (slow spin)',
    desc: 'Max-legal-density mass spinning at omega = 100 rad/s. Visible Bg.',
    spec: (() => {
      const radius = 5.0e2;
      const mass = maxLegalMass(radius);
      const spin = spinAngularMomentum(mass, radius, 100.0, [0, 1, 0]);
      return {
        mass, charge: 0, radius,
        r: [0, 0, 0], v: [0, 0, 0], spin,
        allow_merger: false,
      };
    })(),
  },
  {
    id: 'motor-fast',
    label: 'Motor (fast spin)',
    desc: 'Max-legal-density mass at the equatorial-speed limit (~0.3 c at surface).',
    spec: (() => {
      const radius = 1.0e3;
      const mass = maxLegalMass(radius);
      // Surface speed = omega * r; cap at 0.3 c so the dipole-source motion
      // doesn't violate beta cap inside the source body.
      const omega = (0.3 * C) / radius;
      const spin = spinAngularMomentum(mass, radius, omega, [0, 1, 0]);
      return {
        mass, charge: 0, radius,
        r: [0, 0, 0], v: [0, 0, 0], spin,
        allow_merger: false,
      };
    })(),
  },
  {
    id: 'spinning-solar',
    label: 'Spinning solar (Kerr-like)',
    desc: 'Solar-mass body (1.989e30 kg, 500 km radius) spinning at omega = 1000 rad/s along +y. Produces a clearly visible frame-dragging swirl in the lattice around the spin axis.',
    spec: (() => {
      const radius = 5.0e5;
      const mass = 1.989e30;
      // 1000 rad/s -> 2 pi/1000 = 6.3 ms period. Far below the weak-field
      // limit at this radius, and well below the beta cap at the surface
      // (1000 * 5e5 = 5e8 m/s -- actually super-luminal at surface, so we
      // pick something safer). Cap surface speed at 0.05 c.
      const omegaCap = (0.05 * C) / radius; // ~30 rad/s
      const omega = Math.min(1000, omegaCap);
      const spin = spinAngularMomentum(mass, radius, omega, [0, 1, 0]);
      return {
        mass, charge: 0, radius,
        r: [0, 0, 0], v: [0, 0, 0], spin,
        allow_merger: false,
      };
    })(),
  },
  ],
},
{
  label: 'Orbits & choreographies',
  presets: [
  {
    id: 'binary-stars',
    label: 'Binary (stellar)',
    desc: 'Two solar-mass bodies in a tight circular orbit. Period ~0.4 s.',
    multi: (() => {
      const m = 1.989e30, R = 1.0e6;
      const v = 0.5 * Math.sqrt(G * 2 * m / R);
      return [
        { mass: m, charge: 0, radius: 7.0e4, r: [-R/2, 0, 0], v: [0, 0, -v], spin: [0,0,0], allow_merger: false },
        { mass: m, charge: 0, radius: 7.0e4, r: [+R/2, 0, 0], v: [0, 0, +v], spin: [0,0,0], allow_merger: false },
      ];
    })(),
  },
  {
    id: 'sun-planet',
    label: 'Sun + planet',
    desc: 'One solar-mass star at the origin with a single Earth-mass planet in a tight circular orbit at 1200 km. The big mass-ratio (~330,000x) means you can see two clearly different-sized gravity wells side by side -- great for showing that the lattice now resolves each body independently.',
    multi: (() => {
      // Star: same parameters as the "Solar mass body" preset.
      const Ms = 1.989e30, Rs = 5.0e5;
      // Planet: same parameters as the "Earth-mass body" preset.
      const Mp = M_HEAVY,  Rp = R_HEAVY / 9;
      // Orbit chosen so the planet sits ~12 visual units from the star,
      // which fits inside the auto-grown lattice (max half-extent = 14).
      const r = 1.2e6;
      // Circular orbit speed about a stationary primary (Mp << Ms):
      const v = Math.sqrt(G * Ms / r);
      return [
        { mass: Ms, charge: 0, radius: Rs, r: [0, 0, 0],  v: [0, 0, 0], spin: [0, 0, 0], allow_merger: false },
        { mass: Mp, charge: 0, radius: Rp, r: [r, 0, 0],  v: [0, 0, v], spin: [0, 0, 0], allow_merger: false },
      ];
    })(),
  },
  {
    id: 'three-body-figure-8',
    label: 'Three-body figure-8',
    desc: 'Chenciner & Montgomery (2000) choreography: three equal solar-mass bodies (1.989e30 kg) chase each other around a figure-8 path. In principle exactly periodic; in practice f64 + Velocity-Verlet drifts off the orbit after several periods, which is itself a nice demonstration of how sensitive the 3-body problem is to numerical noise. Period ~0.2 s -- slow time down on the slider to follow individual bodies.',
    multi: (() => {
      // Three solar-mass bodies (same as each body in the "Binary (stellar)"
      // preset). L = 5e5 m keeps the figure-8 pattern inside the auto-grown
      // lattice (~10 visual units across). The period scales as
      // sqrt(L^3 / GM); with M = solar this lands at ~0.2 s of sim time per
      // full figure-8, comparable to the binary's ~0.4 s period.
      const m = 1.989e30;
      const L = 5.0e5;
      const Tu = Math.sqrt(L * L * L / (G * m));
      const Vu = L / Tu;
      // Chenciner-Montgomery initial conditions, dimensionless:
      //   r1 = -r2 = (0.97000436, -0.24308753, 0)
      //   r3 = 0
      //   v3 = (-0.93240737, -0.86473146, 0)
      //   v1 = v2 = -v3 / 2
      const r1 = [ 0.97000436 * L, -0.24308753 * L, 0];
      const r2 = [-0.97000436 * L,  0.24308753 * L, 0];
      const r3 = [ 0, 0, 0];
      const v3 = [-0.93240737 * Vu, -0.86473146 * Vu, 0];
      const v1 = [-v3[0] / 2, -v3[1] / 2, 0];
      const v2 = [...v1];
      const radius = 7.0e4; // matches the binary's per-body radius exactly
      const base = { charge: 0, spin: [0, 0, 0], radius, allow_merger: false };
      return [
        { ...base, mass: m, r: r1, v: v1 },
        { ...base, mass: m, r: r2, v: v2 },
        { ...base, mass: m, r: r3, v: v3 },
      ];
    })(),
  },
  {
    id: 'three-body-pythagorean',
    label: 'Three-body (Pythagorean)',
    desc: 'Burrau / Pythagorean 3-body problem (1913): masses 3, 4, 5 (in solar-mass units, same scale as the binary preset) placed at the corners of a 3-4-5 right triangle and released from rest. After ~60 natural time units of chaotic close encounters, two of the bodies pair up as a tight binary and the third recedes. Open the inspector and watch the energy/momentum diagnostics stay rock-solid throughout.',
    multi: (() => {
      // Unit mass = one solar mass, matching the binary preset's per-body
      // mass exactly. The 3-4-5 mass ratio is intrinsic to the Pythagorean
      // problem, so the actual bodies weigh 3, 4, and 5 solar masses.
      const m_unit = 1.989e30;
      const L = 5.0e5;
      // 5-solar-mass body weak-field guard floor:
      //   r_min = 5 * G * m_unit / (WEAK_LIMIT * c^2) ~ 1.55e5 m.
      // Use 2.0e5 m so all three bodies share a single visually consistent
      // radius safely above the floor. This is larger than the figure-8's
      // body radius because the Pythagorean masses are 3-5x heavier.
      const radius = 2.0e5;
      const base = { charge: 0, spin: [0, 0, 0], v: [0, 0, 0], radius, allow_merger: false };
      return [
        // mass m_i sits at the vertex opposite the side of length i.
        { ...base, mass: 3 * m_unit, r: [  1 * L,  3 * L, 0] },
        { ...base, mass: 4 * m_unit, r: [ -2 * L, -1 * L, 0] },
        { ...base, mass: 5 * m_unit, r: [  1 * L, -1 * L, 0] },
      ];
    })(),
  },
  ],
},
{
  label: 'Charged bodies',
  presets: [
  {
    id: 'charged-light-pos',
    label: 'Charged (+, light)',
    desc: 'Asteroid-mass body (1e18 kg, 10 km radius) with q = +1e10 C. Like-sign repels, opposite-sign attracts. Coulomb force dominates gravity at this mass.',
    spec: {
      mass: M_LIGHT, charge: +Q_LIGHT, radius: R_LIGHT,
      r: [0, 0, 0], v: [0, 0, 0], spin: [0, 0, 0],
      allow_merger: false,
    },
  },
  {
    id: 'charged-light-neg',
    label: 'Charged (-, light)',
    desc: 'Asteroid-mass body (1e18 kg, 10 km radius) with q = -1e10 C. Opposite sign of the (+, light) preset.',
    spec: {
      mass: M_LIGHT, charge: -Q_LIGHT, radius: R_LIGHT,
      r: [0, 0, 0], v: [0, 0, 0], spin: [0, 0, 0],
      allow_merger: false,
    },
  },
  {
    id: 'charged-heavy-pos',
    label: 'Charged (+, heavy)',
    desc: 'Planet-class body (5.97e24 kg, 500 km radius) with q = +1.5e15 C. Strong-charge regime: |F_em| beats |F_grav| ~9x for like-sign heavy bodies.',
    spec: {
      mass: M_HEAVY, charge: +Q_HEAVY, radius: R_HEAVY,
      r: [0, 0, 0], v: [0, 0, 0], spin: [0, 0, 0],
      allow_merger: false,
    },
  },
  {
    id: 'charged-heavy-neg',
    label: 'Charged (-, heavy)',
    desc: 'Planet-class body (5.97e24 kg, 500 km radius) with q = -1.5e15 C. Opposite sign of the (+, heavy) preset.',
    spec: {
      mass: M_HEAVY, charge: -Q_HEAVY, radius: R_HEAVY,
      r: [0, 0, 0], v: [0, 0, 0], spin: [0, 0, 0],
      allow_merger: false,
    },
  },
  {
    id: 'charged-orbit',
    label: 'Charged orbit pair',
    desc: 'A heavy (+) and heavy (-) at 4000 km separation in a circular Coulomb+gravity orbit. EM provides ~90% of the centripetal force.',
    multi: (() => {
      const m = M_HEAVY;
      const q = Q_HEAVY;
      const R = 4.0e6;
      // For two equal-mass bodies orbiting their common centre at radius R/2:
      //   m v^2 / (R/2) = F_attract = (k q^2 + G m^2) / R^2
      //   => v = sqrt( (k q^2 + G m^2) / (2 m R) )
      const v = Math.sqrt((K_E * q * q + G * m * m) / (2 * m * R));
      return [
        { mass: m, charge: +q, radius: R_HEAVY, r: [-R/2, 0, 0], v: [0, 0, -v], spin: [0,0,0], allow_merger: false },
        { mass: m, charge: -q, radius: R_HEAVY, r: [+R/2, 0, 0], v: [0, 0, +v], spin: [0,0,0], allow_merger: false },
      ];
    })(),
  },
  ],
},
];

// Flat list (every preset, every section) for callers that want a single
// iterable -- e.g. persistence's "find preset by id".
export const PRESETS = PRESET_SECTIONS.flatMap((s) => s.presets);
