import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAws } from './exec.js';
import { resolveCallerIdentity } from './identity.js';

vi.mock('./exec.js', () => ({ runAws: vi.fn() }));
const mockRunAws = vi.mocked(runAws);

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' });
const fail = (stderr: string) => ({ exitCode: 255, stdout: '', stderr });

describe('resolveCallerIdentity', () => {
  beforeEach(() => mockRunAws.mockReset());

  it('returns the account and arn', async () => {
    mockRunAws.mockResolvedValue(
      ok('{"Account":"679252296174","Arn":"arn:aws:sts::679252296174:assumed-role/Admin/me"}'),
    );
    await expect(resolveCallerIdentity({ profile: 'p' })).resolves.toEqual({
      accountId: '679252296174',
      arn: 'arn:aws:sts::679252296174:assumed-role/Admin/me',
    });
  });

  it('passes the profile and region through to the CLI', async () => {
    mockRunAws.mockResolvedValue(ok('{"Account":"1"}'));
    await resolveCallerIdentity({ profile: 'p', region: 'us-east-2' });
    const [, opts] = mockRunAws.mock.calls[0]!;
    expect(opts).toMatchObject({ profile: 'p', region: 'us-east-2' });
  });

  // An expired session is the common failure and must not read as a config error.
  // Each of these is a real stderr AWS emits for a dead session.
  it.each([
    'Error when retrieving token from sso: Token has expired and refresh failed',
    'An error occurred (ExpiredToken) when calling the GetCallerIdentity operation',
    'Unable to locate credentials. You can configure credentials by running "aws configure".',
  ])('tells you to log in again for: %s', async (stderr) => {
    mockRunAws.mockResolvedValue(fail(stderr));
    await expect(resolveCallerIdentity({ profile: 'respawn' })).rejects.toThrow(
      /missing or expired[\s\S]*aws sso login --profile respawn/,
    );
  });

  it('does not claim an expiry for an unrelated failure', async () => {
    mockRunAws.mockResolvedValue(fail('Could not connect to the endpoint URL'));
    await expect(resolveCallerIdentity({ profile: 'p' })).rejects.toThrow(
      /Could not resolve the AWS identity for profile "p"/,
    );
  });

  it('rejects unparseable output rather than returning a partial identity', async () => {
    mockRunAws.mockResolvedValue(ok('<html>proxy error</html>'));
    await expect(resolveCallerIdentity({})).rejects.toThrow(/unparseable/i);
  });

  it('rejects a response with no Account field', async () => {
    mockRunAws.mockResolvedValue(ok('{"Arn":"arn:aws:sts::1:user/x"}'));
    await expect(resolveCallerIdentity({})).rejects.toThrow(/no Account field/i);
  });
});
