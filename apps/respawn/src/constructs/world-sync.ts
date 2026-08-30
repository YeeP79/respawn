import * as path from 'node:path';
import { Duration } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface WorldSyncSidecarProps {
  taskDefinition: ecs.FargateTaskDefinition;
  logGroup: logs.ILogGroup;
  /** `s3://bucket/prefix` holding the `inbox/` and `live/` trees. */
  s3Prefix: string;
  /** Must match the game's own WORLD_NAME — it is the save's file name. */
  worldName: string;
  /** Directory on the persistent volume the game keeps worlds in. */
  worldDir: string;
  /** Name of the EFS volume declared on the task definition. */
  volumeName: string;
  /** Where the persistent volume is mounted in this container. */
  mountPath: string;
  syncIntervalSeconds: number;
  /** Install an inbox world even when it is BEHIND the volume's — a deliberate rollback. */
  seedForce?: boolean;
  /** `vanilla` or `modded`; stamped onto every save that runs here and checked on seed. */
  flavor: string;
  /** Service name, recorded in the stamp's run history. */
  serviceName: string;
  /** Key under the prefix holding plugins to sync in before the game starts. */
  pluginSource?: string;
  /** Where the game reads mod plugins from, on the mounted volume. */
  pluginDir?: string;
  /** Let the game generate the world when no save by that name exists. */
  allowCreate?: boolean;
}

/**
 * Moves a world save between the task's persistent volume and S3, so worlds can be
 * rotated from a machine that has no route to the volume.
 *
 * The volume is reachable only from inside the VPC via the service security group, and
 * only the game container mounts it — so without this, seeding a world means an ECS Exec
 * session and a hand-copied file, and getting a played world back out is not possible at
 * all. That makes rotation a manual, unrepeatable operation on the one piece of state
 * in the fleet that cannot be regenerated.
 *
 * IMPORTANT — this is not MysqlSidecar's backup container with different paths. That one
 * restores from S3 unconditionally because a Fargate task has no volume, so S3 holds the
 * only copy. Here the volume outlives the task and holds the live world, so restoring
 * unconditionally would replay a stale save over a played one. The sidecar therefore
 * treats the volume as authoritative and only installs a world that was explicitly
 * placed in `inbox/`; see sidecar/world-sync/sync.sh for the freshness guard.
 */
export class WorldSyncSidecar extends Construct {
  public readonly container: ecs.ContainerDefinition;

  constructor(scope: Construct, id: string, props: WorldSyncSidecarProps) {
    super(scope, id);

    const syncDir = path.join(import.meta.dirname, '../../sidecar/world-sync');

    this.container = props.taskDefinition.addContainer('world-sync', {
      image: ecs.ContainerImage.fromAsset(syncDir),
      essential: false,
      cpu: 64,
      memoryLimitMiB: 128,
      environment: {
        WORLD_S3_PREFIX: props.s3Prefix,
        WORLD_NAME: props.worldName,
        WORLD_DIR: props.worldDir,
        SYNC_INTERVAL_SECONDS: String(props.syncIntervalSeconds),
        WORLD_SEED_FORCE: String(props.seedForce ?? false),
        WORLD_FLAVOR: props.flavor,
        WORLD_ALLOW_CREATE: String(props.allowCreate ?? false),
        SERVICE_NAME: props.serviceName,
        ...(props.pluginSource ? { WORLD_SYNC_PLUGIN_SOURCE: props.pluginSource } : {}),
        ...(props.pluginDir ? { PLUGIN_DIR: props.pluginDir } : {}),
      },
      // A 30 MB upload on the way down has to finish inside the ECS stop timeout, and
      // the default 30s is shared with the game server's own shutdown.
      stopTimeout: Duration.seconds(120),
      healthCheck: {
        // Reports healthy only once seeding has settled. The game container depends on
        // this, which is what stops Valheim opening the world while a save is being
        // written underneath it — the same race the MySQL sidecar's health check exists
        // for, in the opposite direction (there the game waits for a service to come up;
        // here it waits for a one-shot step to finish).
        command: ['CMD-SHELL', 'test -f /tmp/world-sync-ready'],
        interval: Duration.seconds(5),
        timeout: Duration.seconds(5),
        // Seeding downloads a world (~30 MB for a well-played one) and uploads the
        // outgoing one before replacing it, and a modded server also pulls its whole
        // plugin set first — so the budget is three transfers, not one.
        retries: 10,
        startPeriod: Duration.seconds(180),
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: props.logGroup,
        streamPrefix: 'world-sync',
      }),
    });

    this.container.addMountPoints({
      sourceVolume: props.volumeName,
      containerPath: props.mountPath,
      readOnly: false,
    });

    const withoutScheme = props.s3Prefix.replace(/^s3:\/\//, '').replace(/\/$/, '');
    const bucket = withoutScheme.split('/')[0];

    props.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // Scoped to this service's own prefix rather than the bucket: the same bucket
        // holds another service's player records, and a task should not reach them.
        // DeleteObject is required, not incidental — consuming the inbox is what makes
        // a seed one-shot, so a task that restarts mid-session cannot re-seed over play.
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [`arn:aws:s3:::${withoutScheme}/*`],
      }),
    );
    props.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // The sidecar probes for an inbox world with `s3 ls`, which is a ListBucket call
        // against the prefix, not a GetObject — without this every boot reads as "no
        // world in the inbox" and silently skips seeding.
        actions: ['s3:ListBucket'],
        resources: [`arn:aws:s3:::${bucket}`],
      }),
    );
  }
}
