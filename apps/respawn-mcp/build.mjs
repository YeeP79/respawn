// Bundles the MCP into a single self-contained dist/index.js. The MCP ships as a
// `node dist/index.js` binary (see README / .mcp.json), so it cannot rely on the
// workspace's raw-TS package exports at runtime the way the tsx-run apps do — esbuild
// inlines @respawn/core (and its transitive libs) into one file. Run from the
// workspace root; esbuild is resolved from this package's own devDependency.
import { build } from 'esbuild';

await build({
  entryPoints: ['apps/respawn-mcp/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  outfile: 'apps/respawn-mcp/dist/index.js',
  // The shebang plus a createRequire shim: some bundled CJS dep does `require('fs')`,
  // and esbuild's ESM output uses the ambient `require` when one exists. Defining it
  // here turns the "Dynamic require not supported" throw into a working require.
  banner: {
    js: "#!/usr/bin/env node\nimport{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
  logLevel: 'warning',
});
