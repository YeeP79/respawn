import { describe, it, expect } from 'vitest';
import { serviceFromCluster, taskHasRconSidecar } from './discovery.js';

describe('serviceFromCluster', () => {
  it('reads the service name out of a cluster arn', () => {
    expect(
      serviceFromCluster(
        'arn:aws:ecs:us-east-1:1234:cluster/respawn-dev-cs16',
      ),
    ).toBe('cs16');
  });

  it('reads a bare cluster name', () => {
    expect(serviceFromCluster('respawn-dev-cs16')).toBe('cs16');
  });

  it('keeps a service name that itself contains a dash', () => {
    expect(serviceFromCluster('respawn-prod-7dtd')).toBe('7dtd');
  });

  it('ignores clusters that are not ours', () => {
    expect(serviceFromCluster('some-other-cluster')).toBeUndefined();
  });
});

describe('taskHasRconSidecar', () => {
  const withContainers = (
    lastStatus: string,
    containers: Array<{ name: string; lastStatus: string }>,
  ) => JSON.stringify({ tasks: [{ lastStatus, containers }] });

  it('is true for a running task with a running rcon-control container', () => {
    expect(
      taskHasRconSidecar(
        withContainers('RUNNING', [
          { name: 'game-server', lastStatus: 'RUNNING' },
          { name: 'rcon-control', lastStatus: 'RUNNING' },
        ]),
      ),
    ).toBe(true);
  });

  it('is false when the sidecar is absent', () => {
    expect(
      taskHasRconSidecar(
        withContainers('RUNNING', [{ name: 'game-server', lastStatus: 'RUNNING' }]),
      ),
    ).toBe(false);
  });

  it('is false when the task is not running', () => {
    expect(
      taskHasRconSidecar(
        withContainers('STOPPED', [{ name: 'rcon-control', lastStatus: 'STOPPED' }]),
      ),
    ).toBe(false);
  });

  it('is false when the sidecar is still starting', () => {
    expect(
      taskHasRconSidecar(
        withContainers('RUNNING', [{ name: 'rcon-control', lastStatus: 'PENDING' }]),
      ),
    ).toBe(false);
  });

  it('is false on unparseable input', () => {
    expect(taskHasRconSidecar('not json')).toBe(false);
    expect(taskHasRconSidecar('{}')).toBe(false);
  });
});
