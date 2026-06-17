import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import type { Environment, DiscoveredService } from '../config/types.js';
import { loadConfig } from '../config/loader.js';
import { logger } from './logger.js';

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

    const servicePath = path.join(appsDir, entry.name);
    const hasDockerfile = fs.existsSync(path.join(servicePath, 'Dockerfile'));
    const hasEnvFile = fs.existsSync(path.join(servicePath, '.env'));

    if (!hasEnvFile) {
      logger.debug(`Skipping ${entry.name}: missing .env`);
      continue;
    }

    if (!hasDockerfile) {
      // Allow services with IMAGE_URI set (no Dockerfile needed)
      const envContent = fs.readFileSync(path.join(servicePath, '.env'), 'utf-8');
      const env = parseDotenv(Buffer.from(envContent));
      if (!env['IMAGE_URI']) {
        logger.debug(`Skipping ${entry.name}: no Dockerfile and no IMAGE_URI`);
        continue;
      }
    }

    try {
      const config = loadConfig(servicePath, environment);
      services.push({ name: entry.name, path: servicePath, config });
      logger.debug(`Discovered service: ${entry.name}`);
    } catch (err) {
      logger.warn(
        `Failed to load config for ${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return services;
}
