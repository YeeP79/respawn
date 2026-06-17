import * as path from 'node:path';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { IdleShutdownConfig } from '../config/types.js';

export interface IdleShutdownSidecarProps {
  taskDefinition: ecs.FargateTaskDefinition;
  logGroup: logs.ILogGroup;
  containerPort: number;
  additionalPorts?: number[];
  config: IdleShutdownConfig;
}

export class IdleShutdownSidecar extends Construct {
  public readonly container: ecs.ContainerDefinition;

  constructor(scope: Construct, id: string, props: IdleShutdownSidecarProps) {
    super(scope, id);

    const sidecarDir = path.join(import.meta.dirname, '../../sidecar/idle-shutdown');

    this.container = props.taskDefinition.addContainer('idle-shutdown', {
      image: ecs.ContainerImage.fromAsset(sidecarDir),
      essential: false,
      cpu: 64,
      memoryLimitMiB: 128,
      environment: {
        IDLE_TIMEOUT_MINUTES: String(props.config.timeoutMinutes),
        IDLE_CHECK_INTERVAL_SECONDS: String(props.config.checkIntervalSeconds),
        IDLE_CHECK_METHOD: props.config.checkMethod,
        IDLE_STATUS_ENDPOINT: props.config.statusEndpoint ?? '',
        CONTAINER_PORT: String(props.containerPort),
        ADDITIONAL_PORTS:
          props.additionalPorts && props.additionalPorts.length > 0
            ? props.additionalPorts.join(',')
            : '',
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: props.logGroup,
        streamPrefix: 'idle-shutdown',
      }),
    });

    // Allow the sidecar to describe and update the ECS service it runs in.
    // The sidecar discovers its own cluster/service at runtime via
    // $ECS_CONTAINER_METADATA_URI_V4 to avoid CDK circular dependencies.
    props.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
        resources: ['*'],
      }),
    );
  }
}
