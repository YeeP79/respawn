import * as path from 'node:path';
import * as fs from 'node:fs';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { discoverServices } from './stack-discovery.js';

const FIXTURES_DIR = path.join(__dirname, '__fixtures__');

function createService(
  name: string,
  opts: { dockerfile?: boolean; env?: boolean; envContent?: string } = {},
): void {
  const dir = path.join(FIXTURES_DIR, 'apps', name);
  fs.mkdirSync(dir, { recursive: true });

  if (opts.dockerfile !== false) {
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:24-slim');
  }

  if (opts.env !== false) {
    fs.writeFileSync(
      path.join(dir, '.env'),
      opts.envContent ?? `SERVICE_NAME=${name}`,
    );
  }
}

/** Writes a base `apps/<project>/.env` (the overlay target for that project's variants). */
function createBaseEnv(project: string, content: string): void {
  const dir = path.join(FIXTURES_DIR, 'apps', project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), content);
}

/** Writes one variant under `apps/<project>/variants/<variant>/`. */
function createVariant(
  project: string,
  variant: string,
  opts: { dockerfile?: boolean; env?: boolean; envContent?: string } = {},
): void {
  const dir = path.join(FIXTURES_DIR, 'apps', project, 'variants', variant);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.dockerfile !== false) {
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:24-slim');
  }
  if (opts.env !== false) {
    fs.writeFileSync(path.join(dir, '.env'), opts.envContent ?? `SERVICE_NAME=${project}-${variant}`);
  }
}

describe('discoverServices', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(FIXTURES_DIR, 'apps'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  });

  it('should discover services with both Dockerfile and .env', () => {
    createService('svc-a');
    createService('svc-b');

    const services = discoverServices(FIXTURES_DIR, 'dev');

    expect(services).toHaveLength(2);
    expect(services.map((s) => s.name).sort()).toEqual(['svc-a', 'svc-b']);
  });

  it('should skip services without Dockerfile', () => {
    createService('has-env', { dockerfile: false });
    createService('has-both');

    const services = discoverServices(FIXTURES_DIR, 'dev');

    expect(services).toHaveLength(1);
    expect(services[0]!.name).toBe('has-both');
  });

  it('should skip services without .env', () => {
    createService('no-env', { env: false });
    createService('has-both');

    const services = discoverServices(FIXTURES_DIR, 'dev');

    expect(services).toHaveLength(1);
    expect(services[0]!.name).toBe('has-both');
  });

  it('should skip the respawn directory', () => {
    createService('respawn');
    createService('game-svc');

    const services = discoverServices(FIXTURES_DIR, 'dev');

    expect(services).toHaveLength(1);
    expect(services[0]!.name).toBe('game-svc');
  });

  it('should return empty array if apps dir does not exist', () => {
    const services = discoverServices('/nonexistent', 'dev');
    expect(services).toEqual([]);
  });

  it('should load config for each discovered service', () => {
    createService('configured', {
      envContent: 'SERVICE_NAME=configured\nCPU=2048\nMEMORY=4096',
    });

    const services = discoverServices(FIXTURES_DIR, 'dev');

    expect(services).toHaveLength(1);
    expect(services[0]!.config.container.cpu).toBe(2048);
    expect(services[0]!.config.container.memory).toBe(4096);
  });

  it('should discover services with .env + IMAGE_URI but no Dockerfile', () => {
    createService('external-img', {
      dockerfile: false,
      envContent: 'SERVICE_NAME=external-img\nIMAGE_URI=ghcr.io/org/server:latest',
    });

    const services = discoverServices(FIXTURES_DIR, 'dev');

    expect(services).toHaveLength(1);
    expect(services[0]!.name).toBe('external-img');
    expect(services[0]!.config.image.imageUri).toBe('ghcr.io/org/server:latest');
  });

  it('should skip services without Dockerfile and without IMAGE_URI', () => {
    createService('no-docker-no-uri', {
      dockerfile: false,
      envContent: 'SERVICE_NAME=no-docker-no-uri',
    });
    createService('has-both');

    const services = discoverServices(FIXTURES_DIR, 'dev');

    expect(services).toHaveLength(1);
    expect(services[0]!.name).toBe('has-both');
  });

  describe('variants', () => {
    it('represents a project by its variants, named from each SERVICE_NAME', () => {
      createBaseEnv('game', 'CPU=512');
      createVariant('game', 'modded', { envContent: 'SERVICE_NAME=game' });
      createVariant('game', 'vanilla', { envContent: 'SERVICE_NAME=game-vanilla' });

      const services = discoverServices(FIXTURES_DIR, 'dev');

      expect(services.map((s) => s.name).sort()).toEqual(['game', 'game-vanilla']);
      // Each service resolves to a variant dir, not the project dir — the project
      // dir itself is never a service when it has a variants/ folder.
      expect(services.every((s) => s.path.includes(path.join('game', 'variants')))).toBe(true);
    });

    it('layers the variant .env over the project base .env (overlay wins)', () => {
      createBaseEnv('game', 'CPU=512\nMEMORY=1024');
      createVariant('game', 'modded', {
        envContent: 'SERVICE_NAME=game\nMEMORY=2048\nIMAGE_URI=org/modded:latest',
      });

      const [svc] = discoverServices(FIXTURES_DIR, 'dev');

      expect(svc!.name).toBe('game');
      expect(svc!.config.container.cpu).toBe(512); // base-only key survives
      expect(svc!.config.container.memory).toBe(2048); // overlay wins
      expect(svc!.config.image.imageUri).toBe('org/modded:latest'); // variant-only key
    });

    it('discovers variants alongside flat services', () => {
      createService('flat-svc');
      createBaseEnv('game', 'CPU=512');
      createVariant('game', 'vanilla', { envContent: 'SERVICE_NAME=game-vanilla' });

      const services = discoverServices(FIXTURES_DIR, 'dev');

      expect(services.map((s) => s.name).sort()).toEqual(['flat-svc', 'game-vanilla']);
    });

    it('skips a variant with neither a Dockerfile nor IMAGE_URI', () => {
      createBaseEnv('game', 'CPU=512');
      createVariant('game', 'ok', { envContent: 'SERVICE_NAME=game' });
      createVariant('game', 'broken', {
        dockerfile: false,
        envContent: 'SERVICE_NAME=game-broken',
      });

      const services = discoverServices(FIXTURES_DIR, 'dev');

      expect(services.map((s) => s.name)).toEqual(['game']);
    });

    it('works without a project base .env (variant is self-contained)', () => {
      createVariant('game', 'solo', { envContent: 'SERVICE_NAME=game-solo\nCPU=1024' });

      const [svc] = discoverServices(FIXTURES_DIR, 'dev');

      expect(svc!.name).toBe('game-solo');
      expect(svc!.config.container.cpu).toBe(1024);
    });
  });
});
