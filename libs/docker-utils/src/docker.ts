import { spawn } from 'node:child_process';

/** Runs a command capturing output without echoing it (JSON-safe). */
function runQuiet(
  command: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on('error', (err) => resolve({ exitCode: 1, stdout, stderr: err.message }));
  });
}

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

/**
 * Resolves a base image reference to its immutable content digest.
 *
 * A tag like `jives/hlds:cstrike` is mutable — upstream can republish it. The
 * digest is what actually determines the bytes we build on, so it belongs in the
 * image content hash; without it a rebuilt Dockerfile would never notice a new
 * base.
 *
 * @param reference - Image reference, e.g. `jives/hlds:cstrike`.
 * @returns The manifest digest, e.g. `sha256:ab22…`.
 * @throws When the reference cannot be resolved (unknown tag, network, or an
 *   obsolete v1 manifest that the daemon refuses).
 */
export async function resolveBaseImageDigest(
  reference: string,
): Promise<string> {
  const result = await runQuiet('docker', [
    'manifest',
    'inspect',
    '-v',
    reference,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not resolve digest for base image "${reference}": ${result.stderr.trim()}`,
    );
  }

  const parsed: unknown = JSON.parse(result.stdout);
  // A multi-arch reference yields an array of per-platform descriptors; a single
  // manifest yields one object. Either way the top-level Descriptor.digest is
  // the reference's own digest.
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  const digest = (first as { Descriptor?: { digest?: string } })?.Descriptor
    ?.digest;
  if (!digest) {
    throw new Error(
      `Unexpected "docker manifest inspect" output for "${reference}".`,
    );
  }
  return digest;
}
