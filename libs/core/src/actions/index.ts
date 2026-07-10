// Headless action cores — orchestration only, no terminal UI. A front-end (the CLI,
// the MCP) supplies the presentation. `destroy` never prompts and `status` returns
// structured data; their UI (prod confirmation, formatting) lives in the caller.
export * from './deploy.js';
export * from './destroy.js';
export * from './diff.js';
export * from './synth.js';
export * from './status.js';
export * from './push.js';
export * from './updates.js';
