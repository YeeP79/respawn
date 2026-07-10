import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type { Construct } from 'constructs';
import type { GameServerConfig } from '@respawn/core';
import { serviceStackName, defaultTags } from '@respawn/core';
import { GameServerFargateService } from '../constructs/fargate-service.js';

export interface GameServerStackProps extends cdk.StackProps {
  config: GameServerConfig;
  vpc: ec2.IVpc;
  ecrRepository?: ecr.IRepository;
  imageTag?: string;
  imageUri?: string;
}

export class GameServerStack extends cdk.Stack {
  public readonly fargateService: GameServerFargateService;

  constructor(scope: Construct, id: string, props: GameServerStackProps) {
    super(scope, id, {
      ...props,
      stackName: serviceStackName(
        props.config.environment,
        props.config.serviceName,
      ),
    });

    this.fargateService = new GameServerFargateService(this, 'FargateService', {
      config: props.config,
      vpc: props.vpc,
      ecrRepository: props.ecrRepository,
      imageTag: props.imageTag,
      imageUri: props.imageUri,
    });

    // Apply tags
    const tags = defaultTags(
      props.config.environment,
      props.config.serviceName,
    );
    for (const [key, value] of Object.entries(tags)) {
      cdk.Tags.of(this).add(key, value);
    }
  }
}
