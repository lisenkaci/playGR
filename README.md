# Relativistic Spacetime Sandbox

A browser-based playground that simulates **Maxwell's equations** and **Extended Gravitoelectromagnetism (GEM)** with **Jefimenko / Liénard–Wiechert retarded potentials**, in strict 64-bit floating-point — with no cheating on the physical constants.

**Live demo:** <https://lisenkaci.github.io/playGR/>

> **Status**: open source, MIT licensed, contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and [ARCHITECTURE.md](ARCHITECTURE.md) before opening a PR.

<p align="center">
  <video src="./docs/playGRDemo.mp4" width="640" controls autoplay loop muted playsinline>
    Demo video — your browser does not support inline playback. <a href="./docs/playGRDemo.mp4">Download playGRDemo.mp4</a>.
  </video>
</p>

<p align="center">
  <em>A binary system warps the wireframe lattice while spacetime-river streamlines flow into the wells; the right-hand panel shows the simulation and visualisation controls.</em>
</p>

## What it does

- Spawns charged and massive bodies (presets ranging from "neutral asteroid" through "Kerr-like spinning solar mass" — see [`src/presets.js`](src/presets.js)).
- Solves the relativistic equations of motion under Maxwell + GEM with **retarded-time** field propagation. The engine knows about light-travel delay, so it can radiate, and it can drag space.
- Renders a **3D deformable lattice** representing the local gravitoelectric *and* gravitomagnetic (frame-dragging) field. Pulses flow along the lattice toward gravity wells and spiral around spinning bodies.
- Lets you drag bodies around, scrub the simulation, resize the lattice by dragging its corners, and tune the cell density with a slider.

## The "no cheating" philosophy

The constants are the SI values:

| Constant            | Symbol | Value                          |
| ------------------- | ------ | ------------------------------ |
| Gravitational       | `G`    | `6.67430e-11 m^3 kg^-1 s^-2`   |
| Speed of light      | `c`    | `2.99792458e8 m s^-1`          |
| Vacuum permittivity | `eps0` | `8.8541878128e-12 F m^-1`      |
| Vacuum permeability | `mu0`  | `1.25663706212e-6 N A^-2`      |

There are no multipliers on `G`, `c`, `eps0`, or `mu0`. If you want to twist spacetime visibly, you must build a "motor" out of neutron-star-density mass with relativistic rotation — exactly as in real physics.

## Architecture, in one diagram

```
       UI controls -> physicsBridge.js -> Rust/WASM World
                                            |
                                            v
                                  Float64Array (zero copy)
                                            |
                                            v
                                       Three.js scene
                            (deformable 3D lattice, jets, pulses)
```

- **Physics core**: `wasm/` — a pure-Rust crate with `f64` math, fixed-size ring buffers per particle, retarded-potential Liénard–Wiechert evaluators for both EM and GEM, a relativistic Velocity-Verlet integrator that keeps state as relativistic momentum `p = γ m₀ v`, and hard-sphere collision resolution.
- **Renderer**: `src/` — Vite + Three.js. The "spacetime" is a 3D wireframe lattice whose vertex positions are displaced on the CPU each frame by the Newtonian potential (radial component) *and* the gravitomagnetic vector potential `A_g` (tangential, frame-dragging). Pulses are added on top to visualise the flow direction. The GPU only does the view/projection — all the small-number arithmetic stays in JS `Number` (f64).

For why each of these decisions was made, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Build

You need:

- Rust (stable) with the `wasm32-unknown-unknown` target
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/)
- Node.js >= 18

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

npm install
npm run dev
```

**macOS note**: if you have full Xcode installed but have never accepted its
licence, the Rust build script proc-macros will fail to link with `cc`. The
workaround is to point at the Command-Line Tools directly:

```sh
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
```

(Or alternatively run `sudo xcodebuild -license accept` once.)

Then open the URL Vite prints (typically `http://localhost:5173`).

For a production build:

```sh
npm run build
npm run preview
```

For the Rust test suite (conservation laws, Liénard–Wiechert closed-form match, Kepler orbit, GEM dipole, frame dragging, K_BG / Wikipedia agreement):

```sh
npm run test:wasm
```

## The physics, in one page

For every particle `A` and every other particle `B`, the engine solves for the **retarded time** `t_ret` such that

```
|r_A(t_now) - r_B(t_ret)| = c * (t_now - t_ret)
```

with a 4-step Newton iteration against B's history ring buffer, and **linearly interpolates** B's state between the two nearest stored frames.

From the retarded state `(r_ret, v_ret, a_ret, m, q, S)` of B, we compute:

- **EM Liénard–Wiechert** `E`, `B` fields from B's charge `q` and (if spinning) its magnetic-dipole moment.
- **GEM Liénard–Wiechert** `E_g`, `B_g` from B's mass `m` and its gravitomagnetic-dipole moment derived from spin angular momentum `S`. Uses the substitution `1/(4π ε₀) → -G` for the electric leg and `μ₀/(4π) → -G/(2c²)` for the magnetic leg. The factor of `1/2` on the magnetic leg is the Mashhoon / Wikipedia GEM convention; see [`wasm/src/constants.rs`](wasm/src/constants.rs).

The Lorentz force on A is:

```
F_total = q (E + v x B) + m (E_g + 4 v x B_g)
```

The factor of 4 on `B_g` is the Extended-GEM convention (Mashhoon), not a bug — it's the price for matching the GR weak-field geodesic equation.

The integrator updates relativistic momentum `p = γ m₀ v`, and recovers velocity via

```
v = p c² / sqrt(p² c² + m₀² c⁴)
```

which is numerically safe near `c`.

## Guardrails

1. **Weak-field guard** on spawn: any particle with `G m / (r c²) >= 0.05` is rejected. GEM is a weak-field approximation; this is exactly the line where it stops being trustworthy.
2. **Distance clamp**: before evaluating any `1 / rⁿ` term, `r` is clamped to `max(r_min_A + r_min_B, 1 cm)` to keep the math finite.
3. **Hard-sphere collisions**: when two particles' spheres overlap, the engine resolves the collision (elastic bounce by default, optional volume-conserving merger if both objects have `allow_merger = true`) *before* the field evaluation runs for that substep.
4. **Soft acceleration cap**: applied above `0.9 c` so a single bad substep cannot push `γ` past the `f64` headroom.
5. **NaN sentinel**: after each substep, the engine scans for non-finite state and snaps the offending particle back to its last known good ring-buffer entry.

## Why this is hard, briefly

The ratio `G / c² ≈ 7.4e-28` is so small that 32-bit floats round gravitomagnetism to zero. The engine is therefore strict `f64` end-to-end: in Rust, in the WASM memory exposed to JavaScript, and in the `Float64Array` views the renderer reads from. The GPU shaders use 32-bit floats (the GPU has no choice), but every small-number computation finishes on the CPU before crossing into shader-land. See [ARCHITECTURE.md](ARCHITECTURE.md) for the gory details.

## File map

```
playGR/
  index.html
  package.json
  vite.config.js
  README.md
  ARCHITECTURE.md
  CONTRIBUTING.md
  AGENTS.md
  LICENSE
  src/
    main.js              entry: boot WASM, renderer, UI, animation loop
    physicsBridge.js     wraps wasm-bindgen exports, typed-array views
    renderer.js          Three.js scene/camera/lights
    grid.js              deformable spacetime mesh (radial + frame-drag)
    jets.js              gravitomagnetic-jet visuals
    interaction.js       drag-and-drop, click-to-spawn, corner-resize
    ui.js                control panel
    scale.js             SCENE_SCALE constants and visual-radius mapping
    presets.js           preset particles (asteroid, motor, spinning solar, ...)
    persistence.js       save/load scene JSON
    debug.js             force-vector overlay
    styles.css
  wasm/
    Cargo.toml
    src/
      lib.rs             wasm_bindgen World API
      constants.rs       SI constants and derived (K_EG, K_BG, ...)
      vec3.rs            f64 vector math
      ring_buffer.rs     fixed-capacity history buffer
      particle.rs        Particle + historical State
      integrator.rs      relativistic Velocity-Verlet
      physics.rs         retarded EM/GEM field evaluators
      collisions.rs      clamp, elastic bounce, optional merger
      world.rs           World driver
      tests.rs           closed-form / conservation / frame-drag tests
```

## What this is *not*

- A general-relativistic solver. We use linearised GEM. No perihelion
  precession, no photon-sphere geodesics, no black holes (spawn requests
  with `GM/rc² ≥ 0.05` are refused).
- A particle-physics simulator. Don't try to spawn single electrons — see
  the rationale in [`src/presets.js`](src/presets.js).
- A Hamiltonian integrator that conserves energy to machine precision
  over millions of orbits. Velocity-Verlet drifts; we just have a
  sentinel for catastrophes.

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgements

- The Wikipedia [Gravitoelectromagnetism](https://en.wikipedia.org/wiki/Gravitoelectromagnetism) article is the canonical reference for our GEM conventions.
- Bahram Mashhoon's GEM review papers (arXiv 0011014 / 0311030) for the factor-of-4 Lorentz coupling that we use.
- Jefimenko's *Causality, Electromagnetic Induction, and Gravitation* for the form of the retarded-potential field expressions.
