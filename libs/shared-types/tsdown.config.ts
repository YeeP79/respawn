import { defineConfig } from 'tsdown';

// Build to dist so `node`-run consumers (the MCP binary) can import built JS instead of
// the raw-TS `src` exports only tsx can read. npm/workspace deps stay external — the app
// bundles that resolve this lib inline it via their own tsdown `alwaysBundle`.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  target: 'node24',
  outDir: 'dist',
  sourcemap: true,
  dts: false,
});
