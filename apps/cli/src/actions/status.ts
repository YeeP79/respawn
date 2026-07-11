import chalk from 'chalk';
import type { ActionResult, DiscoveredService, Environment, ServiceStatus } from '@respawn/core';
import { fetchServiceStatus, logger } from '@respawn/core';

export interface StatusContext {
  service: DiscoveredService;
  environment: Environment;
  workspaceRoot: string;
  verbose?: boolean;
  profile?: string;
}

/** Renders a service's status as a single coloured terminal line. Pure — unit-tested. */
export function formatServiceStatus(s: ServiceStatus): string {
  if (s.state === 'not-deployed') {
    return chalk.yellow(`  ${s.service}: Not deployed in ${s.environment}`);
  }
  if (s.state === 'not-found') {
    return chalk.yellow(`  ${s.service}: Not found in ${s.environment}`);
  }
  const line = [
    chalk.bold(s.service),
    chalk.gray('|'),
    `Status: ${s.status === 'ACTIVE' ? chalk.green(s.status) : chalk.yellow(s.status ?? '?')}`,
    chalk.gray('|'),
    `Tasks: ${s.runningCount}/${s.desiredCount}`,
    chalk.gray('|'),
    `Last deploy: ${s.lastDeploy ?? 'N/A'}`,
  ].join(' ');
  return `  ${line}`;
}

/** One-line summary for the ActionResult message. */
export function summariseServiceStatus(s: ServiceStatus): string {
  if (s.state === 'not-deployed') return 'Not deployed';
  if (s.state === 'not-found') return 'Not found';
  return `${s.status} (${s.runningCount}/${s.desiredCount} tasks)`;
}

export async function status(ctx: StatusContext): Promise<ActionResult> {
  const start = Date.now();
  try {
    const s = await fetchServiceStatus({
      service: ctx.service,
      environment: ctx.environment,
      ...(ctx.profile ? { profile: ctx.profile } : {}),
    });
    console.log(formatServiceStatus(s));
    return {
      success: true,
      serviceName: ctx.service.name,
      action: 'status',
      message: summariseServiceStatus(s),
      duration: Date.now() - start,
    };
  } catch (err) {
    logger.error(`Failed to get status for ${ctx.service.name}:`, err);
    return {
      success: false,
      serviceName: ctx.service.name,
      action: 'status',
      message: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    };
  }
}
