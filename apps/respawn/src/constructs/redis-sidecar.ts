import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface RedisSidecarProps {
  taskDefinition: ecs.FargateTaskDefinition;
  logGroup: logs.ILogGroup;
}

export class RedisSidecar extends Construct {
  public readonly container: ecs.ContainerDefinition;

  constructor(scope: Construct, id: string, props: RedisSidecarProps) {
    super(scope, id);

    this.container = props.taskDefinition.addContainer('redis', {
      image: ecs.ContainerImage.fromRegistry('redis:7-alpine'),
      essential: false,
      cpu: 64,
      memoryLimitMiB: 128,
      portMappings: [
        {
          containerPort: 6379,
          protocol: ecs.Protocol.TCP,
        },
      ],
      logging: ecs.LogDrivers.awsLogs({
        logGroup: props.logGroup,
        streamPrefix: 'redis',
      }),
    });
  }
}
