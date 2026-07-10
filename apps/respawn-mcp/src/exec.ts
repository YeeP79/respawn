import { spawn } from 'node:child_process';

/**
 * `aws ecs execute-command` streams an interactive SSM session: its stdout is
 * the game's rcon reply wrapped in a session-manager banner. We bracket the real
 * output with sentinels and carry the exit code in the closing one, so the reply
 * survives the banner noise and a remote failure is distinguishable from an empty
 * reply.
 */
export const RCON_BEGIN = '__RESPAWN_RCON_BEGIN__';
export const RCON_END = '__RESPAWN_RCON_END__';

export interface RconResult {
  /** The game server's reply, banner stripped. */
  output: string;
  /** Exit code of rcon.py inside the sidecar. */
  exitCode: number;
}

/**
 * Extracts the rcon reply and remote exit code from a captured exec session.
 *
 * @throws When the sentinels are absent — meaning the command never ran (the task
 *   is gone, ECS Exec is disabled, or the session manager plugin is missing). The
 *   raw text is included so the caller can surface the real cause.
 */
export function parseExecOutput(raw: string): RconResult {
  // The pty turns every \n into \r\n on top of the CRLFs the remote already sent,
  // so drop \r wholesale rather than matching \r\n. The plugin also pushes a NUL
  // down the channel on open, which the pty's line discipline echoes back in caret
  // notation ("^@") — a literal two-char artifact, not a NUL byte.
  const clean = raw.replace(/\r/g, '').replace(/\0/g, '');
  const begin = clean.indexOf(RCON_BEGIN);
  const end = clean.indexOf(RCON_END, begin + 1);
  if (begin === -1 || end === -1) {
    throw new Error(
      `rcon markers not found in exec output — the command did not run. ` +
        `Raw session:\n${clean.trim().slice(0, 800)}`,
    );
  }

  const output = clean
    .slice(begin + RCON_BEGIN.length, end)
    .replace(/^\n/, '')
    .replace(/^\^@/, '')
    .replace(/\n$/, '');
  const codeText = clean.slice(end + RCON_END.length).match(/-?\d+/)?.[0];
  const exitCode = codeText ? Number.parseInt(codeText, 10) : 1;

  return { output, exitCode };
}

/** Single-quotes a token for a POSIX shell, escaping any embedded quote. */
function shQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Wraps an argv in `script(1)` so the child gets a real pty.
 *
 * `aws ecs execute-command --interactive` hands stdin to session-manager-plugin,
 * which tears the session down at once when stdin is not a TTY — the command still
 * runs to completion inside the container, but its output never comes back and the
 * plugin reports "Cannot perform start session: EOF". An MCP server's stdin is the
 * client's JSON-RPC pipe, never a terminal, so a pty has to be manufactured.
 *
 * BSD/macOS `script` takes the command as trailing argv after the typescript file;
 * util-linux takes it as one string via `-c`.
 */
function ptyWrap(argv: readonly string[]): { command: string; args: string[] } {
  if (process.platform === 'darwin') {
    return { command: 'script', args: ['-q', '/dev/null', ...argv] };
  }
  return { command: 'script', args: ['-qec', argv.map(shQuote).join(' '), '/dev/null'] };
}

/**
 * Builds the remote shell command. The user's rcon command is base64-encoded so
 * no amount of quoting or shell metacharacters in it can break out or inject —
 * it only ever becomes an argument to rcon.py.
 */
export function buildRemoteCommand(rconCommand: string): string {
  const encoded = Buffer.from(rconCommand, 'utf-8').toString('base64');
  return (
    `sh -c 'echo ${RCON_BEGIN}; ` +
    `python3 /usr/local/bin/rcon.py --command "$(echo ${encoded} | base64 -d)"; ` +
    `echo ${RCON_END}$?'`
  );
}

/**
 * Builds the remote shell command for a Python probe, piping the script into
 * `python3 -` over stdin rather than `eval`-ing it, so no quoting or shell
 * metacharacter in the script can reach a shell at all.
 */
export function buildRemotePython(script: string): string {
  const encoded = Buffer.from(script, 'utf-8').toString('base64');
  return (
    `sh -c 'echo ${RCON_BEGIN}; ` +
    `echo ${encoded} | base64 -d | python3 -; ` +
    `echo ${RCON_END}$?'`
  );
}

export interface ExecTarget {
  cluster: string;
  task: string;
  container: string;
  region?: string;
  profile?: string;
}

/**
 * Runs one rcon command in a task's rcon-control sidecar via ECS Exec.
 *
 * Requires the session-manager-plugin locally and `enableExecuteCommand` on the
 * service. Never sees the rcon password: that lives in the sidecar as an ECS
 * secret; this only ships the command in and reads the reply out.
 *
 * @throws When the AWS CLI cannot be launched, the session never produces the
 *   sentinels, or the command times out.
 */
export function execRcon(
  target: ExecTarget,
  rconCommand: string,
  timeoutMs = 20_000,
): Promise<RconResult> {
  return runExec(target, buildRemoteCommand(rconCommand), timeoutMs);
}

/**
 * Runs a Python probe in a task's sidecar via ECS Exec. Used for readings only the
 * task itself can take — the ECS task metadata endpoint is reachable from inside
 * the task and nowhere else.
 */
export function execPython(
  target: ExecTarget,
  script: string,
  timeoutMs = 20_000,
): Promise<RconResult> {
  return runExec(target, buildRemotePython(script), timeoutMs);
}

/** Opens one ECS Exec session, runs an already-wrapped remote command, returns its reply. */
function runExec(
  target: ExecTarget,
  remoteCommand: string,
  timeoutMs: number,
): Promise<RconResult> {
  const args = [
    'ecs',
    'execute-command',
    '--cluster',
    target.cluster,
    '--task',
    target.task,
    '--container',
    target.container,
    '--interactive',
    '--command',
    remoteCommand,
  ];
  if (target.region) args.push('--region', target.region);
  if (target.profile) args.push('--profile', target.profile);

  const { command, args: ptyArgs } = ptyWrap(['aws', ...args]);

  return new Promise((resolve, reject) => {
    const child = spawn(command, ptyArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ECS Exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    // Safe to close: `script` already gave the session its own pty, so the plugin
    // is not reading this pipe.
    child.stdin.end();

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `could not launch script(1) or the AWS CLI (${err.message}). ` +
            `script(1), the AWS CLI, and session-manager-plugin must all be installed.`,
        ),
      );
    });

    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(parseExecOutput(stdout || stderr));
      } catch (parseErr) {
        // Surface the plugin/permission error the banner usually carries.
        const detail = stderr.trim() || (parseErr as Error).message;
        reject(new Error(detail));
      }
    });
  });
}
