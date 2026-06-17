// =============================================================================
// Game Server CDK Configuration Types
// =============================================================================
// These interfaces define every configurable parameter in the system.
// The config loader merges: defaults → .env → environment overrides
// =============================================================================

export interface GameServerConfig {
  /** Identity */
  serviceName: string;
  serviceDisplayName: string;

  /** Target environment */
  environment: Environment;

  /** Container resources */
  container: ContainerConfig;

  /** Networking */
  networking: NetworkingConfig;

  /** Scaling */
  scaling: ScalingConfig;

  /** Container image */
  image: ImageConfig;

  /** Logging */
  logging: LoggingConfig;

  /** Cost optimization */
  cost: CostConfig;

  /** ECR settings */
  ecr: EcrConfig;

  /** Health checks */
  healthCheck: HealthCheckConfig;

  /** Idle shutdown sidecar — scales service to 0 when no connections detected */
  idleShutdown: IdleShutdownConfig;

  /** Secrets resolved from AWS Secrets Manager / SSM and injected as ECS secrets */
  secretRefs: SecretRef[];

  /** Custom environment variables passed to the container */
  gameEnvVars: Record<string, string>;

  /** AWS account/region */
  aws: AwsConfig;

  /** Resource tagging */
  tags: Record<string, string>;
}

export type Environment = 'dev' | 'staging' | 'prod';

/**
 * A single secret mapping, parsed from one SECRET_REFS entry of the form
 * `<containerEnvVar>=<store>:<sourceId>[|<jsonKey>]`.
 *
 * Resolved at deploy time and injected into the task definition as an ECS
 * secret (`ecs.Secret`) — never as a plaintext environment variable. The task
 * execution role is granted read access to each referenced secret/parameter.
 */
export interface SecretRef {
  /** Environment variable name the container receives the secret value as */
  containerEnvVar: string;
  /** Backing store: AWS Secrets Manager ('sm') or SSM Parameter Store SecureString ('ssm') */
  store: 'sm' | 'ssm';
  /** Secret name/ARN (sm) or parameter path (ssm) */
  sourceId: string;
  /** For JSON secrets in Secrets Manager, the key to extract */
  jsonKey?: string;
}

export interface ContainerConfig {
  /** CPU units: 256, 512, 1024, 2048, 4096 */
  cpu: number;
  /** Memory in MiB — must be compatible with CPU choice */
  memory: number;
}

export interface NetworkingConfig {
  /** Port the container listens on */
  containerPort: number;
  /** Port exposed on the host/load balancer */
  hostPort: number;
  /** Protocol: TCP or UDP (game servers often use UDP) */
  protocol: 'TCP' | 'UDP';
  /** Whether to allow public internet access */
  enablePublicAccess: boolean;
}

export interface ScalingConfig {
  /** Number of tasks to run */
  desiredCount: number;
  /** Enable auto-scaling based on CPU */
  enableAutoScaling: boolean;
  /** Minimum task count when auto-scaling */
  minCapacity: number;
  /** Maximum task count when auto-scaling */
  maxCapacity: number;
  /** CPU utilization target percentage for auto-scaling */
  autoScaleCpuTarget: number;
}

export interface ImageConfig {
  /** Pre-built image URI (skip local build if set) */
  imageUri?: string;
  /** Path to Dockerfile relative to game directory */
  dockerfilePath: string;
}

export interface LoggingConfig {
  /** CloudWatch log retention in days */
  retentionDays: number;
}

export interface CostConfig {
  /** Use Fargate Spot for cheaper, interruptible capacity */
  useFargateSpot: boolean;
}

export interface EcrConfig {
  /** Max images to keep before lifecycle cleanup */
  maxImageCount: number;
}

export interface HealthCheckConfig {
  /** HTTP path for health check (leave empty for TCP/UDP checks) */
  path?: string;
  /** Port to health check on (defaults to containerPort) */
  port?: number;
  /** Seconds between health checks */
  intervalSeconds: number;
  /** Seconds before health check times out */
  timeoutSeconds: number;
}

export interface IdleShutdownConfig {
  /** Enable the idle shutdown sidecar */
  enabled: boolean;
  /** Minutes with zero connections before scaling to 0 */
  timeoutMinutes: number;
  /** Seconds between connection checks */
  checkIntervalSeconds: number;
  /** Detection method: "netstat" monitors network connections, "http" queries a status endpoint */
  checkMethod: 'netstat' | 'http';
  /** HTTP endpoint to query when checkMethod is "http". Must return JSON with a numeric "connections" or "players" field. */
  statusEndpoint?: string;
}

export interface AwsConfig {
  /** AWS account ID (resolved from CLI/environment) */
  accountId?: string;
  /** AWS region */
  region: string;
  /** AWS CLI profile name */
  profile?: string;
}

/** Discovered service from /apps/ */
export interface DiscoveredService {
  /** Service directory name */
  name: string;
  /** Absolute path to service directory */
  path: string;
  /** Loaded and merged config */
  config: GameServerConfig;
}

/** Result from an action execution */
export interface ActionResult {
  success: boolean;
  serviceName: string;
  action: string;
  message: string;
  duration: number;
  outputs?: Record<string, string>;
}
