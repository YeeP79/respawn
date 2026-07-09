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
  const begin = raw.indexOf(RCON_BEGIN);
  const end = raw.indexOf(RCON_END, begin + 1);
  if (begin === -1 || end === -1) {
    throw new Error(
      `rcon markers not found in exec output — the command did not run. ` +
        `Raw session:\n${raw.trim().slice(0, 800)}`,
    );
  }

  const output = raw.slice(begin + RCON_BEGIN.length, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  const codeText = raw.slice(end + RCON_END.length).match(/-?\d+/)?.[0];
  const exitCode = codeText ? Number.parseInt(codeText, 10) : 1;

  return { output, exitCode };
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
    buildRemoteCommand(rconCommand),
  ];
  if (target.region) args.push('--region', target.region);
  if (target.profile) args.push('--profile', target.profile);

  return new Promise((resolve, reject) => {
    const child = spawn('aws', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ECS Exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.stdin.end(); // the remote command is non-interactive; close stdin

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `could not launch the AWS CLI (${err.message}). ` +
            `The session-manager-plugin must also be installed.`,
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
