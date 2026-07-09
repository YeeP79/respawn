import { describe, it, expect } from 'vitest';
import {
  parseExecOutput,
  buildRemoteCommand,
  RCON_BEGIN,
  RCON_END,
} from './exec.js';

/** A realistic captured session: SSM banner around the sentinel-wrapped reply. */
function session(body: string, code: number): string {
  return [
    '',
    'The Session Manager plugin was installed successfully.',
    '',
    'Starting session with SessionId: ecs-execute-command-0abc123',
    RCON_BEGIN,
    body,
    `${RCON_END}${code}`,
    '',
    'Exiting session with sessionId: ecs-execute-command-0abc123',
    '',
  ].join('\n');
}

describe('parseExecOutput', () => {
  it('extracts the reply from between the banner noise', () => {
    const raw = session('CPU  Uptime  Players\n1.00  42  3', 0);
    const result = parseExecOutput(raw);
    expect(result.output).toBe('CPU  Uptime  Players\n1.00  42  3');
    expect(result.exitCode).toBe(0);
  });

  it('carries a non-zero remote exit code', () => {
    const raw = session('rcon failed: rcon password rejected', 1);
    expect(parseExecOutput(raw).exitCode).toBe(1);
  });

  it('handles an empty reply', () => {
    const raw = session('', 0);
    expect(parseExecOutput(raw).output).toBe('');
    expect(parseExecOutput(raw).exitCode).toBe(0);
  });

  it('tolerates CRLF line endings from the PTY', () => {
    // A PTY emits CRLF; build the whole session with it, not by double-converting.
    const raw = session('line1\nline2', 0).replace(/\n/g, '\r\n');
    expect(parseExecOutput(raw).output).toBe('line1\r\nline2');
  });

  it('throws with the raw session when the markers are missing', () => {
    // e.g. the plugin is not installed, or exec is disabled on the service.
    expect(() =>
      parseExecOutput('An error occurred (TargetNotConnected)'),
    ).toThrow(/did not run/);
  });
});

describe('buildRemoteCommand', () => {
  it('base64-encodes the command so metacharacters cannot break out', () => {
    const cmd = buildRemoteCommand('status; rm -rf /');
    // The literal dangerous string must not appear in the shell command.
    expect(cmd).not.toContain('rm -rf /');
    expect(cmd).toContain('base64 -d');
    expect(cmd).toContain(RCON_BEGIN);
    expect(cmd).toContain(`${RCON_END}$?`);
  });

  it('round-trips the command through base64', () => {
    const original = 'changelevel de_nuke';
    const encoded = /echo (\S+) \| base64 -d/.exec(buildRemoteCommand(original));
    expect(encoded).not.toBeNull();
    expect(Buffer.from(encoded![1]!, 'base64').toString('utf-8')).toBe(original);
  });

  it('survives quotes and newlines in the command', () => {
    const nasty = 'say "hello\nworld" \'; whoami';
    const encoded = /echo (\S+) \| base64 -d/.exec(buildRemoteCommand(nasty));
    expect(Buffer.from(encoded![1]!, 'base64').toString('utf-8')).toBe(nasty);
  });
});
