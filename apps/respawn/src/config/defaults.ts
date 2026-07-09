import type {
  ContainerConfig,
  NetworkingConfig,
  ScalingConfig,
  ImageConfig,
  LoggingConfig,
  CostConfig,
  EcrConfig,
  HealthCheckConfig,
  IdleShutdownConfig,
  RedisConfig,
  RconControlConfig,
  PersistentStorageConfig,
  AwsConfig,
  Environment,
} from './types.js';

export const DEFAULT_CONTAINER: ContainerConfig = {
  cpu: 1024,
  memory: 2048,
};

export const DEFAULT_NETWORKING: NetworkingConfig = {
  containerPort: 7777,
  hostPort: 7777,
  protocol: 'UDP',
  additionalPorts: [],
  enablePublicAccess: true,
};

export const DEFAULT_SCALING: ScalingConfig = {
  desiredCount: 1,
  enableAutoScaling: false,
  minCapacity: 1,
  maxCapacity: 3,
  autoScaleCpuTarget: 70,
};

export const DEFAULT_IMAGE: ImageConfig = {
  dockerfilePath: './Dockerfile',
};

export const DEFAULT_LOGGING: LoggingConfig = {
  retentionDays: 14,
};

export const DEFAULT_COST: CostConfig = {
  useFargateSpot: true,
};

export const DEFAULT_ECR: EcrConfig = {
  maxImageCount: 10,
};

export const DEFAULT_HEALTH_CHECK: HealthCheckConfig = {
  intervalSeconds: 30,
  timeoutSeconds: 5,
};

export const DEFAULT_PERSISTENT_STORAGE: PersistentStorageConfig = {
  enabled: false,
  mountPath: '/data',
};

export const DEFAULT_IDLE_SHUTDOWN: IdleShutdownConfig = {
  enabled: true,
  timeoutMinutes: 30,
  checkIntervalSeconds: 60,
  checkMethod: 'netstat',
  queryTimeoutSeconds: 4,
};

export const DEFAULT_REDIS: RedisConfig = {
  enabled: false,
};

export const DEFAULT_RCON_CONTROL: RconControlConfig = {
  enabled: false,
  protocol: 'goldsrc',
  passwordSecretVar: 'RCON_PASSWORD',
};

export const DEFAULT_AWS: AwsConfig = {
  region: 'us-east-1',
};

export interface EnvironmentOverrides {
  logging?: Partial<LoggingConfig>;
  cost?: Partial<CostConfig>;
  scaling?: Partial<ScalingConfig>;
}

export const ENVIRONMENT_OVERRIDES: Record<Environment, EnvironmentOverrides> = {
  dev: {
    logging: { retentionDays: 7 },
    cost: { useFargateSpot: true },
  },
  staging: {
    logging: { retentionDays: 14 },
    cost: { useFargateSpot: true },
  },
  prod: {
    logging: { retentionDays: 30 },
    cost: { useFargateSpot: false },
    scaling: { minCapacity: 1 },
  },
};

export const STACK_NAME_PREFIX = 'respawn';

export function sharedStackName(environment: Environment): string {
  return `${STACK_NAME_PREFIX}-${environment}-shared`;
}

export function serviceStackName(
  environment: Environment,
  serviceName: string,
): string {
  return `${STACK_NAME_PREFIX}-${environment}-${serviceName}`;
}

export function defaultTags(
  environment: Environment,
  serviceName: string,
): Record<string, string> {
  return {
    environment,
    service: serviceName,
    managedBy: 'respawn',
    deployedAt: new Date().toISOString(),
  };
}
