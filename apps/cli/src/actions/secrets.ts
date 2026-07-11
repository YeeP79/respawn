import * as p from '@clack/prompts';
import chalk from 'chalk';
import type { DiscoveredService } from '@respawn/core';
import { discoverServices, logger, setSecret } from '@respawn/core';

export interface SecretsContext {
  services: DiscoveredService[];
  profile?: string;
}

/**
 * Non-interactive counterpart to {@link runSecrets}: sets one declared secret from a
 * value the caller already read off stdin (never argv). Returns a process exit code.
 * Discovery is env-agnostic — SECRET_REFS do not vary by environment — so 'dev' is used.
 */
export async function runSecretsBatch(opts: {
  workspaceRoot: string;
  service: string;
  secret: string;
  value: string;
  profile?: string;
}): Promise<number> {
  const services = discoverServices(opts.workspaceRoot, 'dev');
  const service = services.find((s) => s.name === opts.service);
  if (!service) {
    logger.error(
      `Service "${opts.service}" not found. Available: ${services.map((s) => s.name).join(', ') || '(none)'}`,
    );
    return 1;
  }

  const ref = service.config.secretRefs.find((r) => r.containerEnvVar === opts.secret);
  if (!ref) {
    const declared = service.config.secretRefs.map((r) => r.containerEnvVar).join(', ') || '(none)';
    logger.error(`Service "${opts.service}" declares no secret "${opts.secret}". Declared: ${declared}`);
    return 1;
  }

  try {
    await setSecret({
      store: ref.store,
      sourceId: ref.sourceId,
      value: opts.value,
      region: service.config.aws.region,
      profile: opts.profile ?? service.config.aws.profile,
    });
    logger.info(`Stored ${ref.store}:${ref.sourceId} (${opts.service}/${opts.secret})`);
    return 0;
  } catch (err) {
    logger.error(
      `Failed to set ${ref.store}:${ref.sourceId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
}

/**
 * Interactive flow to set/rotate the secret values a service declares via
 * SECRET_REFS. Values are entered with masked input and written straight to
 * Secrets Manager / SSM — never echoed, logged, or persisted to `.env`.
 */
export async function runSecrets(
  ctx: SecretsContext,
): Promise<{ success: boolean }> {
  const withSecrets = ctx.services.filter(
    (s) => s.config.secretRefs.length > 0,
  );

  if (withSecrets.length === 0) {
    p.log.warn(
      'No services declare SECRET_REFS. Add refs to a service .env first (see AGENT_PROMPT.md §7).',
    );
    return { success: false };
  }

  const serviceName = await p.select<string>({
    message: 'Set secrets for which service?',
    options: withSecrets.map((s) => ({ value: s.name, label: s.name })),
  });
  if (p.isCancel(serviceName)) {
    p.cancel('Cancelled.');
    return { success: false };
  }
  const service = withSecrets.find((s) => s.name === serviceName)!;

  const selectedVars = await p.multiselect<string>({
    message: 'Which secrets to set/rotate?',
    options: service.config.secretRefs.map((r) => ({
      value: r.containerEnvVar,
      label: `${r.containerEnvVar} ${chalk.gray(`(${r.store}:${r.sourceId})`)}`,
    })),
    required: true,
  });
  if (p.isCancel(selectedVars)) {
    p.cancel('Cancelled.');
    return { success: false };
  }

  const region = service.config.aws.region;
  const profile = ctx.profile ?? service.config.aws.profile;

  let failures = 0;
  for (const envVar of selectedVars) {
    const ref = service.config.secretRefs.find(
      (r) => r.containerEnvVar === envVar,
    )!;

    const value = await p.password({
      message: `Value for ${ref.containerEnvVar} (${ref.store}:${ref.sourceId}):`,
      validate: (v) => (v.length === 0 ? 'Value cannot be empty.' : undefined),
    });
    if (p.isCancel(value)) {
      p.cancel('Cancelled.');
      return { success: false };
    }

    const spin = p.spinner();
    spin.start(`Storing ${ref.store}:${ref.sourceId}...`);
    try {
      await setSecret({
        store: ref.store,
        sourceId: ref.sourceId,
        value,
        region,
        profile,
      });
      spin.stop(chalk.green(`Stored ${ref.store}:${ref.sourceId}`));
    } catch (err) {
      failures++;
      spin.stop(
        chalk.red(
          `Failed ${ref.store}:${ref.sourceId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  return { success: failures === 0 };
}
