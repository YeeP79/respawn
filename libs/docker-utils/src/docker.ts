import { spawn } from 'node:child_process';

export interface BuildImageResult {
  imageId: string;
  size: string;
}

function run(
  command: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.on('error', (err) => {
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
  });
}

export async function buildImage(options: {
  context: string;
  dockerfile: string;
  tag: string;
  buildArgs?: Record<string, string>;
}): Promise<BuildImageResult> {
  const args = ['build', '-t', options.tag, '-f', options.dockerfile];

  if (options.buildArgs) {
    for (const [key, value] of Object.entries(options.buildArgs)) {
      args.push('--build-arg', `${key}=${value}`);
    }
  }

  args.push(options.context);

  const result = await run('docker', args);
  if (result.exitCode !== 0) {
    throw new Error(`Docker build failed with exit code ${result.exitCode}`);
  }

  const size = await getImageSize(options.tag);
  const imageId = await getImageId(options.tag);

  return { imageId, size };
}

export async function tagImage(
  source: string,
  target: string,
): Promise<void> {
  const result = await run('docker', ['tag', source, target]);
  if (result.exitCode !== 0) {
    throw new Error(`Docker tag failed with exit code ${result.exitCode}`);
  }
}

export async function hasBuildx(): Promise<boolean> {
  try {
    const result = await run('docker', ['buildx', 'version']);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function getImageSize(tag: string): Promise<string> {
  const result = await run('docker', [
    'inspect',
    '--format',
    '{{.Size}}',
    tag,
  ]);
  if (result.exitCode !== 0) return 'unknown';
  const bytes = parseInt(result.stdout.trim(), 10);
  if (isNaN(bytes)) return 'unknown';
  const mb = (bytes / 1024 / 1024).toFixed(1);
  return `${mb} MB`;
}

async function getImageId(tag: string): Promise<string> {
  const result = await run('docker', [
    'inspect',
    '--format',
    '{{.Id}}',
    tag,
  ]);
  if (result.exitCode !== 0) return 'unknown';
  return result.stdout.trim();
}
