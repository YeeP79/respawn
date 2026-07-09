import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Everything that can change the built image. If none of these change, the image
 * cannot change, so the previously pushed one is still correct.
 */
export interface ImageInputs {
  /** Verbatim Dockerfile contents. */
  dockerfile: string;
  /** Resolved digest of the `FROM` base, e.g. `sha256:ab22…`. */
  baseDigest: string;
  /** Contents of every file the Dockerfile COPYs, keyed by repo-relative path. */
  copiedFiles: Record<string, string>;
}

/** Matches `FROM <ref>` ignoring `--platform=`, stage aliases and comments. */
const FROM_RE = /^\s*FROM\s+(?:--\S+\s+)*(\S+)/im;

/** Matches `COPY [--flags] <src>... <dst>`; captures the source operands. */
const COPY_RE = /^\s*COPY\s+((?:--\S+\s+)*)(.+)$/gim;

/**
 * Extracts the base image reference from a Dockerfile.
 *
 * @throws When the Dockerfile has no FROM instruction.
 */
export function parseBaseImage(dockerfile: string): string {
  const match = FROM_RE.exec(dockerfile);
  if (!match?.[1]) {
    throw new Error('Dockerfile has no FROM instruction.');
  }
  return match[1];
}

/**
 * Lists the source paths of every COPY instruction, relative to the build
 * context (the repo root). The final operand of a COPY is the destination.
 */
export function parseCopySources(dockerfile: string): string[] {
  const sources: string[] = [];
  COPY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COPY_RE.exec(dockerfile)) !== null) {
    const operands = match[2]!.trim().split(/\s+/);
    // Skip `COPY --from=stage`: those bytes come from another stage, not the context.
    if (/--from=/.test(match[1] ?? '')) continue;
    if (operands.length < 2) continue;
    sources.push(...operands.slice(0, -1));
  }
  return sources;
}

/**
 * Reads every build input for a service's Dockerfile.
 *
 * @param dockerfilePath - Absolute path to the Dockerfile.
 * @param workspaceRoot - Docker build context; COPY sources resolve against it.
 * @param baseDigest - Resolved digest of the FROM image.
 */
export function collectImageInputs(
  dockerfilePath: string,
  workspaceRoot: string,
  baseDigest: string,
): ImageInputs {
  const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');
  const copiedFiles: Record<string, string> = {};

  for (const source of parseCopySources(dockerfile)) {
    const absolute = path.resolve(workspaceRoot, source);
    if (!fs.existsSync(absolute)) continue;
    if (fs.statSync(absolute).isDirectory()) {
      for (const entry of fs.readdirSync(absolute, { recursive: true })) {
        const child = path.join(absolute, String(entry));
        if (fs.statSync(child).isFile()) {
          copiedFiles[path.relative(workspaceRoot, child)] = fs.readFileSync(
            child,
            'utf-8',
          );
        }
      }
    } else {
      copiedFiles[source] = fs.readFileSync(absolute, 'utf-8');
    }
  }

  return { dockerfile, baseDigest, copiedFiles };
}

/**
 * Content-addressed tag for an image: `sha-<12 hex>`.
 *
 * Keyed on what actually goes into the image, NOT on the git SHA. A git SHA is
 * wrong in both directions: `git rev-parse HEAD` ignores the working tree, so an
 * uncommitted Dockerfile edit would reuse a stale image; and an unrelated commit
 * changes the SHA, forcing a pointless rebuild and push.
 *
 * @example
 * ```typescript
 * const tag = computeImageTag(collectImageInputs(dockerfile, root, digest));
 * // 'sha-3f2a91c4be07'
 * ```
 */
export function computeImageTag(inputs: ImageInputs): string {
  const hash = createHash('sha256');
  hash.update('respawn-image-v1\n'); // salt: bump to force a fleet-wide rebuild
  hash.update(`base:${inputs.baseDigest}\n`);
  hash.update(`dockerfile:${inputs.dockerfile}\n`);

  // Sort so the tag does not depend on filesystem enumeration order.
  for (const file of Object.keys(inputs.copiedFiles).sort()) {
    hash.update(`file:${file}\n`);
    hash.update(inputs.copiedFiles[file]!);
    hash.update('\n');
  }

  return `sha-${hash.digest('hex').slice(0, 12)}`;
}
