import { runAwsJson, findServiceCluster, type AwsOpts } from './discovery.js';

/**
 * Infrastructure-level health for a game server's ECS task, as opposed to the
 * game-level state the rcon manifests describe. Nothing here is game-specific and
 * nothing here needs the game to be reachable — "why is nothing running" has to be
 * answerable when the server is down.
 */

/** A container's exit, paired with why the task stopped. */
export interface ContainerExit {
  name: string;
  exitCode?: number;
  reason?: string;
}

export interface StopRecord {
  stoppedAt?: string;
  /** ECS classification: UserInitiated, ServiceSchedulerInitiated, TaskFailedToStart… */
  stopCode?: string;
  reason?: string;
  containers: ContainerExit[];
}

export interface ContainerState {
  name: string;
  status?: string;
  /** Status of the ECS Exec managed agent, when exec is enabled. */
  execAgent?: string;
}

export interface TaskState {
  id: string;
  status?: string;
  startedAt?: string;
  taskDefinition: string;
  containers: ContainerState[];
}

export interface HealthReport {
  service: string;
  cluster: string;
  desired: number;
  running: number;
  pending: number;
  rolloutState?: string;
  tasks: TaskState[];
  recentStops: StopRecord[];
  events: Array<{ at?: string; message?: string }>;
}

/**
 * Explains a container exit code in the context of why ECS stopped the task.
 *
 * 137 is SIGKILL, and the usual shortcut reads it as "OOM-killed". For these game
 * servers that shortcut is wrong on every single normal shutdown: zandronum and the
 * GoldSrc engines ignore SIGTERM, so ECS escalates to SIGKILL after the stop timeout
 * and the container exits 137 on a perfectly clean scale-to-zero. Only an exit that
 * ECS did *not* initiate is worth alarming about.
 */
export function explainExit(exit: ContainerExit, stopCode?: string): string {
  const code = exit.exitCode;
  if (code === undefined) return 'no exit code recorded';
  if (code === 0) return 'clean exit';

  const ecsInitiated =
    stopCode === 'UserInitiated' ||
    stopCode === 'ServiceSchedulerInitiated' ||
    stopCode === 'SpotInterruption';

  if (code === 137) {
    return ecsInitiated
      ? 'SIGKILL after ECS asked it to stop — the game ignores SIGTERM, so this is a ' +
          'normal shutdown, not an OOM kill'
      : 'SIGKILL not initiated by ECS — possible OOM kill; check the memory limit';
  }
  if (code === 139) return 'SIGSEGV — the game crashed';
  if (code === 143) return 'SIGTERM — shut down on request';
  return ecsInitiated ? `exit ${code} during an ECS-initiated stop` : `exit ${code} — crashed`;
}

/** Average and peak of a CloudWatch datapoint series, or undefined when there is no data. */
export interface MetricSummary {
  average: number;
  maximum: number;
  samples: number;
  series: MetricPoint[];
}

interface Datapoint {
  Timestamp?: string;
  Average?: number;
  Maximum?: number;
}

/** One datapoint, oldest first — the shape an avg/peak pair throws away. */
export interface MetricPoint {
  at: string;
  average: number;
  maximum: number;
}

/**
 * Collapses a series to avg/peak *and keeps the series*.
 *
 * A bare avg/peak cannot distinguish a startup spike from sustained saturation, and
 * both look identical next to a healthy server. Worse, `CPUUtilization` is a *task*
 * metric: an ECS Exec session's own CPU lands in it, so a peak can be the observer
 * rather than the game. Only the timeline shows which.
 */
export function summarizeDatapoints(points: Datapoint[]): MetricSummary | undefined {
  const avgs = points.map((p) => p.Average).filter((n): n is number => typeof n === 'number');
  const maxes = points.map((p) => p.Maximum).filter((n): n is number => typeof n === 'number');
  if (avgs.length === 0 && maxes.length === 0) return undefined;
  return {
    average: avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : 0,
    maximum: maxes.length ? Math.max(...maxes) : 0,
    samples: points.length,
    series: points
      .filter((p) => typeof p.Timestamp === 'string')
      .map((p) => ({ at: p.Timestamp!, average: p.Average ?? 0, maximum: p.Maximum ?? 0 }))
      .sort((a, b) => a.at.localeCompare(b.at)),
  };
}

/** Renders a series as a sparkline so shape is legible without reading every number. */
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

export function sparkline(values: number[], max = 100): string {
  if (values.length === 0) return '';
  return values
    .map((v) => {
      const idx = Math.min(SPARK.length - 1, Math.max(0, Math.round((v / max) * (SPARK.length - 1))));
      return SPARK[idx]!;
    })
    .join('');
}

/**
 * AWS/ECS reports utilization as a percentage of the *task's* reservation, not of
 * any one container, so a percentage is only meaningful once multiplied back out.
 */
export function percentToMiB(percent: number, taskMemoryMiB: number): number {
  return Math.round((percent / 100) * taskMemoryMiB);
}

export interface ContainerStats {
  name: string;
  cpuPercent?: number;
  /** Anonymous memory — the number a memory limit actually has to cover. */
  rssBytes?: number;
  /** Includes page cache, which expands to fill whatever limit it is given. */
  usageBytes?: number;
  cacheBytes?: number;
  limitBytes?: number;
}

/**
 * Probe run inside the task. The ECS task metadata endpoint is only reachable from
 * within the task, which is why this goes over ECS Exec rather than an AWS API.
 *
 * Reports `rss` separately from `usage`: `usage` counts page cache, which grows to
 * fill whatever limit the cgroup has, so it looks alarming at every limit and proves
 * nothing. `rss` is what a limit must actually cover.
 */
export const CONTAINER_STATS_PROBE = `
import json, os, urllib.request

base = os.environ["ECS_CONTAINER_METADATA_URI_V4"]

def get(path):
    with urllib.request.urlopen(base + path, timeout=5) as r:
        return json.load(r)

task = get("/task")
stats = get("/task/stats")
names = {c.get("DockerId"): c.get("Name") for c in task.get("Containers", [])}

out = []
for cid, s in (stats or {}).items():
    if not s:
        continue
    mem = s.get("memory_stats") or {}
    st = mem.get("stats") or {}
    cpu = None
    try:
        c, p = s["cpu_stats"], s["precpu_stats"]
        cd = c["cpu_usage"]["total_usage"] - p["cpu_usage"]["total_usage"]
        sd = c.get("system_cpu_usage", 0) - p.get("system_cpu_usage", 0)
        n = c.get("online_cpus") or len(c["cpu_usage"].get("percpu_usage") or []) or 1
        if sd > 0 and cd > 0:
            cpu = round(cd / sd * n * 100, 2)
    except Exception:
        pass
    out.append({
        "name": names.get(cid, (cid or "?")[:12]),
        "cpuPercent": cpu,
        "rssBytes": st.get("rss", st.get("total_rss")),
        "cacheBytes": st.get("cache", st.get("total_cache")),
        "usageBytes": mem.get("usage"),
        "limitBytes": mem.get("limit"),
    })

print(json.dumps(out))
`.trim();

/** @throws When the probe's stdout is not the JSON array it is supposed to print. */
export function parseContainerStats(raw: string): ContainerStats[] {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) {
    throw new Error(`container stats probe returned no JSON:\n${raw.trim().slice(0, 400)}`);
  }
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('container stats probe returned a non-array');
  return parsed as ContainerStats[];
}

/** Bytes as MiB, one decimal — the unit every ECS memory limit is expressed in. */
export function toMiB(bytes: number | undefined): string {
  if (typeof bytes !== 'number') return '?';
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * A container with no `memoryLimitMiB` of its own inherits the cgroup's unlimited
 * sentinel (2^63 rounded to the page size), which renders as ~8.4 million MiB. Treat
 * anything above a terabyte as "no limit" rather than printing a nonsense number or
 * computing a percentage against it.
 */
const NO_LIMIT_BYTES = 1024 ** 4;

export function isUnlimited(limitBytes: number | undefined): boolean {
  return typeof limitBytes !== 'number' || limitBytes >= NO_LIMIT_BYTES;
}

/** Formats a container's memory limit, or "none" when the container has no cap. */
export function formatLimit(limitBytes: number | undefined): string {
  return isUnlimited(limitBytes) ? 'none (task limit applies)' : toMiB(limitBytes);
}

interface DescribedService {
  desiredCount?: number;
  runningCount?: number;
  pendingCount?: number;
  deployments?: Array<{ rolloutState?: string; status?: string }>;
  events?: Array<{ createdAt?: string; message?: string }>;
}

interface DescribedTask {
  taskArn?: string;
  lastStatus?: string;
  startedAt?: string;
  stoppedAt?: string;
  stopCode?: string;
  stoppedReason?: string;
  taskDefinitionArn?: string;
  containers?: Array<{
    name?: string;
    lastStatus?: string;
    exitCode?: number;
    reason?: string;
    managedAgents?: Array<{ lastStatus?: string }>;
  }>;
}

async function describeTasks(
  cluster: string,
  arns: string[],
  opts: AwsOpts,
): Promise<DescribedTask[]> {
  if (arns.length === 0) return [];
  const res = await runAwsJson(['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...arns], opts);
  if (res.exitCode !== 0) return [];
  return (JSON.parse(res.stdout).tasks ?? []) as DescribedTask[];
}

async function listTasks(
  cluster: string,
  desiredStatus: 'RUNNING' | 'STOPPED',
  opts: AwsOpts,
): Promise<string[]> {
  const res = await runAwsJson(
    ['ecs', 'list-tasks', '--cluster', cluster, '--desired-status', desiredStatus],
    opts,
  );
  if (res.exitCode !== 0) return [];
  return (JSON.parse(res.stdout).taskArns ?? []) as string[];
}

/** @throws When the service does not exist under any respawn cluster. */
export async function fetchHealth(
  service: string,
  opts: AwsOpts,
  maxStops = 5,
  maxEvents = 5,
): Promise<HealthReport> {
  const found = await findServiceCluster(service, opts);
  if (!found) throw new Error(`No respawn cluster for service "${service}".`);
  const { cluster, serviceName } = found;

  const svcRes = await runAwsJson(
    ['ecs', 'describe-services', '--cluster', cluster, '--services', serviceName],
    opts,
  );
  if (svcRes.exitCode !== 0) {
    throw new Error(`aws ecs describe-services failed: ${svcRes.stderr.trim()}`);
  }
  const svc = (JSON.parse(svcRes.stdout).services?.[0] ?? {}) as DescribedService;

  const running = await describeTasks(cluster, await listTasks(cluster, 'RUNNING', opts), opts);
  // ECS retains stopped tasks for roughly an hour; beyond that a crash leaves no trace
  // here and only the logs remember it.
  const stopped = await describeTasks(cluster, await listTasks(cluster, 'STOPPED', opts), opts);

  return {
    service,
    cluster: cluster.split('/').pop() ?? cluster,
    desired: svc.desiredCount ?? 0,
    running: svc.runningCount ?? 0,
    pending: svc.pendingCount ?? 0,
    ...(svc.deployments?.[0]?.rolloutState !== undefined
      ? { rolloutState: svc.deployments[0].rolloutState }
      : {}),
    tasks: running.map((t) => ({
      id: (t.taskArn ?? '').split('/').pop() ?? '?',
      ...(t.lastStatus !== undefined ? { status: t.lastStatus } : {}),
      ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
      taskDefinition: (t.taskDefinitionArn ?? '').split('/').pop() ?? '?',
      containers: (t.containers ?? []).map((c) => ({
        name: c.name ?? '?',
        ...(c.lastStatus !== undefined ? { status: c.lastStatus } : {}),
        ...(c.managedAgents?.[0]?.lastStatus !== undefined
          ? { execAgent: c.managedAgents[0].lastStatus }
          : {}),
      })),
    })),
    recentStops: stopped
      .sort((a, b) => (b.stoppedAt ?? '').localeCompare(a.stoppedAt ?? ''))
      .slice(0, maxStops)
      .map((t) => ({
        ...(t.stoppedAt !== undefined ? { stoppedAt: t.stoppedAt } : {}),
        ...(t.stopCode !== undefined ? { stopCode: t.stopCode } : {}),
        ...(t.stoppedReason !== undefined ? { reason: t.stoppedReason } : {}),
        containers: (t.containers ?? []).map((c) => ({
          name: c.name ?? '?',
          ...(c.exitCode !== undefined ? { exitCode: c.exitCode } : {}),
          ...(c.reason !== undefined ? { reason: c.reason } : {}),
        })),
      })),
    events: (svc.events ?? []).slice(0, maxEvents).map((e) => ({
      ...(e.createdAt !== undefined ? { at: e.createdAt } : {}),
      ...(e.message !== undefined ? { message: e.message } : {}),
    })),
  };
}

export interface MetricsReport {
  service: string;
  minutes: number;
  periodSeconds: number;
  taskCpuUnits?: number;
  taskMemoryMiB?: number;
  cpu?: MetricSummary;
  memory?: MetricSummary;
  liveTasks?: MetricSummary;
}

async function getMetric(
  cluster: string,
  serviceName: string,
  metric: string,
  minutes: number,
  periodSeconds: number,
  opts: AwsOpts,
): Promise<MetricSummary | undefined> {
  const end = new Date();
  const start = new Date(end.getTime() - minutes * 60_000);
  // ECS publishes 1-minute datapoints; a 300s period aggregates five of them and hides
  // short spikes inside the average. CloudWatch keeps 1-minute resolution for 15 days.
  const res = await runAwsJson(
    [
      'cloudwatch',
      'get-metric-statistics',
      '--namespace',
      'AWS/ECS',
      '--metric-name',
      metric,
      '--dimensions',
      `Name=ClusterName,Value=${cluster}`,
      `Name=ServiceName,Value=${serviceName}`,
      '--start-time',
      start.toISOString(),
      '--end-time',
      end.toISOString(),
      '--period',
      String(periodSeconds),
      '--statistics',
      'Average',
      'Maximum',
    ],
    opts,
  );
  if (res.exitCode !== 0) return undefined;
  return summarizeDatapoints((JSON.parse(res.stdout).Datapoints ?? []) as Datapoint[]);
}

/** @throws When the service does not exist under any respawn cluster. */
export async function fetchMetrics(
  service: string,
  minutes: number,
  opts: AwsOpts,
  periodSeconds = 300,
): Promise<MetricsReport> {
  const found = await findServiceCluster(service, opts);
  if (!found) throw new Error(`No respawn cluster for service "${service}".`);
  const clusterName = found.cluster.split('/').pop() ?? found.cluster;

  const svcRes = await runAwsJson(
    ['ecs', 'describe-services', '--cluster', found.cluster, '--services', found.serviceName],
    opts,
  );
  let taskCpuUnits: number | undefined;
  let taskMemoryMiB: number | undefined;
  if (svcRes.exitCode === 0) {
    const td = JSON.parse(svcRes.stdout).services?.[0]?.taskDefinition as string | undefined;
    if (td) {
      const tdRes = await runAwsJson(['ecs', 'describe-task-definition', '--task-definition', td], opts);
      if (tdRes.exitCode === 0) {
        const def = JSON.parse(tdRes.stdout).taskDefinition as { cpu?: string; memory?: string };
        taskCpuUnits = def.cpu ? Number.parseInt(def.cpu, 10) : undefined;
        taskMemoryMiB = def.memory ? Number.parseInt(def.memory, 10) : undefined;
      }
    }
  }

  const [cpu, memory, liveTasks] = await Promise.all([
    getMetric(clusterName, found.serviceName, 'CPUUtilization', minutes, periodSeconds, opts),
    getMetric(clusterName, found.serviceName, 'MemoryUtilization', minutes, periodSeconds, opts),
    getMetric(clusterName, found.serviceName, 'LiveTaskCount', minutes, periodSeconds, opts),
  ]);

  return {
    service,
    minutes,
    periodSeconds,
    ...(taskCpuUnits !== undefined ? { taskCpuUnits } : {}),
    ...(taskMemoryMiB !== undefined ? { taskMemoryMiB } : {}),
    ...(cpu !== undefined ? { cpu } : {}),
    ...(memory !== undefined ? { memory } : {}),
    ...(liveTasks !== undefined ? { liveTasks } : {}),
  };
}

export interface LogEvent {
  timestamp?: number;
  message?: string;
  logStreamName?: string;
}

/**
 * Resolves a log window from either a relative lookback or an absolute range.
 *
 * A relative-only window cannot express "show me the minute that task died three
 * hours ago", which is the question you actually have once `server_health` hands you
 * a `stoppedAt` timestamp. `since`/`until` accept anything `Date` parses, ISO chief
 * among them, and `until` may be omitted to mean "up to now".
 *
 * @throws On an unparseable timestamp, rather than silently querying the epoch.
 */
export function resolveWindow(params: {
  minutes?: number;
  since?: string;
  until?: string;
  now?: number;
}): { start: number; end?: number } {
  const now = params.now ?? Date.now();

  const parse = (label: string, value: string): number => {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new Error(`${label} is not a parseable timestamp: "${value}"`);
    return ms;
  };

  if (params.since !== undefined) {
    const start = parse('since', params.since);
    const end = params.until !== undefined ? parse('until', params.until) : undefined;
    if (end !== undefined && end <= start) {
      throw new Error(`until (${params.until}) must be after since (${params.since})`);
    }
    return end !== undefined ? { start, end } : { start };
  }
  if (params.until !== undefined) {
    throw new Error('until requires since — an open-ended window backwards is not a window');
  }
  return { start: now - (params.minutes ?? 30) * 60_000 };
}

/**
 * Tails a service's CloudWatch logs, optionally for one container.
 *
 * Log streams are named `<container>/<container>/<taskId>`, so a container filter is
 * a stream-name prefix — cheaper than scanning every stream in the group.
 */
export async function fetchLogs(
  service: string,
  opts: AwsOpts,
  params: {
    environment?: string;
    container?: string;
    minutes?: number;
    since?: string;
    until?: string;
    pattern?: string;
    limit?: number;
  } = {},
): Promise<{ logGroup: string; events: LogEvent[] }> {
  const env = params.environment ?? 'dev';
  const logGroup = `/respawn/${env}/${service}`;
  const { start, end } = resolveWindow(params);

  const args = [
    'logs',
    'filter-log-events',
    '--log-group-name',
    logGroup,
    '--start-time',
    String(start),
    '--limit',
    String(params.limit ?? 50),
  ];
  if (end !== undefined) args.push('--end-time', String(end));
  if (params.container) args.push('--log-stream-name-prefix', `${params.container}/`);
  if (params.pattern) args.push('--filter-pattern', params.pattern);

  const res = await runAwsJson(args, opts);
  if (res.exitCode !== 0) {
    throw new Error(`aws logs filter-log-events failed: ${res.stderr.trim()}`);
  }
  return { logGroup, events: (JSON.parse(res.stdout).events ?? []) as LogEvent[] };
}
