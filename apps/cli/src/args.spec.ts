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
});
