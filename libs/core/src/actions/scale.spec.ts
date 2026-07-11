import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAws } from '../aws/exec.js';
import { scale, type ScaleContext } from './scale.js';

vi.mock('../aws/exec.js', () => ({ runAws: vi.fn() }));
const mockRunAws = vi.mocked(runAws);

function ctx(overrides: Partial<ScaleContext> = {}): ScaleContext {
  return {
    // Only the fields scale reads are needed.
    service: { name: 'ut99', path: '', config: {} as never },
    environment: 'dev',
    desiredCount: 1,
    ...overrides,
  };
}

describe('scale (headless core)', () => {
  beforeEach(() => {
    mockRunAws.mockReset();
    mockRunAws.mockResolvedValue({ exitCode: 0, stdout: '{}', stderr: '' });
  });

  it('sets desiredCount via ecs update-service on the right cluster/service', async () => {
    const result = await scale(ctx({ desiredCount: 1 }));
    expect(result.success).toBe(true);
    expect(result.outputs).toEqual({ desiredCount: '1' });
    expect(mockRunAws).toHaveBeenCalledTimes(1);
    const [args] = mockRunAws.mock.calls[0]!;
    expect(args).toEqual([
      'ecs',
      'update-service',
      '--cluster',
      'respawn-dev-ut99',
      '--service',
      'respawn-dev-ut99',
      '--desired-count',
      '1',
    ]);
  });

  it('frames desiredCount 0 as sleeping', async () => {
    const result = await scale(ctx({ desiredCount: 0 }));
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/sleeping/i);
    expect(mockRunAws.mock.calls[0]![0]).toContain('0');
  });

  it('rejects a negative count without calling AWS', async () => {
    const result = await scale(ctx({ desiredCount: -1 }));
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/non-negative integer/i);
    expect(mockRunAws).not.toHaveBeenCalled();
  });

  it('rejects a non-integer count without calling AWS', async () => {
    const result = await scale(ctx({ desiredCount: 1.5 }));
    expect(result.success).toBe(false);
    expect(mockRunAws).not.toHaveBeenCalled();
  });

  it('reports a friendly message when the service is not deployed', async () => {
    mockRunAws.mockResolvedValue({
      exitCode: 255,
      stdout: '',
      stderr: 'An error occurred (ServiceNotFoundException) when calling UpdateService',
    });
    const result = await scale(ctx());
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not deployed/i);
  });

  it('surfaces an unexpected AWS failure', async () => {
    mockRunAws.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'AccessDenied' });
    const result = await scale(ctx());
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/update-service failed/i);
  });
});
