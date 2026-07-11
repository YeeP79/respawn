import type { ActionResult, DiscoveredService, Environment } from '../config/types.js';
import { runAws } from '../aws/exec.js';
import { logger } from '../utils/logger.js';
import { clusterName, ecsServiceName } from '../naming.js';

export interface ScaleContext {
  service: DiscoveredService;
  environment: Environment;
  /** ECS desiredCount to set. 0 sleeps the service; 1 wakes a single task. */
  desiredCount: number;
  profile?: string;
  region?: string;
}

/**
 * Sets a service's ECS desiredCount — the wake/sleep the MCP could never do on its own
 * (it controls a task but cannot start one). Deliberately does NOT wait for the task to
 * reach RUNNING: waking takes ~1–2 min and observing that is `status`/`server_health`'s
 * job. Single responsibility — this only moves the desired count.
 *
 * `not-deployed` (no cluster/service) is returned as a failed ActionResult, not thrown,
 * so a batch over several services reports it uniformly and keeps going.
 */
export async function scale(ctx: ScaleContext): Promise<ActionResult> {
  const start = Date.now();
  const { service, environment, desiredCount } = ctx;

  try {
    if (!Number.isInteger(desiredCount) || desiredCount < 0) {
      throw new Error(`desiredCount must be a non-negative integer (got ${desiredCount}).`);
    }

    const cluster = clusterName(environment, service.name);
    const ecsSvc = ecsServiceName(environment, service.name);

    logger.info(`Scaling ${service.name} in ${environment} to desiredCount=${desiredCount}...`);
    const res = await runAws(
      [
        'ecs',
        'update-service',
        '--cluster',
        cluster,
        '--service',
        ecsSvc,
        '--desired-count',
        String(desiredCount),
      ],
      { profile: ctx.profile, region: ctx.region },
    );

    if (res.exitCode !== 0) {
      if (
        res.stderr.includes('ClusterNotFoundException') ||
        res.stderr.includes('ServiceNotFoundException')
      ) {
        throw new Error(
          `${service.name} is not deployed in ${environment} — no ECS service to scale. Deploy it first.`,
        );
      }
      throw new Error(`aws ecs update-service failed: ${res.stderr.trim() || '(no stderr)'}`);
    }

    const verb = desiredCount === 0 ? 'Sleeping' : 'Waking';
    return {
      success: true,
      serviceName: service.name,
      action: 'scale',
      message: `${verb} ${service.name} in ${environment} (desiredCount=${desiredCount}). Reaching steady state takes ~1–2 min; poll status.`,
      duration: Date.now() - start,
      outputs: { desiredCount: String(desiredCount) },
    };
  } catch (err) {
    return {
      success: false,
      serviceName: service.name,
      action: 'scale',
      message: err instanceof Error ? err.message : String(err),
      duration: Date.now() - start,
    };
  }
}
