# AGENTS.md

Project-wide conventions for AI coding agents (Cursor, Claude Code,
Copilot, etc.) working in this repo. Read this *before* every
non-trivial change. Human contributors should also read it — the
conventions are the same.

## Read these first

- `README.md` — what the project is.
- `ARCHITECTURE.md` — why it's built the way it is.
- `CONTRIBUTING.md` — coding standards and PR expectations.

## The single most important rule

**Never silently change a physical constant or formula.**

The constants in `wasm/src/constants.rs` and the field expressions in
`wasm/src/physics.rs` are checked against tests that pin the closed-form
Wikipedia / textbook expressions. If you change either:

1. Update the test(s) that pin the new value *in the same change*.
2. Add a comment near the constant explaining the convention and the
   reference (Wikipedia article + section heading, or paper DOI).
3. Run `npm run test:wasm` and confirm all 24+ tests still pass.

The previous K_BG halving (commit history) is the template — short
constant change, large explanatory comment, two updated tests.

## Strict-f64 rule

- All physics math in Rust is `f64`. No `f32` in `wasm/src/`.
- All physics math on the JavaScript side uses `Number` (which is
  f64). No use of `Float32Array` for physics quantities. The grid and
  renderer use `Float32Array` only for GPU upload, *after* the
  values have been log-scaled or geometrically reduced.
- Never apply a numerical multiplier to `G`, `c`, `eps0`, `mu0` to
  "make it visible". Use log-scaled visualisations in the renderer
  instead.

## What an agent is allowed to do without asking

- Refactor for readability (variable names, function splits, comment
  cleanup).
- Add new tests pinning existing behaviour.
- Add new presets to `src/presets.js`.
- Improve renderer visuals if and only if the new visual degrades
  cleanly to "off" with a UI toggle.
- Fix typos, broken links, formatting issues.

## What an agent should ask about first

- Adding a new dependency (Rust crate or NPM package).
- Changing the build pipeline (`vite.config.js`, `wasm/Cargo.toml`
  profiles, GitHub Actions workflow).
- Removing a feature, even a visual one. Many features in here exist
  because a user explicitly requested them.
- Changing the SCENE_SCALE, lattice topology, or any UI default.

## Style notes that are easy to forget

- Comments explain *why*, not *what*. Delete narration comments before
  committing.
- Prefer `Math.hypot(a, b, c)` to `Math.sqrt(a*a + b*b + c*c)`
  *outside* hot loops; inside hot loops the manual form is faster.
- Hot loops in `grid.js` and `renderer.js` should not allocate. Reuse
  the scratch typed arrays that are already in place.
- Tests in `wasm/src/tests.rs` must not depend on numerical literals
  whose origin isn't obvious. Use named constants (`G`, `C`, `K_E`, ...)
  and closed-form combinations.

## When the user asks "is X implemented correctly?"

Default to *checking the code*, not your memory. The physics
conventions in this repo are unusual (Mashhoon GEM with Wikipedia
scaling, not the EM-analog substitution with c² factor), so trust the
tests and the in-code comments over textbook recall.

If a Wikipedia link is provided, read it; treat its equations as
ground truth unless explicitly contradicted by a citation in the code.

## File-specific notes

- `wasm/src/physics.rs` — the comment block at the top encodes the
  EM → GEM substitution table. Edit that block whenever you change a
  prefactor.
- `src/grid.js` — the per-vertex displacement loop is the project's
  performance hotspot. Be careful adding work to it.
- `src/main.js` — the animation loop is the orchestrator. Any new
  per-frame computation belongs here, not inside `setInterval`/`setTimeout`.
- `src/scale.js` — single source of truth for the metres-per-visual-unit
  conversion. Do not duplicate this constant anywhere else.

## When in doubt

Ask the user. The cost of asking a clarifying question is much lower
than the cost of silently breaking a physics invariant.
