import type { Environment } from './config/types.js';

// Single source of truth for every Respawn AWS resource name. The CDK constructs
// PRODUCE these names; the CLI and MCP READ them (to select stacks, describe ECS
// services, fetch logs). Historically each site hardcoded the same string, which is
// how the MCP's cluster parser silently mishandled hyphenated service names. Keep all
// of it here so a rename happens in exactly one place.

/** Prefix for kebab-case resource names (`respawn-...`, `respawn/...`, `/respawn/...`). */
export const RESOURCE_PREFIX = 'respawn';
/** Prefix for PascalCase CDK stack construct ids (`Respawn-...`). */
const STACK_ID_PREFIX = 'Respawn';
/** Cluster-name prefix, for filtering `ecs list-clusters` to Respawn clusters. */
export const CLUSTER_PREFIX = `${RESOURCE_PREFIX}-`;
/** The rcon-control sidecar container name (the ECS Exec target). */
export const RCON_CONTAINER_NAME = 'rcon-control';

/** @deprecated use RESOURCE_PREFIX. Kept for existing imports. */
export const STACK_NAME_PREFIX = RESOURCE_PREFIX;

// --- CloudFormation stacks -------------------------------------------------
// Each stack has TWO names that must stay paired: the CDK construct id (PascalCase,
// used as the `cdk --stacks` selector) and the deployed CloudFormation stackName
// (kebab-case).
export function sharedStackId(environment: Environment): string {
  return `${STACK_ID_PREFIX}Shared-${environment}`;
}
export function serviceStackId(environment: Environment, service: string): string {
  return `${STACK_ID_PREFIX}-${environment}-${service}`;
}
export function sharedStackName(environment: Environment): string {
  return `${RESOURCE_PREFIX}-${environment}-shared`;
}
export function serviceStackName(environment: Environment, service: string): string {
  return `${RESOURCE_PREFIX}-${environment}-${service}`;
}

// --- ECS -------------------------------------------------------------------
// Cluster and service share the same name today; keep two functions so they can
// diverge without another hunt through the codebase.
export function clusterName(environment: Environment, service: string): string {
  return `${RESOURCE_PREFIX}-${environment}-${service}`;
}
export function ecsServiceName(environment: Environment, service: string): string {
  return `${RESOURCE_PREFIX}-${environment}-${service}`;
}

// --- CloudWatch Logs -------------------------------------------------------
export function logGroupName(environment: Environment, service: string): string {
  return `/${RESOURCE_PREFIX}/${environment}/${service}`;
}
export function execAuditLogGroupName(environment: Environment, service: string): string {
  return `${logGroupName(environment, service)}/exec-audit`;
}

// --- ECR -------------------------------------------------------------------
export function ecrRepositoryName(service: string): string {
  return `${RESOURCE_PREFIX}/${service}`;
}

// --- SSM deploy-state ------------------------------------------------------
// Under `/respawn/<service>/state/` (no environment segment) so it never collides
// with the `/respawn/<service>/<secret>` SecureString namespace.
export function stateParameterName(service: string, key: string): string {
  return `/${RESOURCE_PREFIX}/${service}/state/${key}`;
}

// --- Parsers ---------------------------------------------------------------
const ENVIRONMENTS: readonly Environment[] = ['dev', 'staging', 'prod'];

/**
 * Parse a cluster or ECS service name (`respawn-<env>-<service>`, or a full ARN) back
 * into its parts. Service names may contain hyphens (`ut99-vanilla`), so everything
 * after the environment segment is the service — never split naively on `-`.
 */
export function parseClusterName(
  nameOrArn: string,
): { environment: Environment; service: string } | null {
  const name = nameOrArn.split('/').pop() ?? nameOrArn;
  if (!name.startsWith(CLUSTER_PREFIX)) return null;
  const base = name.slice(CLUSTER_PREFIX.length);
  for (const environment of ENVIRONMENTS) {
    const marker = `${environment}-`;
    if (base.startsWith(marker)) {
      const service = base.slice(marker.length);
      if (service) return { environment, service };
    }
  }
  return null;
}

/** The service name from a cluster/service name or ARN, or undefined. */
export function serviceFromClusterName(nameOrArn: string): string | undefined {
  return parseClusterName(nameOrArn)?.service;
}
