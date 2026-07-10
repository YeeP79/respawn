#!/usr/bin/env node
import { logger, setVerbose } from '@respawn/core';
import { parseCliArgs } from './args.js';
import { runBatch } from './batch.js';
import { runCli } from './menu.js';

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2), process.cwd());

  if (args.verbose) setVerbose(true);
  // Make the profile/region visible to any child (aws/cdk) that reads the environment,
  // in addition to threading them through explicitly. This is the job the retired nx
  // executor used to do.
  if (args.profile) process.env['AWS_PROFILE'] = args.profile;
  if (args.region) process.env['AWS_REGION'] = args.region;

  if (!args.interactive) {
    if (!args.action || !args.environment || !args.service) {
      logger.error('Non-interactive mode requires --action, --environment and --service.');
      process.exit(1);
    }
    const code = await runBatch({
      action: args.action,
      environment: args.environment,
      service: args.service,
      workspaceRoot: args.workspaceRoot,
      verbose: args.verbose,
      force: args.force,
      forceBuild: args.forceBuild,
      requireImage: args.requireImage,
      record: args.record,
      dryRun: args.dryRun,
      ...(args.requireApproval ? { requireApproval: args.requireApproval } : {}),
      ...(args.profile ? { profile: args.profile } : {}),
    });
    process.exit(code);
  }

  const result = await runCli({
    workspaceRoot: args.workspaceRoot,
    verbose: args.verbose,
    ...(args.profile ? { profile: args.profile } : {}),
  });
  process.exit(result.success ? 0 : 1);
}

main().catch((err: unknown) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
