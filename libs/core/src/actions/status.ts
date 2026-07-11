import type { DiscoveredService, Environment } from '../config/types.js';
import { runAws } from '../aws/exec.js';
import { clusterName, ecsServiceName } from '../naming.js';

export interface StatusContext {
  service: DiscoveredService;
  environment: Environment;
  profile?: string;
}

/** A service's live state. `not-deployed` = no cluster/service; `not-found` = cluster
 *  exists but the service is absent; `running` = described successfully. */
export interface ServiceStatus {
  service: string;
  environment: Environment;
  state: 'not-deployed' | 'not-found' | 'running';
  status?: string;
  runningCount?: number;
  desiredCount?: number;
  lastDeploy?: string;
}

interface EcsService {
  status: string;
  runningCount: number;
  desiredCount: number;
  deployments?: Array<{ updatedAt: string }>;
}

function toStatus(
  service: string,
  environment: Environment,
  svc: EcsService,
): ServiceStatus {
  return {
    service,
    environment,
    state: 'running',
    status: svc.status,
    runningCount: svc.runningCount,
    desiredCount: svc.desiredCount,
    ...(svc.deployments?.[0]?.updatedAt ? { lastDeploy: svc.deployments[0].updatedAt } : {}),
  };
}

/**
 * Reads a service's ECS state, structured for a caller to format or return. Distinguishes
 * "not deployed" (cluster/service missing — not an error) from a real AWS failure, and
 * falls back to list-services when a describe-by-name misses. Shells the `aws` CLI via the
 * shared runner; the read counterpart to the MCP's richer `server_health`.
 *
 * @throws On a genuine AWS CLI error (not a missing cluster/service).
 */
export async function fetchServiceStatus(ctx: StatusContext): Promise<ServiceStatus> {
  const { service, environment } = ctx;
  const cluster = clusterName(environment, service.name);
  const ecsSvc = ecsServiceName(environment, service.name);
  const opts = { region: undefined, profile: ctx.profile };

  const describe = await runAws(
    ['ecs', 'describe-services', '--cluster', cluster, '--services', ecsSvc, '--output', 'json'],
    opts,
  );

  if (describe.exitCode !== 0) {
    if (
      describe.stderr.includes('ClusterNotFoundException') ||
      describe.stderr.includes('ServiceNotFoundException')
    ) {
      return { service: service.name, environment, state: 'not-deployed' };
    }
    throw new Error(`AWS CLI failed: ${describe.stderr.trim()}`);
  }

  let svc = (JSON.parse(describe.stdout) as { services?: EcsService[] }).services?.[0];

  // Describe-by-name can miss (e.g. the service ARN differs); fall back to enumerating.
  if (!svc) {
    const list = await runAws(
      ['ecs', 'list-services', '--cluster', cluster, '--output', 'json'],
      opts,
    );
    if (list.exitCode === 0) {
      const arns = (JSON.parse(list.stdout) as { serviceArns?: string[] }).serviceArns ?? [];
      if (arns.length > 0) {
        const byArn = await runAws(
          ['ecs', 'describe-services', '--cluster', cluster, '--services', ...arns, '--output', 'json'],
          opts,
        );
        if (byArn.exitCode === 0) {
          svc = (JSON.parse(byArn.stdout) as { services?: EcsService[] }).services?.[0];
        }
      }
    }
  }

  if (!svc) return { service: service.name, environment, state: 'not-found' };
  return toStatus(service.name, environment, svc);
}
