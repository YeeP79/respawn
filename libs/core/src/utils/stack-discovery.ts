import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import type { Environment, DiscoveredService, GameServerConfig } from '../config/types.js';
import { loadConfig } from '../config/loader.js';
import { logger } from './logger.js';

/**
 * Loads one service directory, applying the same guards discovery has always used:
 * an absent `.env` skips silently, and a Dockerfile-less dir needs `IMAGE_URI`.
 * `baseEnvPath`, when given, is a project `.env` the dir's own env layers over — the
 * variant overlay. Returns undefined (never throws) so one bad service cannot take
 * down discovery of the rest.
 */
function loadService(
  serviceDir: string,
  environment: Environment,
  baseEnvPath: string | undefined,
  label: string,
): GameServerConfig | undefined {
  const hasDockerfile = fs.existsSync(path.join(serviceDir, 'Dockerfile'));
  const envFilePath = path.join(serviceDir, '.env');

  if (!fs.existsSync(envFilePath)) {
    logger.debug(`Skipping ${label}: missing .env`);
    return undefined;
  }
  if (!hasDockerfile) {
    const env = parseDotenv(Buffer.from(fs.readFileSync(envFilePath, 'utf-8')));
    if (!env['IMAGE_URI']) {
      logger.debug(`Skipping ${label}: no Dockerfile and no IMAGE_URI`);
      return undefined;
    }
  }
  try {
    const config = loadConfig(serviceDir, environment, baseEnvPath);
    logger.debug(`Discovered service: ${config.serviceName}`);
    return config;
  } catch (err) {
    logger.warn(
      `Failed to load config for ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export function discoverServices(
  workspaceRoot: string,
  environment: Environment,
): DiscoveredService[] {
  const appsDir = path.join(workspaceRoot, 'apps');
  const services: DiscoveredService[] = [];

  if (!fs.existsSync(appsDir)) {
    logger.warn(`Apps directory not found: ${appsDir}`);
    return services;
  }

  const entries = fs.readdirSync(appsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Skip the respawn app itself
    if (entry.name === 'respawn') continue;

    const dir = path.join(appsDir, entry.name);
    const variantsDir = path.join(dir, 'variants');

    // A project with a `variants/` dir is represented ONLY by its variants — each is a
    // service in its own right, layered over the project's shared `.env`. Its identity
    // is author-controlled via SERVICE_NAME (so `name` == config.serviceName keeps the
    // dir-name and serviceName identities in sync for a variant).
    if (fs.existsSync(variantsDir) && fs.statSync(variantsDir).isDirectory()) {
      const projectEnv = path.join(dir, '.env');
      const baseEnvPath = fs.existsSync(projectEnv) ? projectEnv : undefined;
      for (const variant of fs.readdirSync(variantsDir, { withFileTypes: true })) {
        if (!variant.isDirectory()) continue;
        const variantDir = path.join(variantsDir, variant.name);
        const label = `${entry.name}/${variant.name}`;
        const config = loadService(variantDir, environment, baseEnvPath, label);
        if (config) services.push({ name: config.serviceName, path: variantDir, config });
      }
      continue;
    }

    // Flat project: today's behavior, keyed on the directory name.
    const config = loadService(dir, environment, undefined, entry.name);
    if (config) services.push({ name: entry.name, path: dir, config });
  }

  return services;
}
