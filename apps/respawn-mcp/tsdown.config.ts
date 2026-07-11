import { defineConfig } from 'tsdown';

// The MCP ships as a `node dist/index.mjs` binary, so it cannot consume the workspace's
// raw-TS `src` exports at runtime the way the tsx-run apps do. tsdown (rolldown) bundles
// the @respawn/* workspace graph inline — including their CJS transitive deps (dotenv),
// which rolldown's interop handles without the createRequire banner the old esbuild build
// needed. Only the MCP's own registry deps (@modelcontextprotocol/sdk, zod) stay external.
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
