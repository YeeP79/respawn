import { spawn } from 'node:child_process';

const RCON_CONTAINER = 'rcon-control';
const CLUSTER_PREFIX = 'respawn-';

export interface RconServer {
  /** Service name, e.g. `cs16`. */
  service: string;
  cluster: string;
  /** Full task ARN of the running task. */
  task: string;
}

export interface AwsJson {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AwsOpts {
  region?: string;
  profile?: string;
}

export function runAwsJson(
  args: string[],
  opts: { region?: string; profile?: string },
): Promise<AwsJson> {
  const finalArgs = [...args, '--output', 'json'];
  if (opts.region) finalArgs.push('--region', opts.region);
  if (opts.profile) finalArgs.push('--profile', opts.profile);

  return new Promise((resolve) => {
    const child = spawn('aws', finalArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on('error', (err) => resolve({ exitCode: 1, stdout, stderr: err.message }));
  });
}

/** Parses `respawn-<env>-<service>` into its service name. */
export function serviceFromCluster(clusterArn: string): string | undefined {
  const name = clusterArn.split('/').pop() ?? clusterArn;
  if (!name.startsWith(CLUSTER_PREFIX)) return undefined;
  // respawn-<env>-<service> — service is everything after the second dash.
  const parts = name.split('-');
  return parts.length >= 3 ? parts.slice(2).join('-') : undefined;
}

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
      (c) => c.name === RCON_CONTAINER && c.lastStatus === 'RUNNING',
    );
  } catch {
    return false;
  }
}

export const RCON_CONTAINER_NAME = RCON_CONTAINER;

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
