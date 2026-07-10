import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import type { AdditionalPort } from '@respawn/core';

export interface GameServerNetworkingProps {
  vpc: ec2.IVpc;
  containerPort: number;
  protocol: 'TCP' | 'UDP';
  additionalPorts: AdditionalPort[];
  enablePublicAccess: boolean;
}

export class GameServerNetworking extends Construct {
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: GameServerNetworkingProps) {
    super(scope, id);

    this.securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: `Security group for game server on port ${props.containerPort}/${props.protocol}`,
      allowAllOutbound: true,
    });

    if (props.enablePublicAccess) {
      const peer = ec2.Peer.anyIpv4();

      // Primary port
      const primaryPort =
        props.protocol === 'UDP'
          ? ec2.Port.udp(props.containerPort)
          : ec2.Port.tcp(props.containerPort);

      this.securityGroup.addIngressRule(
        peer,
        primaryPort,
        `Allow ${props.protocol} traffic on port ${props.containerPort}`,
      );

      // Additional ports
      for (const ap of props.additionalPorts) {
        const port =
          ap.protocol === 'UDP'
            ? ec2.Port.udp(ap.hostPort)
            : ec2.Port.tcp(ap.hostPort);

        this.securityGroup.addIngressRule(
          peer,
          port,
          `Allow ${ap.protocol} traffic on port ${ap.hostPort}`,
        );
      }
    }
  }
}
