import { RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Construct } from 'constructs';
import type { Environment } from '../config/types.js';

export interface GameServerEfsStorageProps {
  vpc: ec2.IVpc;
  serviceName: string;
  environment: Environment;
  serviceSecurityGroup: ec2.ISecurityGroup;
}

export class GameServerEfsStorage extends Construct {
  public readonly fileSystem: efs.FileSystem;
  public readonly accessPoint: efs.AccessPoint;

  constructor(scope: Construct, id: string, props: GameServerEfsStorageProps) {
    super(scope, id);

    const removalPolicy =
      props.environment === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.fileSystem = new efs.FileSystem(this, 'FileSystem', {
      vpc: props.vpc,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      removalPolicy,
    });

    this.accessPoint = this.fileSystem.addAccessPoint('AccessPoint', {
      path: `/${props.serviceName}`,
      createAcl: {
        ownerGid: '1000',
        ownerUid: '1000',
        permissions: '755',
      },
      posixUser: {
        gid: '1000',
        uid: '1000',
      },
    });

    // Allow NFS traffic from the Fargate service SG to the EFS file system
    this.fileSystem.connections.allowFrom(
      props.serviceSecurityGroup,
      ec2.Port.tcp(2049),
      'Allow NFS from Fargate service',
    );
  }
}
