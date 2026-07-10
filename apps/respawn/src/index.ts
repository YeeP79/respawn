// The respawn app is now the CDK synthesis target only (constructs, stacks, bin/app.ts).
// Shared config/types live in @respawn/core; the CLI is @respawn/cli. Re-export the core
// types here for any consumer that imported them from this package historically.
export type {
  GameServerConfig,
  Environment,
  DiscoveredService,
  ActionResult,
} from '@respawn/core';
