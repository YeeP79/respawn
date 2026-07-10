import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCdk } from '../utils/cdk-runner.js';
import { destroy, type DestroyContext } from './destroy.js';

vi.mock('../utils/cdk-runner.js', () => ({ runCdk: vi.fn() }));
const mockRunCdk = vi.mocked(runCdk);

function ctx(overrides: Partial<DestroyContext> = {}): DestroyContext {
  return {
    // Only the fields destroy reads are needed.
    service: { name: 'ut99', path: '', config: {} as never },
    environment: 'dev',
    workspaceRoot: '/ws',
    ...overrides,
  };
}

describe('destroy (headless core)', () => {
  beforeEach(() => {
    mockRunCdk.mockReset();
    mockRunCdk.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('refuses a production teardown without force, and never touches CDK', async () => {
    const result = await destroy(ctx({ environment: 'prod' }));
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/without confirmation/i);
    expect(mockRunCdk).not.toHaveBeenCalled();
  });

  it('destroys a non-prod service via CDK', async () => {
    const result = await destroy(ctx({ environment: 'dev' }));
    expect(result.success).toBe(true);
    expect(mockRunCdk).toHaveBeenCalledTimes(1);
    const call = mockRunCdk.mock.calls[0]![0];
    expect(call.command).toBe('destroy');
    expect(call.stacks).toEqual(['Respawn-dev-ut99', 'RespawnShared-dev']);
    expect(call.force).toBe(true); // cdk destroy always needs --force
  });

  it('destroys prod once force is set (post-confirmation)', async () => {
    const result = await destroy(ctx({ environment: 'prod', force: true }));
    expect(result.success).toBe(true);
    expect(mockRunCdk).toHaveBeenCalledTimes(1);
    expect(mockRunCdk.mock.calls[0]![0].stacks).toEqual(['Respawn-prod-ut99', 'RespawnShared-prod']);
  });

  it('surfaces a CDK failure as a failed result', async () => {
    mockRunCdk.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    const result = await destroy(ctx());
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/CDK destroy failed/);
  });
});
