import { Duration } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface MysqlSidecarProps {
  taskDefinition: ecs.FargateTaskDefinition;
  logGroup: logs.ILogGroup;
  /** Database created on first start; the game plugin expects it to exist. */
  database: string;
  /** Root password, injected as an ECS secret — never a plaintext env var. */
  rootPassword: ecs.Secret;
}

/**
 * MySQL alongside the game server, on the task's shared network namespace so the game
 * reaches it at 127.0.0.1:3306 with no service discovery.
 *
 * For game mods that require a database to function rather than merely to persist —
 * the CS 1.6 KZ timer is the case: `kz_core` calls natives provided by `kz_sql_core`,
 * so removing the SQL plugins fails the timer itself, not just its leaderboards.
 *
 * IMPORTANT — this storage is EPHEMERAL. A Fargate task has no volume here, so records
 * live only as long as the task. That is a deliberate trade for a scale-to-zero server:
 * a durable store means RDS (always-on cost) or EFS (a database over NFS, which MySQL
 * documents as unsupported). Treat it as session-scoped scores, and reach for RDS only
 * if records need to outlive a session.
 */
export class MysqlSidecar extends Construct {
  public readonly container: ecs.ContainerDefinition;

  constructor(scope: Construct, id: string, props: MysqlSidecarProps) {
    super(scope, id);

    this.container = props.taskDefinition.addContainer('mysql', {
      // mariadb rather than mysql: a much smaller image, wire-compatible with the
      // MySQL client AMXX's module speaks, and it starts faster on a cold task.
      image: ecs.ContainerImage.fromRegistry('mariadb:11-noble'),
      // Non-essential: if the database dies the game server should keep running with a
      // timer that cannot save, rather than taking the whole task down mid-session.
      essential: false,
      cpu: 128,
      memoryLimitMiB: 512,
      environment: {
        MARIADB_DATABASE: props.database,
        // The game connects over loopback inside the task, which no other container or
        // host can reach, so a root login is not exposed beyond this boundary.
        MARIADB_ROOT_HOST: 'localhost',
      },
      secrets: {
        MARIADB_ROOT_PASSWORD: props.rootPassword,
      },
      portMappings: [{ containerPort: 3306, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        logGroup: props.logGroup,
        streamPrefix: 'mysql',
      }),
      healthCheck: {
        // The game server starts faster than MySQL does; without a health check the
        // plugin's first connection attempt races the database and fails silently.
        command: ['CMD', 'healthcheck.sh', '--connect'],
        interval: Duration.seconds(10),
        timeout: Duration.seconds(5),
        retries: 12,
        startPeriod: Duration.seconds(30),
      },
    });
  }
}
