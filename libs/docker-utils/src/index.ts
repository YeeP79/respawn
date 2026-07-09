export interface DockerBuildOptions {
  context: string;
  dockerfile: string;
  tag: string;
  buildArgs?: Record<string, string>;
}

export interface EcrPushOptions {
  registry: string;
  repository: string;
  tag: string;
  region?: string;
}

export interface FargateTaskOptions {
  cluster: string;
  taskDefinition: string;
  subnets: string[];
  securityGroups: string[];
  assignPublicIp?: boolean;
}

export {
  buildImage,
  tagImage,
  hasBuildx,
  getImageSize,
  resolveBaseImageDigest,
} from './docker.js';
export type { BuildImageResult } from './docker.js';

export { ecrLogin, pushImage, imageTagExists } from './ecr.js';
