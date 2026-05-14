# Architecture

This document explains the *why* behind the design choices that distinguish
this project from the dozens of other "spacetime visualisers" on the web.
The README covers the *what*; here we cover the rationale.

## Goal

A browser-based playground that simulates **Maxwell + Extended GEM** with
**Liénard–Wiechert / Jefimenko retarded potentials**, **without cheating on the
physical constants**, and that still runs at interactive framerates.

The non-negotiable constraints:

1. The constants `G`, `c`, `eps0`, `mu0` are the SI values. No multipliers.
2. The dynamics path is `f64` end-to-end. No `f32` shortcuts on the small
   numbers (`G/c² ≈ 7.4·10⁻²⁸`).
3. The simulation runs in the browser, so the budget is "a few hundred
   particles, 60 fps, on a modest laptop".

Everything below follows from these constraints.

## Why Rust + WASM

JavaScript's `Number` is f64, so in principle you could write the whole
engine in JS and stay in f64. The problem is *performance*: the per-step
work is dominated by `O(N²)` retarded-time Newton iterations, and the JIT
isn't reliable enough at squeezing branchy floating-point loops to hit 60
fps with N in the hundreds. Rust compiled to WASM is roughly 3–5× faster
than equivalent JS in our profiling and — crucially — has predictable cost.
We use `wasm-bindgen` for the FFI and expose particle state as a flat
`Float64Array` view into linear memory, so the JS side reads it zero-copy.

## Why retarded potentials, not post-Newtonian

GR is the right model, but a full GR solver is way out of budget for the
browser. The next-best thing is the **linearised** weak-field limit, which
factors into:

- The Newtonian-limit `1/r²` term (`E_g` in GEM).
- The relativistic propagation delay, which produces Liénard–Wiechert-style
  fields whose finite `c` makes gravity *radiate* and *drag*.

Once you write down the Liénard–Wiechert form of the GEM fields, it's
algebraically identical to the EM Liénard–Wiechert form modulo the
substitution `1/(4π·ε₀) → -G` for the electric/gravitoelectric leg and
`μ₀/(4π) → -G/(2c²)` for the magnetic/gravitomagnetic leg. So one
implementation handles both, with the gravito-electromagnetic prefactor
just being a configurable constant. See `wasm/src/physics.rs::fields_from_source`.

The factor of `1/2` in the gravitomagnetic prefactor (and the factor of `4`
in the Lorentz-force coupling) is the standard Mashhoon convention used
throughout the GEM literature, and matches the
[Wikipedia GEM table](https://en.wikipedia.org/wiki/Gravitoelectromagnetism#Equations).

## Strict-f64 in the GPU shader (or not)

The lattice grid is a 3D wireframe that gets re-deformed every frame. We
*do not* sample `Φ` on the GPU — the GPU has no `f64` and the small-number
arithmetic for `Φ/c²` would round to zero. Instead, the JS side computes
the deformed vertex positions in `f64` *on the CPU*, writes them into a
typed array, and uploads them as `BufferAttribute`. The GPU does only the
view/projection transforms, which are well-conditioned in `f32`.

This pattern repeats anywhere the GEM small numbers appear: keep them on
the CPU, ship only the visually-scaled, log-transformed results to the GPU.

## Why a separate JS-side potential sampler

`wasm/src/physics.rs::newtonian_potential_at` is the *authoritative*
Newtonian potential. The renderer's grid would, in principle, call it
through `physicsBridge.newtonianPotentials()` for every vertex. Right now
the bridge has a JS-side reimplementation that reads the particle snapshot
directly. This is a known duplication — see issue tracker — and is in
place because we don't yet have a clean way to pass thousands of points
into WASM without an allocator round-trip. Both functions use the same
uniform-sphere closed-form formula (`-GM/r` outside, smoothly continuous
to `-GM(3 − r²/R²)/(2R)` inside) and are pinned together by the Rust test
`newtonian_potential_sum`.

If you change either one, you **must** keep the formula byte-equivalent.

## Why a deformable lattice as the spacetime visual

Most popular "spacetime" demos use a 2D rubber-sheet plane bent by gravity.
That's misleading: spacetime is 3+1D, and the 2D bowl only shows the
*static* `g₀₀` curvature. We render a full 3D lattice in which each vertex
displaces along the gravitational gradient (radial) *and* along the
gravitomagnetic vector potential `A_g` (tangential, frame-dragging). This
lets the user *see* both gravito-electric and gravito-magnetic effects at
once.

The displacements are logarithmically scaled because the physical
displacement at SI scales would be invisible (`A_g` is tens of microns/sec
for terrestrial-scale spinning masses). We trade physical magnitudes for
log-uniform visibility; the *directions* and *signs* are exact.

## Why no symplectic integrator

Velocity-Verlet with relativistic momentum is good enough for a *display*
simulator. Symplectic integrators matter when you're integrating for
thousands of orbits and care about long-term energy drift. Our use cases
are tens of seconds of physical time at most, and we have a NaN-sentinel
that catches catastrophic blowups. The Kepler-energy test demonstrates
energy drift below `1e-4` over `1/8` of an orbit, which is fine for the
intended use.

## Coordinate system & units

Everything in `wasm/` is SI metres, seconds, kilograms, coulombs, amperes.
Everything in `src/` is *also* SI internally, with one conversion at the
rendering boundary: `SCENE_SCALE_M_PER_UNIT = 1e5` (i.e. one Three.js unit
= 100 km). The lattice uses *visual units* throughout to keep
`f32`-rendered geometry well-conditioned; the *physics-driven* values
(forces, fields) cross the boundary by dividing by this constant.

The visual radius of each body is approximately the physical radius
divided by the scene scale, with a small floor (so an asteroid is still
clickable) and a ceiling (so a 7000-km planet doesn't engulf the entire
scene). Both bounds are configurable in `src/scale.js`.

## What we do not simulate

To set expectations:

- **No gravitational radiation back-reaction**: the engine knows about
  radiation fields (`1/R` terms in the Liénard–Wiechert form), so it can
  *radiate*, but it does not subtract the radiated energy from the
  source's kinetic energy. Energy conservation drifts on the order of
  `(v/c)⁵` per orbit, in line with the quadrupole formula.
- **No strong-field corrections**: spawn requests with `GM/(rc²) ≥ 0.05`
  are rejected at the door. You cannot build a black hole.
- **No quantum effects**: this is a classical-field sandbox.
- **No general curvature**: GEM is a *linearised* weak-field theory. We
  give you frame dragging and gravitational radiation, not perihelion
  precession of Mercury or photon-sphere geodesics.

## Performance notes

The hot loop is `O(N²)` retarded-source evaluations per substep. The
dominant cost is the Newton iteration on `t_ret` (4 iterations × FMA
loop). With N=20 bodies and dt=1ms, this is well below 1 ms/frame on a
laptop, leaving most of the frame budget for the grid update (which is
itself `O(verts × N)` and is the *other* dominant cost when the grid
density is cranked up).

If you want to push to N > 100, the right move is either a Barnes–Hut
tree on the retarded sources or a physics worker thread sharing a
`SharedArrayBuffer` with the renderer. Both are reasonable starting
points for a PR — open an issue first to coordinate the approach.
