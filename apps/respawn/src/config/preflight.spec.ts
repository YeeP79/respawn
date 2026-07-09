import { describe, it, expect } from 'vitest';
import {
  isPlaceholder,
  findUnsatisfiedRequirements,
  formatRequirementError,
} from './preflight.js';
import type { GameServerConfig } from './types.js';

function makeConfig(overrides: Partial<GameServerConfig>): GameServerConfig {
  return {
    serviceName: 'quakelive',
    requiredEnvVars: [],
    gameEnvVars: {},
    secretRefs: [],
    deployPrompts: [],
    ...overrides,
  } as GameServerConfig;
}

describe('isPlaceholder', () => {
  it.each([
    undefined,
    '',
    '   ',
    'changeme',
    'CHANGEME',
    'change_me',
    'todo',
    'your_token_here',
    '<your-steam-id>',
    '"changeme"',
  ])('treats %s as a placeholder', (value) => {
    expect(isPlaceholder(value)).toBe(true);
  });

  it.each(['76561198012345678', '0', 'de_dust2', 'false', 'Respawn CS2'])(
    'treats %s as a real value',
    (value) => {
      expect(isPlaceholder(value)).toBe(false);
    },
  );
});

describe('findUnsatisfiedRequirements', () => {
  it('flags a required var left at a placeholder', () => {
    const config = makeConfig({
      requiredEnvVars: ['admin'],
      gameEnvVars: { admin: 'changeme' },
    });
    expect(findUnsatisfiedRequirements(config)).toEqual(['admin']);
  });

  it('flags a required var that is absent entirely', () => {
    const config = makeConfig({ requiredEnvVars: ['admin'] });
    expect(findUnsatisfiedRequirements(config)).toEqual(['admin']);
  });

  it('accepts a real value', () => {
    const config = makeConfig({
      requiredEnvVars: ['admin'],
      gameEnvVars: { admin: '76561198012345678' },
    });
    expect(findUnsatisfiedRequirements(config)).toEqual([]);
  });

  it('accepts a requirement backed by a secret ref', () => {
    const config = makeConfig({
      requiredEnvVars: ['SRCDS_TOKEN'],
      secretRefs: [
        { containerEnvVar: 'SRCDS_TOKEN', store: 'ssm', sourceId: '/x/gslt' },
      ],
    });
    expect(findUnsatisfiedRequirements(config)).toEqual([]);
  });

  it('accepts a requirement answered by a deploy prompt', () => {
    const config = makeConfig({
      requiredEnvVars: ['GAMEMODE'],
      deployPrompts: [
        { envVar: 'GAMEMODE', type: 'select', options: ['ttt', 'darkrp'] },
      ],
    });
    expect(findUnsatisfiedRequirements(config)).toEqual([]);
  });

  it('accepts a requirement supplied by a deploy-time override', () => {
    const config = makeConfig({
      requiredEnvVars: ['admin'],
      gameEnvVars: { admin: 'changeme' },
    });
    expect(
      findUnsatisfiedRequirements(config, { admin: '76561198012345678' }),
    ).toEqual([]);
  });

  it('still flags when the override is itself a placeholder', () => {
    const config = makeConfig({ requiredEnvVars: ['admin'] });
    expect(findUnsatisfiedRequirements(config, { admin: 'changeme' })).toEqual([
      'admin',
    ]);
  });

  it('reports every unsatisfied requirement, not just the first', () => {
    const config = makeConfig({
      requiredEnvVars: ['admin', 'SRCDS_TOKEN'],
      gameEnvVars: { admin: 'changeme' },
    });
    expect(findUnsatisfiedRequirements(config)).toEqual([
      'admin',
      'SRCDS_TOKEN',
    ]);
  });
});

describe('formatRequirementError', () => {
  it('distinguishes a placeholder from an absent var', () => {
    const config = makeConfig({
      requiredEnvVars: ['admin', 'TOKEN'],
      gameEnvVars: { admin: 'changeme' },
    });
    const msg = formatRequirementError(config, ['admin', 'TOKEN']);
    expect(msg).toContain('admin is still "changeme" (a placeholder)');
    expect(msg).toContain('TOKEN is not set');
    expect(msg).toContain('quakelive');
  });
});
