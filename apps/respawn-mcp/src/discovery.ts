import {
  runAws,
  serviceFromClusterName,
  CLUSTER_PREFIX,
  RCON_CONTAINER_NAME as CORE_RCON_CONTAINER_NAME,
  type AwsResult,
} from '@respawn/core';

export interface RconServer {
  /** Service name, e.g. `cs16`. */
  service: string;
  cluster: string;
  /** Full task ARN of the running task. */
  task: string;
}

export type AwsJson = AwsResult;

export interface AwsOpts {
  region?: string;
  profile?: string;
}

/**
 * `aws … --output json` via the shared core runner. Returns the raw result (callers
 * JSON.parse and branch on exitCode, so a missing cluster is a skip, not a throw).
 */
export function runAwsJson(args: string[], opts: AwsOpts): Promise<AwsJson> {
  return runAws([...args, '--output', 'json'], opts);
}

/** Parses `respawn-<env>-<service>` into its service name (core naming). */
export const serviceFromCluster = serviceFromClusterName;

/** True when a describe-tasks payload has a RUNNING rcon-control container. */
export function taskHasRconSidecar(describeTasksJson: string): boolean {
  try {
    const parsed = JSON.parse(describeTasksJson) as {
      tasks?: Array<{
        lastStatus?: string;
        containers?: Array<{ name?: string; lastStatus?: string }>;
      }>;
    };
    const task = parsed.tasks?.[0];
    if (task?.lastStatus !== 'RUNNING') return false;
    return (task.containers ?? []).some(
      (c) => c.name === CORE_RCON_CONTAINER_NAME && c.lastStatus === 'RUNNING',
    );
  } catch {
    return false;
  }
}

export const RCON_CONTAINER_NAME = CORE_RCON_CONTAINER_NAME;

/**
 * Finds a service's cluster and ECS service name whether or not it is running.
 *
 * `discoverRconServers` deliberately hides scaled-to-zero servers — you cannot rcon
 * into a task that does not exist. Monitoring is the opposite: "why is nothing
 * running" is exactly the question, so resolve by cluster name instead of by task.
 */
export async function findServiceCluster(
  service: string,
  opts: AwsOpts,
): Promise<{ cluster: string; serviceName: string } | undefined> {
  const clusters = await runAwsJson(['ecs', 'list-clusters'], opts);
  if (clusters.exitCode !== 0) {
    throw new Error(`aws ecs list-clusters failed: ${clusters.stderr.trim()}`);
  }
  const arn = (JSON.parse(clusters.stdout).clusterArns as string[]).find(
    (c) => serviceFromCluster(c) === service,
  );
  if (!arn) return undefined;

  const services = await runAwsJson(['ecs', 'list-services', '--cluster', arn], opts);
  if (services.exitCode !== 0) return undefined;
  const serviceArn = (JSON.parse(services.stdout).serviceArns as string[])[0];
  if (!serviceArn) return undefined;

  return { cluster: arn, serviceName: serviceArn.split('/').pop() ?? serviceArn };
}

/**
 * Discovers game servers whose running task carries an rcon-control sidecar.
 *
 * Reads from AWS, not the repo, so it works wherever the MCP is installed and
 * only surfaces servers that are actually up — a scaled-to-zero server has no
 * task to rcon into, and correctly does not appear.
 */
export async function discoverRconServers(opts: {
  region?: string;
  profile?: string;
}): Promise<RconServer[]> {
  const clusters = await runAwsJson(['ecs', 'list-clusters'], opts);
  if (clusters.exitCode !== 0) {
    throw new Error(`aws ecs list-clusters failed: ${clusters.stderr.trim()}`);
  }

  const arns = (JSON.parse(clusters.stdout).clusterArns as string[]).filter(
    (arn) => (arn.split('/').pop() ?? '').startsWith(CLUSTER_PREFIX),
  );

  const servers: RconServer[] = [];
  for (const cluster of arns) {
    const service = serviceFromCluster(cluster);
    if (!service) continue;

    const tasks = await runAwsJson(
      ['ecs', 'list-tasks', '--cluster', cluster, '--desired-status', 'RUNNING'],
      opts,
    );
    if (tasks.exitCode !== 0) continue;
    const taskArns = JSON.parse(tasks.stdout).taskArns as string[];
    if (taskArns.length === 0) continue;

    const described = await runAwsJson(
      ['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', taskArns[0]!],
      opts,
    );
    if (described.exitCode === 0 && taskHasRconSidecar(described.stdout)) {
      servers.push({ service, cluster, task: taskArns[0]! });
    }
  }
  return servers;
}
