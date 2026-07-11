import { describe, it, expect } from 'vitest';
import {
  RESOURCE_PREFIX,
  CLUSTER_PREFIX,
  RCON_CONTAINER_NAME,
  sharedStackId,
  serviceStackId,
  sharedStackName,
  serviceStackName,
  clusterName,
  ecsServiceName,
  logGroupName,
  execAuditLogGroupName,
  ecrRepositoryName,
  stateParameterName,
  parseClusterName,
  serviceFromClusterName,
} from './naming.js';

// These assert the EXACT strings the CDK constructs deployed before centralisation —
// a change here is a rename of live AWS resources, and must be deliberate.
describe('naming builders', () => {
  it('constants', () => {
    expect(RESOURCE_PREFIX).toBe('respawn');
    expect(CLUSTER_PREFIX).toBe('respawn-');
    expect(RCON_CONTAINER_NAME).toBe('rcon-control');
  });

  it('stacks — construct id vs deployed name stay paired', () => {
    expect(sharedStackId('dev')).toBe('RespawnShared-dev');
    expect(serviceStackId('dev', 'ut99')).toBe('Respawn-dev-ut99');
    expect(sharedStackName('dev')).toBe('respawn-dev-shared');
    expect(serviceStackName('dev', 'ut99')).toBe('respawn-dev-ut99');
  });

  it('ecs cluster + service', () => {
    expect(clusterName('prod', 'cs16')).toBe('respawn-prod-cs16');
    expect(ecsServiceName('prod', 'cs16')).toBe('respawn-prod-cs16');
  });

  it('cloudwatch log groups', () => {
    expect(logGroupName('dev', 'ut99')).toBe('/respawn/dev/ut99');
    expect(execAuditLogGroupName('dev', 'ut99')).toBe('/respawn/dev/ut99/exec-audit');
  });

  it('ecr repository', () => {
    expect(ecrRepositoryName('ut99')).toBe('respawn/ut99');
  });

  it('ssm deploy-state parameter (no environment segment)', () => {
    expect(stateParameterName('ut99', 'image')).toBe('/respawn/ut99/state/image');
  });

  it('composes identically for a hyphenated (variant) service name', () => {
    expect(serviceStackId('dev', 'ut99-vanilla')).toBe('Respawn-dev-ut99-vanilla');
    expect(clusterName('dev', 'ut99-vanilla')).toBe('respawn-dev-ut99-vanilla');
    expect(logGroupName('dev', 'ut99-vanilla')).toBe('/respawn/dev/ut99-vanilla');
  });
});

describe('parseClusterName / serviceFromClusterName', () => {
  it('round-trips a plain service name', () => {
    expect(parseClusterName('respawn-dev-cs16')).toEqual({ environment: 'dev', service: 'cs16' });
  });

  it('keeps hyphens in the service — the bug a naive split hit', () => {
    // A naive split('-')[2] would return "ut99" and drop "-vanilla".
    expect(parseClusterName('respawn-dev-ut99-vanilla')).toEqual({
      environment: 'dev',
      service: 'ut99-vanilla',
    });
    expect(serviceFromClusterName('respawn-prod-ut99-vanilla')).toBe('ut99-vanilla');
  });

  it('parses a full cluster ARN by its trailing name', () => {
    expect(
      serviceFromClusterName('arn:aws:ecs:us-east-1:123456789012:cluster/respawn-dev-ut99'),
    ).toBe('ut99');
  });

  it('round-trips every builder output', () => {
    for (const env of ['dev', 'staging', 'prod'] as const) {
      for (const svc of ['cs16', 'ut99-vanilla', 'l4d2']) {
        expect(parseClusterName(clusterName(env, svc))).toEqual({ environment: env, service: svc });
      }
    }
  });

  it('rejects non-respawn names', () => {
    expect(parseClusterName('other-dev-cs16')).toBeNull();
    expect(parseClusterName('respawn-')).toBeNull();
    expect(serviceFromClusterName('nonsense')).toBeUndefined();
  });
});
