import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAws } from '../aws/exec.js';
import { fetchServiceStatus, type StatusContext } from './status.js';

vi.mock('../aws/exec.js', () => ({ runAws: vi.fn() }));
const mockRunAws = vi.mocked(runAws);

const ctx: StatusContext = {
  service: { name: 'ut99', path: '', config: {} as never },
  environment: 'dev',
};

function reply(over: { exitCode?: number; stdout?: string; stderr?: string }) {
  return { exitCode: over.exitCode ?? 0, stdout: over.stdout ?? '', stderr: over.stderr ?? '' };
}

describe('fetchServiceStatus', () => {
  beforeEach(() => mockRunAws.mockReset());

  it('reports not-deployed when the cluster/service is missing', async () => {
    mockRunAws.mockResolvedValueOnce(reply({ exitCode: 254, stderr: 'ClusterNotFoundException: ...' }));
    expect(await fetchServiceStatus(ctx)).toEqual({
      service: 'ut99',
      environment: 'dev',
      state: 'not-deployed',
    });
  });

  it('maps a described service to running with its counts and last deploy', async () => {
    mockRunAws.mockResolvedValueOnce(
      reply({
        stdout: JSON.stringify({
          services: [
            { status: 'ACTIVE', runningCount: 2, desiredCount: 3, deployments: [{ updatedAt: '2026-07-10T00:00:00Z' }] },
          ],
        }),
      }),
    );
    expect(await fetchServiceStatus(ctx)).toEqual({
      service: 'ut99',
      environment: 'dev',
      state: 'running',
      status: 'ACTIVE',
      runningCount: 2,
      desiredCount: 3,
      lastDeploy: '2026-07-10T00:00:00Z',
    });
  });

  it('falls back to list-services, then reports not-found when empty', async () => {
    mockRunAws
      .mockResolvedValueOnce(reply({ stdout: JSON.stringify({ services: [] }) })) // describe-by-name: empty
      .mockResolvedValueOnce(reply({ stdout: JSON.stringify({ serviceArns: [] }) })); // list: empty
    expect(await fetchServiceStatus(ctx)).toEqual({
      service: 'ut99',
      environment: 'dev',
      state: 'not-found',
    });
  });

  it('throws on a genuine AWS error (not a missing cluster/service)', async () => {
    mockRunAws.mockResolvedValueOnce(reply({ exitCode: 255, stderr: 'AccessDeniedException' }));
    await expect(fetchServiceStatus(ctx)).rejects.toThrow(/AWS CLI failed/);
  });

  it('queries the correctly-named cluster and service', async () => {
    mockRunAws.mockResolvedValueOnce(reply({ stdout: JSON.stringify({ services: [{ status: 'ACTIVE', runningCount: 1, desiredCount: 1 }] }) }));
    await fetchServiceStatus({ service: { name: 'ut99-vanilla', path: '', config: {} as never }, environment: 'prod' });
    const args = mockRunAws.mock.calls[0]![0];
    expect(args).toContain('respawn-prod-ut99-vanilla');
  });
});
