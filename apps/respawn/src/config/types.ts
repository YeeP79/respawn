export interface GameServerConfig {
  serviceName: string;
  serviceDisplayName: string;
  environment: Environment;
  container: ContainerConfig;
  networking: NetworkingConfig;
  scaling: ScalingConfig;
  image: ImageConfig;
  logging: LoggingConfig;
  cost: CostConfig;
  ecr: EcrConfig;
  healthCheck: HealthCheckConfig;
  idleShutdown: IdleShutdownConfig;
  redis: RedisConfig;
  persistentStorage: PersistentStorageConfig;
  secretRefs: SecretRef[];
  deployPrompts: DeployPrompt[];
  gameEnvVars: Record<string, string>;
  /**
   * Container env vars the service cannot run without — a Steam GSLT, an admin
   * Steam64 ID, an rcon password. Declared via `REQUIRED_ENV_VARS`. Checked at
   * deploy time (not load time, so a service with an unset requirement still
   * appears in the CLI and can be inspected). See `preflightDeploy`.
   */
  requiredEnvVars: string[];
  aws: AwsConfig;
  tags: Record<string, string>;
}

/**
 * A deploy-time prompt declared by a service via DEPLOY_PROMPTS, of the form
 * `<envVar>:<type>:<opt1>|<opt2>|...`. Asked interactively after service
 * selection (deploy action only); the chosen value is injected as the container
 * env var `<envVar>`. Skipped in non-interactive mode (the value must already be
 * set via `GAME_ENV_<envVar>` in `.env`).
 */
export interface DeployPrompt {
  /** Container env var the chosen value is injected as */
  envVar: string;
  /** Prompt widget — only single-choice 'select' is supported today */
  type: 'select';
  /** The selectable options */
  options: string[];
}

export type Environment = 'dev' | 'staging' | 'prod';

/**
 * A single secret mapping, parsed from one SECRET_REFS entry of the form
 * `<containerEnvVar>=<store>:<sourceId>[|<jsonKey>]`.
 *
 * Resolved at deploy time and injected into the task definition as an ECS
 * secret (never a plaintext environment variable). The task execution role is
 * granted read access to the backing secret/parameter automatically.
 */
export interface SecretRef {
  /** Environment variable name the container receives the secret value as */
  containerEnvVar: string;
  /** Backing store: AWS Secrets Manager ('sm') or SSM Parameter Store SecureString ('ssm') */
  store: 'sm' | 'ssm';
  /** Secret name/ARN (sm) or parameter path (ssm) */
  sourceId: string;
  /** For JSON secrets in Secrets Manager, the key to extract (sm only) */
  jsonKey?: string;
}

export interface ContainerConfig {
  cpu: number;
  memory: number;
  command?: string[];
}

export interface AdditionalPort {
  containerPort: number;
  hostPort: number;
  protocol: 'TCP' | 'UDP';
}

export interface PersistentStorageConfig {
  enabled: boolean;
  mountPath: string;
}

export interface NetworkingConfig {
  containerPort: number;
  hostPort: number;
  protocol: 'TCP' | 'UDP';
  additionalPorts: AdditionalPort[];
  enablePublicAccess: boolean;
}

export interface ScalingConfig {
  desiredCount: number;
  enableAutoScaling: boolean;
  minCapacity: number;
  maxCapacity: number;
  autoScaleCpuTarget: number;
}

export interface ImageConfig {
  imageUri?: string;
  dockerfilePath: string;
}

export interface LoggingConfig {
  retentionDays: number;
}

export interface CostConfig {
  useFargateSpot: boolean;
}

export interface EcrConfig {
  maxImageCount: number;
}

export interface HealthCheckConfig {
  path?: string;
  port?: number;
  intervalSeconds: number;
  timeoutSeconds: number;
}

export interface IdleShutdownConfig {
  enabled: boolean;
  timeoutMinutes: number;
  checkIntervalSeconds: number;
  checkMethod: 'netstat' | 'http';
  statusEndpoint?: string;
}

export interface RedisConfig {
  enabled: boolean;
}

export interface AwsConfig {
  accountId?: string;
  region: string;
  profile?: string;
}

export interface DiscoveredService {
  name: string;
  path: string;
  config: GameServerConfig;
}

export interface ActionResult {
  success: boolean;
  serviceName: string;
  action: string;
  message: string;
  duration: number;
  outputs?: Record<string, string>;
}
