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
  rconControl: RconControlConfig;
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
  /** What to compare against the last recorded state. Declared via `UPDATE_CHECK`. */
  updateChecks: UpdateCheck[];
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
  /**
   * Ports the task uses but that must NOT be publicly reachable — rcon (TCP),
   * web panels, telnet. They get a port mapping (so the task documents them) but
   * no security-group ingress. The rcon-control sidecar reaches them over
   * loopback within the task, so they never need to face the internet.
   */
  internalPorts: AdditionalPort[];
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
  /**
   * How the idle sidecar decides whether anyone is playing.
   *
   * The three query methods ask the game itself and are the only reliable option
   * for UDP games, which serve every client from one unconnected socket:
   * - `a2s`: Valve GoldSrc/Source, and Steam-hosted games (Rust, 7 Days to Die)
   * - `q3`: idTech3 `getstatus` (Quake 3, Quake Live)
   * - `gamespy`: Unreal Engine 1 `\info\` (Unreal Tournament 99)
   * - `zandronum`: Zandronum launcher protocol (Doom 2 / Heretic / Hexen)
   *
   * - `http`: poll `statusEndpoint` for a player/connection count.
   * - `netstat`: count established sockets. Correct only for TCP games.
   */
  checkMethod:
    | 'netstat'
    | 'http'
    | 'a2s'
    | 'q3'
    | 'gamespy'
    | 'zandronum';
  statusEndpoint?: string;
  /**
   * Port the query methods probe. Defaults to the game's container port; several
   * games listen for queries elsewhere (Rust: 28017, UT99: game port + 1).
   */
  queryPort?: number;
  /** Seconds to wait for a query reply before reporting "unknown". */
  queryTimeoutSeconds: number;
}

export interface RedisConfig {
  enabled: boolean;
}

/**
 * The rcon-control sidecar: an ECS-Exec-only container that runs rcon commands
 * against the game over loopback, so the password never leaves the task.
 * Enabled by `ENABLE_RCON_CONTROL`; needs a `SECRET_REFS` entry naming the rcon
 * password so it can be injected without appearing in the task definition.
 */
export interface RconControlConfig {
  enabled: boolean;
  /** Wire protocol: 'goldsrc' (UDP, GoldSrc) or 'source' (TCP, Source/Source 2). */
  protocol: 'goldsrc' | 'source';
  /** Container env var (from SECRET_REFS) holding the rcon password. */
  passwordSecretVar: string;
  /** Port the game answers rcon on. Defaults to the container port. */
  port?: number;
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

/**
 * One `UPDATE_CHECK` entry: a thing that can change underneath a deployed server.
 *
 * The three are independent. An upstream image can move without the game
 * changing; Valve can ship a game update without the image moving (SteamCMD
 * installs at container start, onto EFS); and our own Dockerfile/shim can change
 * without either.
 */
export type UpdateCheck =
  /** The `IMAGE_URI` tag now resolves to a different registry digest. */
  | { kind: 'image' }
  /** Our locally-built image content hash changed (Dockerfile, COPYed files, or base). */
  | { kind: 'build' }
  /** Valve published a new public build for this Steam app id. */
  | { kind: 'steam'; appId: string };

/**
 * A CLI/executor action. `push` builds and pushes an image without deploying;
 * `deploy` reuses that image when its content-addressed tag is already in ECR.
 */
export type Action =
  | 'deploy'
  | 'destroy'
  | 'synth'
  | 'diff'
  | 'status'
  | 'push'
  | 'updates';

export interface ActionResult {
  success: boolean;
  serviceName: string;
  action: string;
  message: string;
  duration: number;
  outputs?: Record<string, string>;
}
