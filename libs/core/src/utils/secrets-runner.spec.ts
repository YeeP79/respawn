import { describe, expect, it, vi, beforeEach } from 'vitest';

const runAws = vi.hoisted(() => vi.fn());
vi.mock('../aws/exec.js', () => ({ runAws }));

const { checkSecret } = await import('./secrets-runner.js');

const ok = (stdout = '{}') => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr: string, exitCode = 255) => ({ exitCode, stdout: '', stderr });

beforeEach(() => runAws.mockReset());

describe('checkSecret', () => {
  it('reports a secret that exists as present', async () => {
    runAws.mockResolvedValue(ok());
    await expect(checkSecret({ store: 'sm', sourceId: 'respawn/x/y' })).resolves.toEqual({
      status: 'present',
    });
  });

  it('reports Secrets Manager not-found as absent', async () => {
    runAws.mockResolvedValue(
      fail("An error occurred (ResourceNotFoundException) when calling the DescribeSecret operation: Secrets Manager can't find the specified secret."),
    );
    await expect(checkSecret({ store: 'sm', sourceId: 'respawn/x/y' })).resolves.toEqual({
      status: 'absent',
    });
  });

  it('reports SSM not-found as absent', async () => {
    runAws.mockResolvedValue(
      fail('An error occurred (ParameterNotFound) when calling the GetParameter operation'),
    );
    await expect(checkSecret({ store: 'ssm', sourceId: '/respawn/x/y' })).resolves.toEqual({
      status: 'absent',
    });
  });

  // The regression. An expired session used to be indistinguishable from absence, so
  // check_secrets announced that existing secrets were missing and advised creating
  // them — which, against the wrong account, writes duplicates into it.
  it('does NOT report an expired session as absent', async () => {
    runAws.mockResolvedValue(
      fail('aws: [ERROR]: Error when retrieving token from sso: Token has expired and refresh failed'),
    );
    const res = await checkSecret({ store: 'sm', sourceId: 'respawn/x/y' });
    expect(res.status).toBe('unknown');
    expect(res.status === 'unknown' && res.reason).toContain('Token has expired');
  });

  it('does NOT report a denial as absent', async () => {
    runAws.mockResolvedValue(
      fail('An error occurred (AccessDeniedException) when calling the DescribeSecret operation'),
    );
    expect((await checkSecret({ store: 'sm', sourceId: 'respawn/x/y' })).status).toBe('unknown');
  });

  it('keeps the reason to a single line, so a list of secrets stays readable', async () => {
    runAws.mockResolvedValue(fail('Traceback:\n  frame one\n  the actual error'));
    const res = await checkSecret({ store: 'sm', sourceId: 'respawn/x/y' });
    expect(res.status === 'unknown' && res.reason).toBe('  the actual error');
  });

  it('still reports unknown when a failure carries no stderr at all', async () => {
    runAws.mockResolvedValue(fail('', 137));
    const res = await checkSecret({ store: 'sm', sourceId: 'respawn/x/y' });
    expect(res.status).toBe('unknown');
    expect(res.status === 'unknown' && res.reason).toContain('137');
  });

  it('queries the right CLI for each store', async () => {
    runAws.mockResolvedValue(ok());
    await checkSecret({ store: 'sm', sourceId: 'a' });
    expect(runAws.mock.calls[0]![0]).toEqual(['secretsmanager', 'describe-secret', '--secret-id', 'a']);
    await checkSecret({ store: 'ssm', sourceId: '/b' });
    expect(runAws.mock.calls[1]![0]).toEqual(['ssm', 'get-parameter', '--name', '/b']);
  });
});
