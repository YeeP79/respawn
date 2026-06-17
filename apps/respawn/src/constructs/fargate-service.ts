import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct, type IConstruct } from 'constructs';
import type { SecretRef } from '../config/types.js';
import type { GameServerConfig } from '../config/types.js';
import { GameServerLogging } from './logging.js';
import { GameServerNetworking } from './networking.js';
import { GameServerEfsStorage } from './efs-storage.js';
import { IdleShutdownSidecar } from './idle-shutdown.js';
import { RedisSidecar } from './redis-sidecar.js';

export interface GameServerFargateServiceProps {
  config: GameServerConfig;
  vpc: ec2.IVpc;
  ecrRepository?: ecr.IRepository;
  imageTag?: string;
  imageUri?: string;
}

export class GameServerFargateService extends Construct {
  public readonly service: ecs.FargateService;
  public readonly cluster: ecs.Cluster;

  constructor(
    scope: Construct,
    id: string,
    props: GameServerFargateServiceProps,
  ) {
    super(scope, id);

    const { config } = props;

    // Cluster
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: props.vpc,
      clusterName: `respawn-${config.environment}-${config.serviceName}`,
      enableFargateCapacityProviders: true,
    });

    // Logging
    const logging = new GameServerLogging(this, 'Logging', {
      serviceName: config.serviceName,
      environment: config.environment,
      retentionDays: config.logging.retentionDays,
    });

    // Networking
    const networking = new GameServerNetworking(this, 'Networking', {
      vpc: props.vpc,
      containerPort: config.networking.containerPort,
      protocol: config.networking.protocol,
      additionalPorts: config.networking.additionalPorts,
      enablePublicAccess: config.networking.enablePublicAccess,
    });

    // Task definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      cpu: config.container.cpu,
      memoryLimitMiB: config.container.memory,
    });

    // Game server container
    const containerEnv: Record<string, string> = {
      ...config.gameEnvVars,
      SERVICE_NAME: config.serviceName,
      ENVIRONMENT: config.environment,
    };

    const portProtocol =
      config.networking.protocol === 'UDP'
        ? ecs.Protocol.UDP
        : ecs.Protocol.TCP;

    // Build port mappings: primary + additional ports
    const portMappings: ecs.PortMapping[] = [
      {
        containerPort: config.networking.containerPort,
        hostPort: config.networking.hostPort,
        protocol: portProtocol,
      },
    ];
    for (const ap of config.networking.additionalPorts) {
      portMappings.push({
        containerPort: ap.containerPort,
        hostPort: ap.hostPort,
        protocol: ap.protocol === 'UDP' ? ecs.Protocol.UDP : ecs.Protocol.TCP,
      });
    }

    // Determine container image source
    const image = props.imageUri
      ? ecs.ContainerImage.fromRegistry(props.imageUri)
      : ecs.ContainerImage.fromEcrRepository(props.ecrRepository!, props.imageTag!);

    // Secrets — resolved from Secrets Manager / SSM and injected as ECS secrets
    // (never plaintext). Adding them to the container automatically grants the
    // task execution role read access to each backing secret/parameter.
    const containerSecrets = this.buildSecrets(config.secretRefs);

    const container = taskDefinition.addContainer('game-server', {
      image,
      essential: true,
      environment: containerEnv,
      secrets: containerSecrets,
      portMappings,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: logging.logGroup,
        streamPrefix: 'game-server',
      }),
      command: config.container.command,
    });

    // EFS persistent storage (optional)
    if (config.persistentStorage.enabled) {
      const efsStorage = new GameServerEfsStorage(this, 'EfsStorage', {
        vpc: props.vpc,
        serviceName: config.serviceName,
        environment: config.environment,
        serviceSecurityGroup: networking.securityGroup,
      });

      taskDefinition.addVolume({
        name: 'persistent-data',
        efsVolumeConfiguration: {
          fileSystemId: efsStorage.fileSystem.fileSystemId,
          transitEncryption: 'ENABLED',
          authorizationConfig: {
            accessPointId: efsStorage.accessPoint.accessPointId,
            iam: 'ENABLED',
          },
        },
      });

      container.addMountPoints({
        sourceVolume: 'persistent-data',
        containerPath: config.persistentStorage.mountPath,
        readOnly: false,
      });

      // Grant the task role access to the EFS file system
      efsStorage.fileSystem.grantReadWrite(taskDefinition.taskRole);
    }

    // Redis sidecar (optional)
    if (config.redis.enabled) {
      new RedisSidecar(this, 'Redis', {
        taskDefinition,
        logGroup: logging.logGroup,
      });
    }

    // Idle shutdown sidecar (optional)
    if (config.idleShutdown.enabled) {
      new IdleShutdownSidecar(this, 'IdleShutdown', {
        taskDefinition,
        logGroup: logging.logGroup,
        containerPort: config.networking.containerPort,
        additionalPorts: config.networking.additionalPorts.map((ap) => ap.containerPort),
        config: config.idleShutdown,
      });
    }

    // Fargate service
    const capacityProviderStrategies: ecs.CapacityProviderStrategy[] =
      config.cost.useFargateSpot
        ? [
            { capacityProvider: 'FARGATE_SPOT', weight: 1 },
            { capacityProvider: 'FARGATE', weight: 0, base: 1 },
          ]
        : [{ capacityProvider: 'FARGATE', weight: 1 }];

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition,
      serviceName: `respawn-${config.environment}-${config.serviceName}`,
      desiredCount: config.scaling.desiredCount,
      securityGroups: [networking.securityGroup],
      assignPublicIp: config.networking.enablePublicAccess,
      // The shared VPC is public-subnet-only (no NAT). Place tasks in public
      // subnets explicitly so they can pull images and serve traffic without
      // NAT; the default selection looks for private subnets, which don't exist.
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      capacityProviderStrategies,
    });

    // Ensure the ECS service is deleted before the cluster's capacity provider
    // associations, preventing CloudFormation DELETE_FAILED race conditions.
    // The CPA is created lazily during synthesis, so use an Aspect to find it.
    const cfnService = this.service.node.defaultChild as cdk.CfnResource;
    cdk.Aspects.of(this).add({
      visit(node: IConstruct) {
        if (
          node instanceof cdk.CfnResource &&
          node.cfnResourceType === 'AWS::ECS::ClusterCapacityProviderAssociations'
        ) {
          cfnService.addDependency(node);
        }
      },
    });

    // Auto-scaling (optional)
    if (config.scaling.enableAutoScaling) {
      const scalableTarget = this.service.autoScaleTaskCount({
        minCapacity: config.scaling.minCapacity,
        maxCapacity: config.scaling.maxCapacity,
      });

      scalableTarget.scaleOnCpuUtilization('CpuScaling', {
        targetUtilizationPercent: config.scaling.autoScaleCpuTarget,
      });
    }
  }

  /**
   * Resolves SecretRefs into a map of container env var → ecs.Secret.
   * `sm:` refs come from Secrets Manager (by name or ARN, optionally scoped to a
   * JSON key); `ssm:` refs come from SSM SecureString parameters.
   */
  private buildSecrets(refs: SecretRef[]): Record<string, ecs.Secret> {
    const secrets: Record<string, ecs.Secret> = {};
    for (const ref of refs) {
      if (ref.store === 'sm') {
        const secret = ref.sourceId.startsWith('arn:')
          ? secretsmanager.Secret.fromSecretCompleteArn(
              this,
              `Secret-${ref.containerEnvVar}`,
              ref.sourceId,
            )
          : secretsmanager.Secret.fromSecretNameV2(
              this,
              `Secret-${ref.containerEnvVar}`,
              ref.sourceId,
            );
        secrets[ref.containerEnvVar] = ecs.Secret.fromSecretsManager(
          secret,
          ref.jsonKey,
        );
      } else {
        const param = ssm.StringParameter.fromSecureStringParameterAttributes(
          this,
          `SsmParam-${ref.containerEnvVar}`,
          { parameterName: ref.sourceId },
        );
        secrets[ref.containerEnvVar] = ecs.Secret.fromSsmParameter(param);
      }
    }
    return secrets;
  }
}
