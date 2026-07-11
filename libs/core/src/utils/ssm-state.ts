import { runAws } from '../aws/exec.js';
import { stateParameterName } from '../naming.js';


/**
 * Reads a recorded state value.
 *
 * @returns The stored string, or `undefined` when the parameter does not exist —
 *   which means "never recorded", not "up to date".
 */
export async function readState(opts: {
  serviceName: string;
  key: string;
  region?: string;
  profile?: string;
}): Promise<string | undefined> {
  const result = await runAws(
    [
      'ssm',
      'get-parameter',
      '--name',
      stateParameterName(opts.serviceName, opts.key),
      '--query',
      'Parameter.Value',
      '--output',
      'text',
    ],
    { profile: opts.profile, region: opts.region },
  );
  if (result.exitCode !== 0) return undefined;
  const value = result.stdout.trim();
  return value === '' ? undefined : value;
}

/**
 * Records the value currently deployed. Plain `String`, not `SecureString`: a
 * digest or a Steam build id is not a secret, and SecureString would cost a KMS
 * call to read back.
 *
 * @throws When the parameter cannot be written.
 */
export async function writeState(opts: {
  serviceName: string;
  key: string;
  value: string;
  region?: string;
  profile?: string;
}): Promise<void> {
  const result = await runAws(
    [
      'ssm',
      'put-parameter',
      '--name',
      stateParameterName(opts.serviceName, opts.key),
      '--type',
      'String',
      '--overwrite',
      '--value',
      opts.value,
    ],
    { profile: opts.profile, region: opts.region },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to record state ${stateParameterName(opts.serviceName, opts.key)}: ${result.stderr.trim()}`,
    );
  }
}
