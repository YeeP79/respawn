import * as p from '@clack/prompts';
import chalk from 'chalk';
import type { Action, ActionResult, DiscoveredService, Environment } from '../config/types.js';
import { discoverServices } from '../utils/stack-discovery.js';
import { setVerbose } from '../utils/logger.js';
import { deploy } from './actions/deploy.js';
import { destroy } from './actions/destroy.js';
import { synth } from './actions/synth.js';
import { diff } from './actions/diff.js';
import { status } from './actions/status.js';
import { push } from './actions/push.js';
import { runSecrets } from './actions/secrets.js';


/** Top-level menu: the CDK actions plus the interactive-only Secrets flow. */
type MenuChoice = Action | 'secrets';

const ACTION_LABELS: Record<Action, string> = {
  deploy: 'Deploy — Build, push, and deploy game servers',
  push: 'Push — Build and push images to ECR (no deploy)',
  destroy: 'Destroy — Tear down game server infrastructure',
  synth: 'Synth — Preview CloudFormation templates',
  diff: 'Diff — Show pending infrastructure changes',
  status: 'Status — Check running game server status',
};

const MENU_LABELS: Record<MenuChoice, string> = {
  ...ACTION_LABELS,
  secrets: 'Secrets — Set or rotate secret values (Secrets Manager / SSM)',
};

const ACTION_HANDLERS: Record<
  Action,
  (ctx: {
    service: DiscoveredService;
    environment: Environment;
    workspaceRoot: string;
    verbose?: boolean;
    profile?: string;
    force?: boolean;
    gameEnvOverrides?: Record<string, string>;
  }) => Promise<ActionResult>
> = {
  deploy,
  destroy,
  synth,
  diff,
  status,
  push,
};

export async function runCli(options: {
  workspaceRoot: string;
  verbose?: boolean;
  profile?: string;
}): Promise<{ success: boolean }> {
  if (options.verbose) setVerbose(true);

  p.intro(chalk.bgCyan(' respawn — Game Server Deployment '));

  // Select action
  const action = await p.select<MenuChoice>({
    message: 'What would you like to do?',
    options: (Object.entries(MENU_LABELS) as [MenuChoice, string][]).map(
      ([value, label]) => ({ value, label }),
    ),
  });

  if (p.isCancel(action)) {
    p.cancel('Cancelled.');
    return { success: false };
  }

  // Secrets is environment-agnostic — handle it before the deploy-style flow.
  if (action === 'secrets') {
    const spin = p.spinner();
    spin.start('Discovering services...');
    // Env only affects CDK overrides, not SECRET_REFS; 'dev' is fine for discovery.
    const services = discoverServices(options.workspaceRoot, 'dev');
    spin.stop(`Found ${services.length} service${services.length === 1 ? '' : 's'}`);

    const result = await runSecrets({
      services,
      profile: options.profile,
    });
    if (result.success) {
      p.outro(chalk.green('Secrets updated.'));
    } else {
      p.outro(chalk.yellow('No secrets were updated.'));
    }
    return result;
  }

  // Select environment
  const environment = await p.select<Environment>({
    message: 'Target environment:',
    options: [
      { value: 'dev' as const, label: 'dev' },
      { value: 'staging' as const, label: 'staging' },
      { value: 'prod' as const, label: chalk.red('prod') },
    ],
  });

  if (p.isCancel(environment)) {
    p.cancel('Cancelled.');
    return { success: false };
  }

  // Discover services
  const spin = p.spinner();
  spin.start('Discovering services...');
  const discoveredServices = discoverServices(
    options.workspaceRoot,
    environment,
  );
  spin.stop(
    `Found ${discoveredServices.length} service${discoveredServices.length === 1 ? '' : 's'}`,
  );

  if (discoveredServices.length === 0) {
    p.log.warn(
      'No deployable services found. Ensure each service has both a Dockerfile and .env file.',
    );
    p.outro('Nothing to do.');
    return { success: false };
  }

  // Select services
  const selectedServiceNames = await p.multiselect<string>({
    message: 'Select services:',
    options: discoveredServices.map((svc) => ({
      value: svc.name,
      label: `${svc.name} ${chalk.gray(`(${svc.config.networking.protocol} :${svc.config.networking.containerPort})`)}`,
    })),
    required: true,
  });

  if (p.isCancel(selectedServiceNames)) {
    p.cancel('Cancelled.');
    return { success: false };
  }

  const selectedServices = discoveredServices.filter((svc) =>
    selectedServiceNames.includes(svc.name),
  );

  // Per-service deploy-time prompts (deploy action only). Answers are injected
  // as container env vars and threaded to the CDK app via context.
  const deployOverrides = new Map<string, Record<string, string>>();
  if (action === 'deploy') {
    for (const svc of selectedServices) {
      for (const prompt of svc.config.deployPrompts) {
        const answer = await p.select<string>({
          message: `[${svc.name}] ${prompt.envVar}:`,
          options: prompt.options.map((o) => ({ value: o, label: o })),
        });
        if (p.isCancel(answer)) {
          p.cancel('Cancelled.');
          return { success: false };
        }
        const existing = deployOverrides.get(svc.name) ?? {};
        existing[prompt.envVar] = answer;
        deployOverrides.set(svc.name, existing);
      }
    }
  }

  // Show summary
  p.log.info(chalk.bold('Summary:'));
  p.log.message(`  Action:      ${chalk.cyan(action)}`);
  p.log.message(
    `  Environment: ${environment === 'prod' ? chalk.red(environment) : chalk.green(environment)}`,
  );
  p.log.message(
    `  Services:    ${selectedServices.map((s) => s.name).join(', ')}`,
  );
  for (const [svcName, overrides] of deployOverrides) {
    const pairs = Object.entries(overrides)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    p.log.message(`  ${svcName} opts: ${chalk.cyan(pairs)}`);
  }

  const confirmed = await p.confirm({
    message: 'Proceed?',
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel('Cancelled.');
    return { success: false };
  }

  // Execute action for each service
  const results: ActionResult[] = [];
  const handler = ACTION_HANDLERS[action];

  for (const service of selectedServices) {
    const actionSpin = p.spinner();
    actionSpin.start(`${action} ${service.name}...`);

    const result = await handler({
      service,
      environment,
      workspaceRoot: options.workspaceRoot,
      verbose: options.verbose,
      profile: options.profile,
      gameEnvOverrides: deployOverrides.get(service.name),
    });

    results.push(result);

    if (result.success) {
      actionSpin.stop(chalk.green(`${service.name}: ${result.message}`));
    } else {
      actionSpin.stop(chalk.red(`${service.name}: ${result.message}`));
    }
  }

  // Summary
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  if (failed === 0) {
    p.outro(
      chalk.green(
        `All ${succeeded} service${succeeded === 1 ? '' : 's'} completed successfully.`,
      ),
    );
  } else {
    p.outro(
      chalk.yellow(
        `${succeeded} succeeded, ${failed} failed.`,
      ),
    );
  }

  return { success: failed === 0 };
}
