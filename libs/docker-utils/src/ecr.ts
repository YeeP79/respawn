import { spawn } from 'node:child_process';

function run(
  command: string,
  args: string[],
  options?: { input?: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: [options?.input ? 'pipe' : 'inherit', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    if (options?.input && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }

    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
  });
}

export async function ecrLogin(
  registry: string,
  region: string,
): Promise<void> {
  // Get the login password from AWS
  const passwordResult = await run('aws', [
    'ecr',
    'get-login-password',
    '--region',
    region,
  ]);

  if (passwordResult.exitCode !== 0) {
    throw new Error('Failed to get ECR login password');
  }

  const password = passwordResult.stdout.trim();

  // Login to Docker with the password
  const loginResult = await run(
    'docker',
    ['login', '--username', 'AWS', '--password-stdin', registry],
    { input: password },
  );

  if (loginResult.exitCode !== 0) {
    throw new Error('Failed to login to ECR');
  }
}

export async function pushImage(options: {
  registry: string;
  repository: string;
  tag: string;
  region?: string;
}): Promise<void> {
  const fullTag = `${options.registry}/${options.repository}:${options.tag}`;

  const result = await run('docker', ['push', fullTag]);
  if (result.exitCode !== 0) {
    throw new Error(`Docker push failed with exit code ${result.exitCode}`);
  }
}

/**
 * Reports whether a tag already exists in an ECR repository.
 *
 * Used to skip a build+push when the content-addressed tag is already present.
 * A missing repository counts as "absent", not an error: the shared stack
 * creates it on the first deploy.
 *
 * @param options.repository - Repository name, e.g. `respawn/cs16`.
 * @param options.tag - Image tag to look for, e.g. `sha-3f2a91c4be07`.
 */
/** Runs the AWS CLI capturing output; a non-zero exit means "not found". */
function runAwsQuiet(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('aws', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on('error', (err) => resolve({ exitCode: 1, stdout, stderr: err.message }));
  });
}

export async function imageTagExists(options: {
  repository: string;
  tag: string;
  region?: string;
  profile?: string;
}): Promise<boolean> {
  const args = [
    'ecr',
    'describe-images',
    '--repository-name',
    options.repository,
    '--image-ids',
    `imageTag=${options.tag}`,
  ];
  if (options.region) args.push('--region', options.region);
  if (options.profile) args.push('--profile', options.profile);

  const result = await runAwsQuiet(args);
  return result.exitCode === 0;
}
