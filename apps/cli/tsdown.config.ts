import { defineConfig } from 'tsdown';

// Same pattern as the MCP: bundle the @respawn/* workspace graph inline so the built
// `dist/index.mjs` bin is self-contained. The entry keeps its `#!/usr/bin/env node`
// shebang (rolldown preserves it). Registry deps (@clack/prompts, chalk) stay external.
// Dev runs skip this build entirely — `tsx --conditions development` reads the libs' src.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  target: 'node24',
  outDir: 'dist',
  sourcemap: true,
  dts: false,
  deps: {
    alwaysBundle: [/^@respawn\//],
  },
});
