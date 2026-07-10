export type {
  GameServerConfig,
  Environment,
  ContainerConfig,
  AdditionalPort,
  PersistentStorageConfig,
  NetworkingConfig,
  ScalingConfig,
  ImageConfig,
  LoggingConfig,
  CostConfig,
  EcrConfig,
  HealthCheckConfig,
  IdleShutdownConfig,
  AwsConfig,
  SecretRef,
  DeployPrompt,
  DiscoveredService,
  ActionResult,
} from './types.js';

export {
  DEFAULT_CONTAINER,
  DEFAULT_NETWORKING,
  DEFAULT_SCALING,
  DEFAULT_IMAGE,
  DEFAULT_LOGGING,
  DEFAULT_COST,
  DEFAULT_ECR,
  DEFAULT_HEALTH_CHECK,
  DEFAULT_IDLE_SHUTDOWN,
  DEFAULT_PERSISTENT_STORAGE,
  DEFAULT_AWS,
  ENVIRONMENT_OVERRIDES,
  defaultTags,
} from './defaults.js';

// Stack/resource naming lives in ../naming.ts now; keep the historical re-export path.
export {
  STACK_NAME_PREFIX,
  sharedStackName,
  serviceStackName,
} from '../naming.js';

export { loadConfig } from './loader.js';
