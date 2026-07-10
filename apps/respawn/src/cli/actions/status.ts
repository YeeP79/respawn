import { spawn } from 'node:child_process';
import chalk from 'chalk';
import type { ActionResult, DiscoveredService, Environment } from '@respawn/core';
import { logger } from '@respawn/core';

export interface StatusContext {
  service: DiscoveredService;
  environment: Environment;
  workspaceRoot: string;
  verbose?: boolean;
  profile?: string;
}

function runCommand(
  command: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
  });
}

export async function status(ctx: StatusContext): Promise<ActionResult> {
  const start = Date.now();
  const { service, environment } = ctx;
  const clusterName = `respawn-${environment}-${service.name}`;
  const serviceName = `respawn-${environment}-${service.name}`;

  try {
    const profileArgs = ctx.profile ? ['--profile', ctx.profile] : [];

    // First try to describe the service directly by name
    const describeArgs = [
      'ecs',
      'describe-services',
      '--cluster',
      clusterName,
      '--services',
      serviceName,
      '--output',
      'json',
      ...profileArgs,
    ];

    const result = await runCommand('aws', describeArgs);

    if (result.exitCode !== 0) {
      if (result.stderr.includes('ClusterNotFoundException') ||
          result.stderr.includes('ServiceNotFoundException')) {
        console.log(
          chalk.yellow(`  ${service.name}: Not deployed in ${environment}`),
        );
        return {
          success: true,
          serviceName: service.name,
          action: 'status',
          message: 'Not deployed',
          duration: Date.now() - start,
        };
      }
      throw new Error(`AWS CLI failed: ${result.stderr}`);
    }

    const data = JSON.parse(result.stdout) as {
      services?: Array<{
        status: string;
        runningCount: number;
        desiredCount: number;
        deployments?: Array<{ updatedAt: string }>;
        networkConfiguration?: {
          awsvpcConfiguration?: { assignPublicIp: string };
        };
      }>;
      failures?: Array<{ arn: string; reason: string }>;
    };

    let svc = data.services?.[0];

    // If not found by explicit name, fall back to listing services in the cluster
    if (!svc) {
      const listArgs = [
        'ecs',
        'list-services',
        '--cluster',
        clusterName,
        '--output',
        'json',
        ...profileArgs,
      ];

      const listResult = await runCommand('aws', listArgs);
      if (listResult.exitCode === 0) {
        const listData = JSON.parse(listResult.stdout) as {
          serviceArns?: string[];
        };
        const serviceArns = listData.serviceArns ?? [];

        if (serviceArns.length > 0) {
          const describeByArnArgs = [
            'ecs',
            'describe-services',
            '--cluster',
            clusterName,
            '--services',
            ...serviceArns,
            '--output',
            'json',
            ...profileArgs,
          ];

          const descResult = await runCommand('aws', describeByArnArgs);
          if (descResult.exitCode === 0) {
            const descData = JSON.parse(descResult.stdout) as {
              services?: Array<{
                status: string;
                runningCount: number;
                desiredCount: number;
                deployments?: Array<{ updatedAt: string }>;
                networkConfiguration?: {
                  awsvpcConfiguration?: { assignPublicIp: string };
                };
              }>;
            };
            svc = descData.services?.[0];
          }
        }
      }
    }

    if (!svc) {
      console.log(
        chalk.yellow(`  ${service.name}: Not found in ${environment}`),
      );
      return {
        success: true,
        serviceName: service.name,
        action: 'status',
        message: 'Not found',
        duration: Date.now() - start,
      };
    }

    const statusLine = [
      chalk.bold(service.name),
      chalk.gray('|'),
      `Status: ${svc.status === 'ACTIVE' ? chalk.green(svc.status) : chalk.yellow(svc.status)}`,
      chalk.gray('|'),
      `Tasks: ${svc.runningCount}/${svc.desiredCount}`,
      chalk.gray('|'),
      `Last deploy: ${svc.deployments?.[0]?.updatedAt ?? 'N/A'}`,
    ].join(' ');

    console.log(`  ${statusLine}`);

    return {
      success: true,
      serviceName: service.name,
      action: 'status',
      message: `${svc.status} (${svc.runningCount}/${svc.desiredCount} tasks)`,
      duration: Date.now() - start,
    };
  } catch (err) {
    logger.error(`Failed to get status for ${service.name}:`, err);
    return {
      success: false,
      serviceName: service.name,
      action: 'status',
      message: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    };
  }
}
