#!/usr/bin/env node
import { logger, setVerbose } from '@respawn/core';
import { parseCliArgs } from './args.js';
import { runBatch } from './batch.js';
import { runSecretsBatch } from './actions/secrets.js';
import { runCli } from './menu.js';

/** Reads all of stdin (a piped secret value), stripped of a single trailing newline so
 *  `echo "$V" | …` works. Returns '' when stdin is a TTY (nothing piped). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2), process.cwd());

  if (args.verbose) setVerbose(true);
  // Make the profile/region visible to any child (aws/cdk) that reads the environment,
  // in addition to threading them through explicitly. This is the job the retired nx
  // executor used to do.
  if (args.profile) process.env['AWS_PROFILE'] = args.profile;
  if (args.region) process.env['AWS_REGION'] = args.region;

  if (!args.interactive) {
    if (!args.action) {
      logger.error('Non-interactive mode requires --action.');
      process.exit(1);
    }

    // Secrets is environment-agnostic and takes its value on stdin (never argv, so it
    // stays out of the process list / shell history).
    if (args.action === 'secrets') {
      if (!args.service || !args.secret) {
        logger.error(
          'Non-interactive secrets requires --service and --secret; pipe the value on stdin: ' +
            'echo -n "$VALUE" | respawn --non-interactive --action secrets --service <svc> --secret <NAME>',
        );
        process.exit(1);
      }
      const value = await readStdin();
      if (value.length === 0) {
        logger.error('No secret value on stdin. Pipe it: echo -n "$VALUE" | respawn … --action secrets …');
        process.exit(1);
      }
      const code = await runSecretsBatch({
        workspaceRoot: args.workspaceRoot,
        service: args.service,
        secret: args.secret,
        value,
        ...(args.profile ? { profile: args.profile } : {}),
      });
      process.exit(code);
    }

    if (!args.environment || !args.service) {
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
      ...(args.count !== undefined ? { desiredCount: args.count } : {}),
      ...(args.gameEnv ? { gameEnvOverrides: args.gameEnv } : {}),
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
