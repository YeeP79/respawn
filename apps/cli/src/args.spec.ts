import { describe, it, expect } from 'vitest';
import { parseCliArgs } from './args.js';

const ROOT = '/ws';

describe('parseCliArgs', () => {
  it('defaults to interactive with no flags', () => {
    const a = parseCliArgs([], ROOT);
    expect(a.interactive).toBe(true);
    expect(a.workspaceRoot).toBe(ROOT);
    expect(a.verbose).toBe(false);
  });

  it('parses a full non-interactive batch invocation', () => {
    const a = parseCliArgs(
      ['--non-interactive', '--action', 'deploy', '--environment', 'dev', '--service', 'ut99,cs16', '--profile', 'respawn'],
      ROOT,
    );
    expect(a).toMatchObject({
      interactive: false,
      action: 'deploy',
      environment: 'dev',
      service: 'ut99,cs16',
      profile: 'respawn',
    });
  });

  it('accepts the --flag=value form', () => {
    expect(parseCliArgs(['--action=synth', '--environment=prod'], ROOT)).toMatchObject({
      action: 'synth',
      environment: 'prod',
    });
  });

  it('collects the boolean flags', () => {
    const a = parseCliArgs(
      ['--force', '--dry-run', '--verbose', '--force-build', '--require-image', '--record'],
      ROOT,
    );
    expect(a).toMatchObject({
      force: true,
      dryRun: true,
      verbose: true,
      forceBuild: true,
      requireImage: true,
      record: true,
    });
  });

  it('honours --workspace-root over the default', () => {
    expect(parseCliArgs(['--workspace-root', '/other'], ROOT).workspaceRoot).toBe('/other');
  });

  it('validates --action against the known set', () => {
    expect(() => parseCliArgs(['--action', 'nuke'], ROOT)).toThrow(/Invalid --action/);
  });

  it('validates --environment', () => {
    expect(() => parseCliArgs(['--environment', 'qa'], ROOT)).toThrow(/Invalid --environment/);
  });

  it('validates --require-approval', () => {
    expect(parseCliArgs(['--require-approval', 'never'], ROOT).requireApproval).toBe('never');
    expect(() => parseCliArgs(['--require-approval', 'sometimes'], ROOT)).toThrow(/Invalid --require-approval/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseCliArgs(['--wat'], ROOT)).toThrow();
  });

  it('accepts scale and secrets as actions', () => {
    expect(parseCliArgs(['--action', 'scale'], ROOT).action).toBe('scale');
    expect(parseCliArgs(['--action', 'secrets'], ROOT).action).toBe('secrets');
  });

  it('parses --count into a non-negative integer', () => {
    expect(parseCliArgs(['--count', '0'], ROOT).count).toBe(0);
    expect(parseCliArgs(['--count', '1'], ROOT).count).toBe(1);
    expect(parseCliArgs([], ROOT).count).toBeUndefined();
  });

  it('rejects a negative or non-integer --count', () => {
    // A dash-prefixed value must use the =form; node's parseArgs rejects `--count -1`.
    expect(() => parseCliArgs(['--count=-1'], ROOT)).toThrow(/Invalid --count/);
    expect(() => parseCliArgs(['--count', '1.5'], ROOT)).toThrow(/Invalid --count/);
    expect(() => parseCliArgs(['--count', 'lots'], ROOT)).toThrow(/Invalid --count/);
  });

  it('carries --secret through for the headless secrets flow', () => {
    expect(parseCliArgs(['--secret', 'RCON_PASSWORD'], ROOT).secret).toBe('RCON_PASSWORD');
  });

  it('collects repeated --game-env into a map', () => {
    const a = parseCliArgs(['--game-env', 'MAP=dm', '--game-env', 'MODE=ffa'], ROOT);
    expect(a.gameEnv).toEqual({ MAP: 'dm', MODE: 'ffa' });
  });

  it('accepts an = in a --game-env value', () => {
    expect(parseCliArgs(['--game-env', 'ARGS=-a=1'], ROOT).gameEnv).toEqual({ ARGS: '-a=1' });
  });

  it('rejects a malformed --game-env entry', () => {
    expect(() => parseCliArgs(['--game-env', 'NOPE'], ROOT)).toThrow(/Expected KEY=VALUE/);
    expect(() => parseCliArgs(['--game-env', '=novalue'], ROOT)).toThrow(/Expected KEY=VALUE/);
  });
});
