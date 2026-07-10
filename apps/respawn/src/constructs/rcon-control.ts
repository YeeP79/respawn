import * as path from 'node:path';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { RconProtocol } from '../config/types.js';

export interface RconControlSidecarProps {
  taskDefinition: ecs.FargateTaskDefinition;
  logGroup: logs.ILogGroup;
  /** Container env var name the rcon secret is injected as (usually RCON_PASSWORD). */
  rconSecret: ecs.Secret;
  /** Wire protocol the game speaks; `gamespy` is query-only (UT99). */
  protocol: RconProtocol;
  /** Port the game answers rcon on (loopback). */
  rconPort: number;
  /** Service name, for log lines and `--info`. */
  serviceName: string;
}

/**
 * A control container reached only via ECS Exec (SSM) — no inbound port. It holds
 * the rcon password as an ECS secret and talks to the game over loopback, so the
 * password never crosses the internet.
 *
 * One sidecar fronts one game server. It learns which protocol/port to use from
 * its environment, so the same image serves every game; an MCP client picks the
 * server by choosing which task to exec into.
 */
export class RconControlSidecar extends Construct {
  public readonly container: ecs.ContainerDefinition;

  constructor(scope: Construct, id: string, props: RconControlSidecarProps) {
    super(scope, id);

    const sidecarDir = path.join(
      import.meta.dirname,
      '../../sidecar/rcon-control',
    );

    this.container = props.taskDefinition.addContainer('rcon-control', {
      image: ecs.ContainerImage.fromAsset(sidecarDir),
      essential: false,
      cpu: 32,
      // ECS Exec runs the SSM agent and a session worker per exec *inside this
      // container's cgroup*. Measured rss during an exec is 20-45 MiB (container_stats
      // against live doom2); 64 MiB held that, but left under 20 MiB of headroom at
      // peak — one concurrent session short. 128 covers peak rss ~2.8x plus page cache.
      //
      // Judge this by rss, never by memory.usage_in_bytes: usage counts page cache,
      // which expands to fill whatever limit it is given, so it reads ~100% at every
      // limit and proves nothing. A high memory.failcnt is cache reclaim, not an OOM.
      memoryLimitMiB: 128,
      environment: {
        SERVICE_NAME: props.serviceName,
        RCON_PROTOCOL: props.protocol,
        RCON_HOST: '127.0.0.1',
        RCON_PORT: String(props.rconPort),
      },
      secrets: { RCON_PASSWORD: props.rconSecret },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: props.logGroup,
        streamPrefix: 'rcon-control',
      }),
    });
  }
}
