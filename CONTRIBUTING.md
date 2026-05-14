# Contributing

Thanks for your interest. This project has an unusual amount of opinion
baked into its physics layer; please read this before opening a PR.

## Ground rules (the non-negotiable kind)

1. **SI everywhere.** No "natural units", no "rescaled constants",
   nothing factored out for convenience. Numerical magnitude is the
   *point* — we want the user's intuition about real-world masses,
   distances, charges to translate directly to the simulation.
2. **`f64` in every physics path.** Rust `f64`, JavaScript `Number`,
   WASM memory exposed as `Float64Array`. The only place `f32` is
   allowed is in GPU shaders, and only after the small numbers have
   been log-transformed or scaled on the CPU.
3. **No snapshot tests against numerical magnitudes.** Every test must
   pin a *property*: a closed-form expression, a conservation law, an
   orientation, a sign. Writing `assert!(force ≈ 1.234e-7)` is
   *forbidden* — what is being asserted there? The next refactor will
   change the literal and pass without anyone noticing the physics has
   silently shifted. Write `assert!(force == G * m₁ * m₂ / r²)`
   instead.
4. **Never silently change a constant.** If you change anything in
   `wasm/src/constants.rs`, you must update the test(s) that pin the
   new value *in the same PR*, with a comment in the constant
   explaining why the change is correct. See the K_BG halving in
   commit history for the template.
5. **The weak-field guard is sacred.** GEM is a weak-field
   approximation. Spawn requests with `GM/(rc²) ≥ 0.05` are rejected at
   the door. Do not relax this without rewriting the engine to use
   actual GR.

## Code style

### Rust

- `cargo fmt` before pushing.
- `cargo clippy --release -- -D warnings`.
- No `unwrap()`/`expect()` in the dynamics path. The retarded-state
  lookup explicitly returns `Option<State>`; respect that.
- Doc comments on every public function explain the *physics*, not just
  the signature.

### JavaScript

- We don't have ESLint configured (yet). For now: prefer `const`, use
  arrow functions, single source of truth for any value referenced in
  more than one place.
- Comments explain *why*, never *what*. `// increment i` is forbidden.
  `// see ARCHITECTURE.md "Strict-f64 in the GPU shader"` is welcomed.
- The renderer is performance-sensitive: hot loops should avoid
  allocating `Vector3` / `Matrix4` instances. Use the per-vertex scratch
  arrays already in place (`grid.js`, `renderer.js`).

## Adding a feature

A typical "I want to add foo" PR looks like:

1. Decide whether it's a physics change (`wasm/`) or a renderer change (`src/`).
2. If physics: write the test *first*. Pin the closed-form expression
   you expect. Then implement until the test passes.
3. If renderer: add the visual on a feature flag (UI toggle). It must
   degrade to "no-op" when off, with no perf cost.
4. Update `README.md` and `ARCHITECTURE.md` if the change is
   user-visible or architectural.

## Adding a physics test

Tests live in `wasm/src/tests.rs`. Run them with `npm run test:wasm`
(release mode — debug mode has noticeable f64 rounding differences in
the deep retarded-time iterations).

Good test style:

```rust
#[test]
fn name_says_what_property_is_being_tested() {
    // Setup: two bodies with carefully-chosen parameters.
    let mut w = World::new(8, 1.0e-3);
    // ... spawn ...

    // Compute the property using both the engine *and* a closed-form
    // (or property-based) expression.
    let measured = w.do_a_thing();
    let expected_closed_form = G * m / (r * r);

    // Compare with a tolerance that reflects the integrator's error
    // budget, not the literal float precision.
    assert!(approx(measured, expected_closed_form, 1.0e-9));
}
```

## Reporting bugs

For physics bugs, please include:

- The preset (or full custom-particle parameters) that triggers it.
- What you expected to see and a reference (textbook page, Wikipedia
  section, paper DOI).
- A screenshot or short video if it's a visualisation bug.

For renderer / UI bugs:

- Browser + version.
- A console-log dump.
- Steps to reproduce starting from a fresh tab.

## Code of conduct

Be excellent. Be specific. Stay on topic. Don't pick fights about the
GEM sign conventions — every textbook does them differently, ours
matches Wikipedia, that's the tiebreaker.
