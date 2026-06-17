import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';
import type { Environment, DiscoveredService } from '../config/types.js';
import { sharedStackName } from '../config/defaults.js';
import { GameServerEcrRepo } from '../constructs/ecr-repo.js';

export interface SharedStackProps extends cdk.StackProps {
  environment: Environment;
  services: DiscoveredService[];
}

export class SharedStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly ecrRepos: Map<string, GameServerEcrRepo>;

  constructor(scope: Construct, id: string, props: SharedStackProps) {
    super(scope, id, {
      ...props,
      stackName: sharedStackName(props.environment),
    });

    // Create a simple public VPC. No NAT gateways (free) — Fargate tasks run in
    // public subnets with public IPs, which is what game servers need anyway.
    // Created (not looked up) so synth/diff work offline with no AWS credentials.
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC },
      ],
    });

    // Create an ECR repo per discovered service
    this.ecrRepos = new Map();
    for (const svc of props.services) {
      const repo = new GameServerEcrRepo(this, `Ecr-${svc.name}`, {
        serviceName: svc.name,
        maxImageCount: svc.config.ecr.maxImageCount,
      });
      this.ecrRepos.set(svc.name, repo);

      new cdk.CfnOutput(this, `EcrUri-${svc.name}`, {
        value: repo.repository.repositoryUri,
        exportName: `${this.stackName}-ecr-${svc.name}`,
      });
    }

    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      exportName: `${this.stackName}-vpc-id`,
    });
  }
}
