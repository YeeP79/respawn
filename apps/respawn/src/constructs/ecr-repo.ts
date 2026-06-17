import { RemovalPolicy } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface GameServerEcrRepoProps {
  serviceName: string;
  maxImageCount: number;
}

export class GameServerEcrRepo extends Construct {
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: GameServerEcrRepoProps) {
    super(scope, id);

    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: `respawn/${props.serviceName}`,
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: props.maxImageCount,
          description: `Keep last ${props.maxImageCount} images`,
        },
      ],
    });
  }
}
