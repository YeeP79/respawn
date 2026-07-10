import * as path from 'node:path';
import * as fs from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './loader.js';

const FIXTURES_DIR = path.join(__dirname, '__fixtures__');

function writeEnvFile(dir: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env'), content);
}

describe('loadConfig', () => {
  beforeEach(() => {
    fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  });

  it('should load defaults when .env is minimal', () => {
    const dir = path.join(FIXTURES_DIR, 'minimal');
    writeEnvFile(dir, 'SERVICE_NAME=test-svc');

    const config = loadConfig(dir, 'dev');

    expect(config.serviceName).toBe('test-svc');
    expect(config.container.cpu).toBe(1024);
    expect(config.container.memory).toBe(2048);
    expect(config.networking.protocol).toBe('UDP');
    expect(config.networking.containerPort).toBe(7777);
    expect(config.scaling.desiredCount).toBe(1);
  });

  it('should parse env values over defaults', () => {
    const dir = path.join(FIXTURES_DIR, 'custom');
    writeEnvFile(
      dir,
      [
        'SERVICE_NAME=custom-svc',
        'CPU=2048',
        'MEMORY=4096',
        'CONTAINER_PORT=8080',
        'PROTOCOL=TCP',
        'DESIRED_COUNT=3',
      ].join('\n'),
    );

    const config = loadConfig(dir, 'dev');

    expect(config.container.cpu).toBe(2048);
    expect(config.container.memory).toBe(4096);
    expect(config.networking.containerPort).toBe(8080);
    expect(config.networking.protocol).toBe('TCP');
    expect(config.scaling.desiredCount).toBe(3);
  });

  it('should apply environment overrides for dev', () => {
    const dir = path.join(FIXTURES_DIR, 'env-dev');
    writeEnvFile(dir, 'SERVICE_NAME=dev-svc');

    const config = loadConfig(dir, 'dev');

    expect(config.logging.retentionDays).toBe(7);
    expect(config.cost.useFargateSpot).toBe(true);
  });

  it('should apply environment overrides for prod', () => {
    const dir = path.join(FIXTURES_DIR, 'env-prod');
    writeEnvFile(dir, 'SERVICE_NAME=prod-svc');

    const config = loadConfig(dir, 'prod');

    expect(config.logging.retentionDays).toBe(30);
    expect(config.cost.useFargateSpot).toBe(false);
    expect(config.scaling.minCapacity).toBe(1);
  });

  it('should parse GAME_ENV_ prefixed vars', () => {
    const dir = path.join(FIXTURES_DIR, 'game-env');
    writeEnvFile(
      dir,
      [
        'SERVICE_NAME=game-svc',
        'GAME_ENV_MAX_PLAYERS=32',
        'GAME_ENV_MAP=arena',
      ].join('\n'),
    );

    const config = loadConfig(dir, 'dev');

    expect(config.gameEnvVars).toEqual({
      MAX_PLAYERS: '32',
      MAP: 'arena',
    });
  });

  it('should parse SECRET_REFS into typed refs (sm, ssm, jsonKey)', () => {
    const dir = path.join(FIXTURES_DIR, 'secrets');
    writeEnvFile(
      dir,
      [
        'SERVICE_NAME=secret-svc',
        'SECRET_REFS=RCON_PASSWORD=sm:respawn/svc/rcon,GSLT=ssm:/respawn/svc/gslt,DB=sm:respawn/svc/db|password',
      ].join('\n'),
    );

    const config = loadConfig(dir, 'dev');

    expect(config.secretRefs).toEqual([
      {
        containerEnvVar: 'RCON_PASSWORD',
        store: 'sm',
        sourceId: 'respawn/svc/rcon',
        jsonKey: undefined,
      },
      {
        containerEnvVar: 'GSLT',
        store: 'ssm',
        sourceId: '/respawn/svc/gslt',
        jsonKey: undefined,
      },
      {
        containerEnvVar: 'DB',
        store: 'sm',
        sourceId: 'respawn/svc/db',
        jsonKey: 'password',
      },
    ]);
  });

  it('should handle empty SECRET_REFS', () => {
    const dir = path.join(FIXTURES_DIR, 'no-secrets');
    writeEnvFile(dir, 'SERVICE_NAME=no-secret-svc\nSECRET_REFS=');

    const config = loadConfig(dir, 'dev');

    expect(config.secretRefs).toEqual([]);
  });

  it('should throw on SECRET_REFS missing store prefix', () => {
    const dir = path.join(FIXTURES_DIR, 'bad-secret-store');
    writeEnvFile(
      dir,
      'SERVICE_NAME=bad-secret\nSECRET_REFS=RCON_PASSWORD=respawn/svc/rcon',
    );

    expect(() => loadConfig(dir, 'dev')).toThrow('Missing store prefix');
  });

  it('should throw on invalid SECRET_REFS store', () => {
    const dir = path.join(FIXTURES_DIR, 'bad-secret-store2');
    writeEnvFile(
      dir,
      'SERVICE_NAME=bad-secret\nSECRET_REFS=RCON_PASSWORD=vault:respawn/svc/rcon',
    );

    expect(() => loadConfig(dir, 'dev')).toThrow('Must be "sm" or "ssm"');
  });

  it('should throw on jsonKey used with ssm', () => {
    const dir = path.join(FIXTURES_DIR, 'bad-secret-jsonkey');
    writeEnvFile(
      dir,
      'SERVICE_NAME=bad-secret\nSECRET_REFS=TOKEN=ssm:/respawn/svc/token|field',
    );

    expect(() => loadConfig(dir, 'dev')).toThrow(
      'jsonKey (|) is only valid for "sm:" secrets',
    );
  });

  it('should parse DEPLOY_PROMPTS into typed prompts', () => {
    const dir = path.join(FIXTURES_DIR, 'deploy-prompts');
    writeEnvFile(
      dir,
      [
        'SERVICE_NAME=prompt-svc',
        'DEPLOY_PROMPTS=GAMEMODE:select:ttt|prop_hunt|darkrp,DIFFICULTY:select:easy|hard',
      ].join('\n'),
    );

    const config = loadConfig(dir, 'dev');

    expect(config.deployPrompts).toEqual([
      {
        envVar: 'GAMEMODE',
        type: 'select',
        options: ['ttt', 'prop_hunt', 'darkrp'],
      },
      { envVar: 'DIFFICULTY', type: 'select', options: ['easy', 'hard'] },
    ]);
  });

  it('should default DEPLOY_PROMPTS to empty', () => {
    const dir = path.join(FIXTURES_DIR, 'no-deploy-prompts');
    writeEnvFile(dir, 'SERVICE_NAME=no-prompt-svc');

    const config = loadConfig(dir, 'dev');

    expect(config.deployPrompts).toEqual([]);
  });

  it('should throw on unsupported DEPLOY_PROMPTS type', () => {
    const dir = path.join(FIXTURES_DIR, 'bad-deploy-prompt-type');
    writeEnvFile(
      dir,
      'SERVICE_NAME=bad\nDEPLOY_PROMPTS=GAMEMODE:text:ttt',
    );

    expect(() => loadConfig(dir, 'dev')).toThrow('Only "select" is supported');
  });

  it('should throw on malformed DEPLOY_PROMPTS entry', () => {
    const dir = path.join(FIXTURES_DIR, 'bad-deploy-prompt');
    writeEnvFile(dir, 'SERVICE_NAME=bad\nDEPLOY_PROMPTS=GAMEMODE');

    expect(() => loadConfig(dir, 'dev')).toThrow(
      'Invalid DEPLOY_PROMPTS entry',
    );
  });

  it('should throw on invalid CPU value', () => {
    const dir = path.join(FIXTURES_DIR, 'bad-cpu');
    writeEnvFile(dir, 'SERVICE_NAME=bad-cpu\nCPU=999');

    expect(() => loadConfig(dir, 'dev')).toThrow('Invalid CPU value: 999');
  });

  it('should throw on incompatible memory for CPU', () => {
    const dir = path.join(FIXTURES_DIR, 'bad-mem');
    writeEnvFile(dir, 'SERVICE_NAME=bad-mem\nCPU=256\nMEMORY=4096');

    expect(() => loadConfig(dir, 'dev')).toThrow(
      'Invalid memory 4096 MiB for CPU 256',
    );
  });

  it('should throw on invalid port', () => {
    const dir = path.join(FIXTURES_DIR, 'bad-port');
    writeEnvFile(dir, 'SERVICE_NAME=bad-port\nCONTAINER_PORT=0');

    expect(() => loadConfig(dir, 'dev')).toThrow('Invalid containerPort: 0');
  });

  it('should throw when http check method is used without statusEndpoint', () => {
    const dir = path.join(FIXTURES_DIR, 'bad-http');
    writeEnvFile(
      dir,
      'SERVICE_NAME=bad-http\nIDLE_CHECK_METHOD=http\nIDLE_STATUS_ENDPOINT=',
    );

    expect(() => loadConfig(dir, 'dev')).toThrow(
      'statusEndpoint is required when checkMethod is "http"',
    );
  });

  it('should throw when autoscaling min > max', () => {
    const dir = path.join(FIXTURES_DIR, 'bad-scale');
    writeEnvFile(
      dir,
      'SERVICE_NAME=bad-scale\nENABLE_AUTOSCALING=true\nMIN_CAPACITY=5\nMAX_CAPACITY=2',
    );

    expect(() => loadConfig(dir, 'dev')).toThrow(
      'minCapacity (5) must be <= maxCapacity (2)',
    );
  });

  it('should use directory name when SERVICE_NAME is not set', () => {
    const dir = path.join(FIXTURES_DIR, 'fallback-name');
    writeEnvFile(dir, '');

    const config = loadConfig(dir, 'dev');

    expect(config.serviceName).toBe('fallback-name');
  });

  it('should parse booleans correctly', () => {
    const dir = path.join(FIXTURES_DIR, 'booleans');
    writeEnvFile(
      dir,
      [
        'SERVICE_NAME=bool-svc',
        'ENABLE_PUBLIC_ACCESS=false',
        'USE_FARGATE_SPOT=true',
        'ENABLE_IDLE_SHUTDOWN=false',
      ].join('\n'),
    );

    const config = loadConfig(dir, 'staging');

    expect(config.networking.enablePublicAccess).toBe(false);
    expect(config.idleShutdown.enabled).toBe(false);
  });

  it('should apply default tags', () => {
    const dir = path.join(FIXTURES_DIR, 'tags');
    writeEnvFile(dir, 'SERVICE_NAME=tagged-svc');

    const config = loadConfig(dir, 'dev');

    expect(config.tags.environment).toBe('dev');
    expect(config.tags.service).toBe('tagged-svc');
    expect(config.tags.managedBy).toBe('respawn');
    expect(config.tags.deployedAt).toBeDefined();
  });

  // --- Additional ports ---

  it('should parse ADDITIONAL_PORTS with simple format', () => {
    const dir = path.join(FIXTURES_DIR, 'addl-ports');
    writeEnvFile(
      dir,
      'SERVICE_NAME=multi-port\nADDITIONAL_PORTS=2457/udp,2458/udp,80/tcp',
    );

    const config = loadConfig(dir, 'dev');

    expect(config.networking.additionalPorts).toEqual([
      { containerPort: 2457, hostPort: 2457, protocol: 'UDP' },
      { containerPort: 2458, hostPort: 2458, protocol: 'UDP' },
      { containerPort: 80, hostPort: 80, protocol: 'TCP' },
    ]);
  });

  it('should parse ADDITIONAL_PORTS with host:container format', () => {
    const dir = path.join(FIXTURES_DIR, 'addl-ports-mapped');
    writeEnvFile(
      dir,
      'SERVICE_NAME=mapped-port\nADDITIONAL_PORTS=8080:80/tcp',
    );

    const config = loadConfig(dir, 'dev');

    expect(config.networking.additionalPorts).toEqual([
      { containerPort: 80, hostPort: 8080, protocol: 'TCP' },
    ]);
  });

  it('should default to empty additionalPorts when not set', () => {
    const dir = path.join(FIXTURES_DIR, 'no-addl-ports');
    writeEnvFile(dir, 'SERVICE_NAME=no-extra');

    const config = loadConfig(dir, 'dev');

    expect(config.networking.additionalPorts).toEqual([]);
  });

  it('should throw on invalid ADDITIONAL_PORTS format (no protocol)', () => {
    const dir = path.join(FIXTURES_DIR, 'bad-addl-ports');
    writeEnvFile(dir, 'SERVICE_NAME=bad-ports\nADDITIONAL_PORTS=2457');

    expect(() => loadConfig(dir, 'dev')).toThrow('Invalid additional port format');
  });

  it('should throw on invalid ADDITIONAL_PORTS protocol', () => {
    const dir = path.join(FIXTURES_DIR, 'bad-proto');
    writeEnvFile(dir, 'SERVICE_NAME=bad-proto\nADDITIONAL_PORTS=2457/icmp');

    expect(() => loadConfig(dir, 'dev')).toThrow('Invalid protocol');
  });

  // --- Container command ---

  it('should parse CONTAINER_COMMAND into string array', () => {
    const dir = path.join(FIXTURES_DIR, 'cmd');
    writeEnvFile(
      dir,
      'SERVICE_NAME=cmd-svc\nCONTAINER_COMMAND=+log on +map ctf_2fort',
    );

    const config = loadConfig(dir, 'dev');

    expect(config.container.command).toEqual(['+log', 'on', '+map', 'ctf_2fort']);
  });

  it('should leave command undefined when CONTAINER_COMMAND is not set', () => {
    const dir = path.join(FIXTURES_DIR, 'no-cmd');
    writeEnvFile(dir, 'SERVICE_NAME=no-cmd');

    const config = loadConfig(dir, 'dev');

    expect(config.container.command).toBeUndefined();
  });

  // --- Persistent storage ---

  it('should parse persistent storage config', () => {
    const dir = path.join(FIXTURES_DIR, 'persist');
    writeEnvFile(
      dir,
      'SERVICE_NAME=persist-svc\nENABLE_PERSISTENT_STORAGE=true\nPERSISTENT_MOUNT_PATH=/config',
    );

    const config = loadConfig(dir, 'dev');

    expect(config.persistentStorage.enabled).toBe(true);
    expect(config.persistentStorage.mountPath).toBe('/config');
  });

  it('should default persistent storage to disabled', () => {
    const dir = path.join(FIXTURES_DIR, 'no-persist');
    writeEnvFile(dir, 'SERVICE_NAME=no-persist');

    const config = loadConfig(dir, 'dev');

    expect(config.persistentStorage.enabled).toBe(false);
    expect(config.persistentStorage.mountPath).toBe('/data');
  });

  // --- IMAGE_URI ---

  it('should parse IMAGE_URI', () => {
    const dir = path.join(FIXTURES_DIR, 'image-uri');
    writeEnvFile(
      dir,
      'SERVICE_NAME=ext-img\nIMAGE_URI=ghcr.io/org/server:latest',
    );

    const config = loadConfig(dir, 'dev');

    expect(config.image.imageUri).toBe('ghcr.io/org/server:latest');
  });

  it('should leave imageUri undefined when not set', () => {
    const dir = path.join(FIXTURES_DIR, 'no-image-uri');
    writeEnvFile(dir, 'SERVICE_NAME=local-build');

    const config = loadConfig(dir, 'dev');

    expect(config.image.imageUri).toBeUndefined();
  });

  describe('INTERNAL_PORTS', () => {
    it('parses internal ports separately from additional ports', () => {
      const dir = path.join(FIXTURES_DIR, 'internal-ports');
      writeEnvFile(
        dir,
        'SERVICE_NAME=x\nADDITIONAL_PORTS=27005/udp\nINTERNAL_PORTS=27015/tcp',
      );
      const { networking } = loadConfig(dir, 'dev');
      expect(networking.additionalPorts).toEqual([
        { containerPort: 27005, hostPort: 27005, protocol: 'UDP' },
      ]);
      expect(networking.internalPorts).toEqual([
        { containerPort: 27015, hostPort: 27015, protocol: 'TCP' },
      ]);
    });

    it('defaults internalPorts to empty', () => {
      const dir = path.join(FIXTURES_DIR, 'no-internal');
      writeEnvFile(dir, 'SERVICE_NAME=x');
      expect(loadConfig(dir, 'dev').networking.internalPorts).toEqual([]);
    });
  });

  describe('idle check method', () => {
    it.each([
      ['netstat', 'netstat'],
      ['http', 'http'],
      ['a2s', 'a2s'],
      ['A2S', 'a2s'],
      ['q3', 'q3'],
      ['gamespy', 'gamespy'],
      ['GameSpy', 'gamespy'],
      ['zandronum', 'zandronum'],
    ])('accepts %s', (given, expected) => {
      const dir = path.join(FIXTURES_DIR, `idle-${given}`);
      const extra = given.toLowerCase() === 'http'
        ? '\nIDLE_STATUS_ENDPOINT=http://localhost/status.json'
        : '';
      writeEnvFile(dir, `SERVICE_NAME=idle\nIDLE_CHECK_METHOD=${given}${extra}`);
      expect(loadConfig(dir, 'dev').idleShutdown.checkMethod).toBe(expected);
    });

    it('falls back to the default for an unknown method', () => {
      const dir = path.join(FIXTURES_DIR, 'idle-bogus');
      writeEnvFile(dir, 'SERVICE_NAME=idle\nIDLE_CHECK_METHOD=carrier-pigeon');
      expect(loadConfig(dir, 'dev').idleShutdown.checkMethod).toBe('netstat');
    });

    it('still requires a status endpoint for http', () => {
      const dir = path.join(FIXTURES_DIR, 'idle-http-bare');
      writeEnvFile(dir, 'SERVICE_NAME=idle\nIDLE_CHECK_METHOD=http');
      expect(() => loadConfig(dir, 'dev')).toThrow(/statusEndpoint is required/);
    });

    it('does not require a status endpoint for a2s', () => {
      const dir = path.join(FIXTURES_DIR, 'idle-a2s-bare');
      writeEnvFile(dir, 'SERVICE_NAME=idle\nIDLE_CHECK_METHOD=a2s');
      expect(() => loadConfig(dir, 'dev')).not.toThrow();
    });

    it('defaults queryPort to undefined and timeout to 4s', () => {
      const dir = path.join(FIXTURES_DIR, 'idle-defaults');
      writeEnvFile(dir, 'SERVICE_NAME=idle\nIDLE_CHECK_METHOD=a2s');
      const { idleShutdown } = loadConfig(dir, 'dev');
      expect(idleShutdown.queryPort).toBeUndefined();
      expect(idleShutdown.queryTimeoutSeconds).toBe(4);
    });

    it('parses an explicit query port (Rust queries on 28017)', () => {
      const dir = path.join(FIXTURES_DIR, 'idle-qport');
      writeEnvFile(
        dir,
        'SERVICE_NAME=rust\nIDLE_CHECK_METHOD=a2s\nIDLE_QUERY_PORT=28017\nIDLE_QUERY_TIMEOUT_SECONDS=6',
      );
      const { idleShutdown } = loadConfig(dir, 'dev');
      expect(idleShutdown.queryPort).toBe(28017);
      expect(idleShutdown.queryTimeoutSeconds).toBe(6);
    });

    it.each([['0'], ['70000']])('rejects an out-of-range query port %s', (p) => {
      const dir = path.join(FIXTURES_DIR, `idle-qport-${p}`);
      writeEnvFile(dir, `SERVICE_NAME=idle\nIDLE_QUERY_PORT=${p}`);
      expect(() => loadConfig(dir, 'dev')).toThrow(/Invalid IDLE_QUERY_PORT/);
    });

    it('rejects a non-positive query timeout', () => {
      const dir = path.join(FIXTURES_DIR, 'idle-qtimeout');
      writeEnvFile(dir, 'SERVICE_NAME=idle\nIDLE_QUERY_TIMEOUT_SECONDS=0');
      expect(() => loadConfig(dir, 'dev')).toThrow(
        /Invalid IDLE_QUERY_TIMEOUT_SECONDS/,
      );
    });
  });

  describe('UPDATE_CHECK', () => {
    it('parses image, build and steam entries', () => {
      const dir = path.join(FIXTURES_DIR, 'uc-mix');
      writeEnvFile(dir, 'SERVICE_NAME=x\nIMAGE_URI=a/b:c\nUPDATE_CHECK=image,steam:730');
      expect(loadConfig(dir, 'dev').updateChecks).toEqual([
        { kind: 'image' },
        { kind: 'steam', appId: '730' },
      ]);
    });

    it('defaults to no checks, and treats "none" as no checks', () => {
      const dir = path.join(FIXTURES_DIR, 'uc-none');
      writeEnvFile(dir, 'SERVICE_NAME=x\nUPDATE_CHECK=none');
      expect(loadConfig(dir, 'dev').updateChecks).toEqual([]);
    });

    it('rejects an unknown kind', () => {
      const dir = path.join(FIXTURES_DIR, 'uc-bogus');
      writeEnvFile(dir, 'SERVICE_NAME=x\nUPDATE_CHECK=carrier-pigeon');
      expect(() => loadConfig(dir, 'dev')).toThrow(/Invalid UPDATE_CHECK entry/);
    });

    it('rejects a steam entry without a numeric app id', () => {
      const dir = path.join(FIXTURES_DIR, 'uc-steam-bad');
      writeEnvFile(dir, 'SERVICE_NAME=x\nUPDATE_CHECK=steam:cs2');
      expect(() => loadConfig(dir, 'dev')).toThrow(/Invalid UPDATE_CHECK entry/);
    });

    it('rejects image on a locally built service', () => {
      const dir = path.join(FIXTURES_DIR, 'uc-image-nobuild');
      writeEnvFile(dir, 'SERVICE_NAME=x\nUPDATE_CHECK=image');
      expect(() => loadConfig(dir, 'dev')).toThrow(/requires IMAGE_URI/);
    });

    it('rejects build on an upstream-image service', () => {
      const dir = path.join(FIXTURES_DIR, 'uc-build-upstream');
      writeEnvFile(dir, 'SERVICE_NAME=x\nIMAGE_URI=a/b:c\nUPDATE_CHECK=build');
      expect(() => loadConfig(dir, 'dev')).toThrow(/requires a locally built image/);
    });
  });

  describe('rcon-control', () => {
    it('parses protocol and port', () => {
      const dir = path.join(FIXTURES_DIR, 'rc-on');
      writeEnvFile(dir, [
        'SERVICE_NAME=x',
        'SECRET_REFS=RCON_PASSWORD=sm:respawn/x/rcon',
        'ENABLE_RCON_CONTROL=true',
        'RCON_PROTOCOL=source',
        'RCON_PORT=27016',
      ].join('\n'));
      const { rconControl } = loadConfig(dir, 'dev');
      expect(rconControl).toMatchObject({
        enabled: true,
        protocol: 'source',
        passwordSecretVar: 'RCON_PASSWORD',
        port: 27016,
      });
    });

    it('defaults to disabled', () => {
      const dir = path.join(FIXTURES_DIR, 'rc-off');
      writeEnvFile(dir, 'SERVICE_NAME=x');
      expect(loadConfig(dir, 'dev').rconControl.enabled).toBe(false);
    });

    it('defaults protocol to goldsrc', () => {
      const dir = path.join(FIXTURES_DIR, 'rc-default-proto');
      writeEnvFile(dir, 'SERVICE_NAME=x\nSECRET_REFS=RCON_PASSWORD=sm:respawn/x/rcon\nENABLE_RCON_CONTROL=true');
      expect(loadConfig(dir, 'dev').rconControl.protocol).toBe('goldsrc');
    });

    it('accepts the query-only gamespy protocol', () => {
      const dir = path.join(FIXTURES_DIR, 'rc-gamespy');
      writeEnvFile(dir, [
        'SERVICE_NAME=x',
        'SECRET_REFS=UT_ADMINPWD=sm:respawn/x/admin',
        'ENABLE_RCON_CONTROL=true',
        'RCON_PROTOCOL=gamespy',
        'RCON_PORT=7778',
        'RCON_PASSWORD_VAR=UT_ADMINPWD',
      ].join('\n'));
      expect(loadConfig(dir, 'dev').rconControl).toMatchObject({
        protocol: 'gamespy',
        port: 7778,
        passwordSecretVar: 'UT_ADMINPWD',
      });
    });

    it('rejects an unknown protocol instead of falling back to goldsrc', () => {
      // A silent fallback would point the sidecar at the wrong wire protocol and every
      // rcon call would time out with nothing to explain why.
      const dir = path.join(FIXTURES_DIR, 'rc-bad-proto');
      writeEnvFile(dir, [
        'SERVICE_NAME=x',
        'SECRET_REFS=RCON_PASSWORD=sm:respawn/x/rcon',
        'ENABLE_RCON_CONTROL=true',
        'RCON_PROTOCOL=goldsrk',
      ].join('\n'));
      expect(() => loadConfig(dir, 'dev')).toThrow(/Invalid RCON_PROTOCOL/);
    });

    it('rejects enablement without the rcon secret', () => {
      const dir = path.join(FIXTURES_DIR, 'rc-nosecret');
      writeEnvFile(dir, 'SERVICE_NAME=x\nENABLE_RCON_CONTROL=true');
      expect(() => loadConfig(dir, 'dev')).toThrow(/needs the rcon password in SECRET_REFS/);
    });

    it('honours RCON_PASSWORD_VAR for a differently-named secret', () => {
      const dir = path.join(FIXTURES_DIR, 'rc-altvar');
      writeEnvFile(dir, [
        'SERVICE_NAME=x',
        'SECRET_REFS=CS2_RCONPW=sm:respawn/x/rcon',
        'ENABLE_RCON_CONTROL=true',
        'RCON_PASSWORD_VAR=CS2_RCONPW',
      ].join('\n'));
      expect(() => loadConfig(dir, 'dev')).not.toThrow();
    });
  });

  describe('plaintext secret rejection', () => {
    function load(name: string, content: string) {
      const dir = path.join(FIXTURES_DIR, name);
      writeEnvFile(dir, `SERVICE_NAME=${name}\n${content}`);
      return () => loadConfig(dir, 'dev');
    }

    it.each([
      ['GAME_ENV_RCON_PASSWORD=changeme', 'RCON_PASSWORD'],
      ['GAME_ENV_SRCDS_TOKEN=abc123', 'SRCDS_TOKEN'],
      ['GAME_ENV_SRCDS_RCONPW=abc123', 'SRCDS_RCONPW'],
      ['GAME_ENV_SERVER_PASS=hunter2', 'SERVER_PASS'],
      ['GAME_ENV_UT_ADMINPWD=hunter2', 'UT_ADMINPWD'],
    ])('rejects %s as a plaintext game env var', (line, key) => {
      expect(load(`env-${key}`, line)).toThrow(/looks like a credential/);
    });

    it('names SECRET_REFS as the remedy', () => {
      expect(load('remedy', 'GAME_ENV_RCON_PASSWORD=changeme')).toThrow(
        /SECRET_REFS=RCON_PASSWORD=sm:respawn\/remedy\/rcon_password/,
      );
    });

    it.each([
      '+rcon_password changeme',
      '+sv_password hunter2',
      '--api-key=abc123',
    ])('rejects %s in CONTAINER_COMMAND', (fragment) => {
      expect(load('cmd', `CONTAINER_COMMAND=+map de_dust2 ${fragment}`)).toThrow(
        /looks like a credential/,
      );
    });

    it('allows non-secret names that merely contain "rcon"', () => {
      const config = load(
        'rcon-port',
        'GAME_ENV_RUST_RCON_PORT=28016\nGAME_ENV_RUST_RCON_WEB=1',
      )();
      expect(config.gameEnvVars['RUST_RCON_PORT']).toBe('28016');
    });

    it('allows an ordinary CONTAINER_COMMAND', () => {
      const config = load(
        'plain-cmd',
        'CONTAINER_COMMAND=+log on +maxplayers 16 +map de_dust2 +sv_lan 0',
      )();
      expect(config.container.command).toContain('+maxplayers');
    });

    it('allows a credential supplied via SECRET_REFS', () => {
      const config = load(
        'via-secret',
        'SECRET_REFS=RCON_PASSWORD=sm:respawn/via-secret/rcon',
      )();
      expect(config.secretRefs[0]?.containerEnvVar).toBe('RCON_PASSWORD');
    });

    it('rejects a var set by both GAME_ENV_ and SECRET_REFS', () => {
      expect(
        load(
          'dupe',
          'GAME_ENV_ADMIN_ID=123\nSECRET_REFS=ADMIN_ID=sm:respawn/dupe/admin',
        ),
      ).toThrow(/set by both/);
    });
  });
});
