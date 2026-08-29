import * as path from 'node:path';
import { Duration } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface MysqlSidecarProps {
  taskDefinition: ecs.FargateTaskDefinition;
  logGroup: logs.ILogGroup;
  /** Database created on first start; the game plugin expects it to exist. */
  database: string;
  /** Root password, injected as an ECS secret — never a plaintext env var. */
  rootPassword: ecs.Secret;
  /**
   * `s3://bucket/key` for the dump that survives the scale-to-zero cycle. Unset means
   * no persistence: the timer works within a session and forgets between them.
   */
  backupS3Uri?: string;
  /** How often to dump while running. */
  backupIntervalSeconds?: number;
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
      // --skip-name-resolve makes account matching deterministic: without it MariaDB
      // reverse-resolves the peer address, so whether a loopback client matches
      // root@'127.0.0.1' or root@'localhost' depends on the resolver rather than on
      // anything declared here. With it, a TCP client always matches by IP.
      command: ['--skip-name-resolve'],
      environment: {
        MARIADB_DATABASE: props.database,
        // 127.0.0.1, NOT 'localhost'. The entrypoint creates root@localhost plus
        // root@<this>, and 'localhost' only ever matches a UNIX-socket login — so
        // setting it to localhost creates no TCP-capable root account at all. Every
        // client here (the game's AMXX MySQL module, the backup container) connects
        // over TCP on the task's shared loopback and presents as root@'127.0.0.1',
        // which then matches nothing: MariaDB answers "Access denied for user
        // 'root'@'127.0.0.1' (using password: YES)", which reads as a wrong password
        // and is really a missing account. Measured — the image creates its own
        // healthcheck@127.0.0.1 for the same reason.
        //
        // This is still not a login exposed outside the task: 3306 is neither the
        // primary port nor in ADDITIONAL_PORTS, so the security group grants it no
        // ingress, and the task's loopback is shared only by its own containers.
        MARIADB_ROOT_HOST: '127.0.0.1',
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
        // 120s of grace before the container is called unhealthy: first-run schema
        // creation builds 19 tables, and a restore replays a dump on top of that.
        // Spent as 10 x 12s rather than 12 x 10s because ECS caps retries at 10 and
        // rejects the task definition outright above it — CreateTaskDefinition fails
        // with "Health check retries must be less than or equal to the maximum allowed
        // value 10", which surfaces only at deploy, as a CloudFormation rollback.
        interval: Duration.seconds(12),
        timeout: Duration.seconds(5),
        retries: 10,
        startPeriod: Duration.seconds(30),
      },
    });

    if (!props.backupS3Uri) return;

    // Persistence for a database that has no volume. See sidecar/mysql-backup/backup.sh
    // for why this is a dump round-trip rather than EFS (MySQL on NFS is unsupported
    // and fails by corrupting rather than erroring) or RDS (always-on cost for a server
    // built to be off).
    const backupDir = path.join(import.meta.dirname, '../../sidecar/mysql-backup');
    const backup = props.taskDefinition.addContainer('mysql-backup', {
      image: ecs.ContainerImage.fromAsset(backupDir),
      essential: false,
      cpu: 64,
      memoryLimitMiB: 128,
      environment: {
        BACKUP_S3_URI: props.backupS3Uri,
        MYSQL_DATABASE: props.database,
        BACKUP_INTERVAL_SECONDS: String(props.backupIntervalSeconds ?? 300),
      },
      secrets: { MYSQL_ROOT_PASSWORD: props.rootPassword },
      // A dump on the way down has to finish inside the ECS stop timeout, and the
      // default 30s is shared with the game server's own shutdown.
      stopTimeout: Duration.seconds(120),
      logging: ecs.LogDrivers.awsLogs({
        logGroup: props.logGroup,
        streamPrefix: 'mysql-backup',
      }),
    });
    // Start after the database is accepting connections, so the restore is not racing
    // the first-run schema creation.
    backup.addContainerDependencies({
      container: this.container,
      condition: ecs.ContainerDependencyCondition.HEALTHY,
    });

    const bucket = props.backupS3Uri.replace(/^s3:\/\//, '').split('/')[0];
    props.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // Scoped to this service's own prefix rather than the bucket: the dump contains
        // player records, and a task should not be able to read another service's.
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [`arn:aws:s3:::${props.backupS3Uri.replace(/^s3:\/\//, '')}*`],
      }),
    );
    props.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [`arn:aws:s3:::${bucket}`],
      }),
    );
  }
}
