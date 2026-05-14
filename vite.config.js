import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the production build works both at a domain root and
  // under a sub-path like `https://lisenkaci.github.io/PlayGR/` (GitHub Pages).
  base: './',
  server: {
    fs: {
      // Allow Vite to serve files from the wasm-pack output directory, which lives
      // outside the default project root structure.
      allow: ['..'],
    },
  },
  optimizeDeps: {
    // wasm-pack output is an ES module that does its own fetch() of the .wasm file.
    // Excluding it from Vite's dep-pre-bundling keeps the fetch path correct in dev.
    exclude: ['./wasm/pkg/spacetime_sandbox.js'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
