import { describe, it, expect } from 'vitest';
import {
  checkKey,
  checkLabel,
  compareStatus,
  hasActionableUpdate,
  type CheckResult,
} from './update-check.js';

describe('checkKey', () => {
  it.each([
    [{ kind: 'image' } as const, 'image-digest'],
    [{ kind: 'build' } as const, 'build-tag'],
    [{ kind: 'steam', appId: '730' } as const, 'steam-730'],
  ])('maps %o to a stable SSM key', (check, expected) => {
    expect(checkKey(check)).toBe(expected);
  });

  it('gives each steam app its own key', () => {
    expect(checkKey({ kind: 'steam', appId: '730' })).not.toBe(
      checkKey({ kind: 'steam', appId: '4020' }),
    );
  });
});

describe('checkLabel', () => {
  it('renders a steam check with its app id', () => {
    expect(checkLabel({ kind: 'steam', appId: '258550' })).toBe('steam:258550');
  });
});

describe('compareStatus', () => {
  it('reports up-to-date when current matches recorded', () => {
    expect(compareStatus('abc', 'abc')).toBe('up-to-date');
  });

  it('reports update-available when they differ', () => {
    expect(compareStatus('def', 'abc')).toBe('update-available');
  });

  it('reports never-recorded when there is no baseline', () => {
    expect(compareStatus('abc', undefined)).toBe('never-recorded');
  });

  it('reports unknown when the upstream lookup failed', () => {
    // A Docker Hub outage or a Steam API hiccup must never read as "nothing to
    // do" — the same fail-safe discipline as the idle player probes.
    expect(compareStatus(undefined, 'abc')).toBe('unknown');
  });

  it('reports unknown even when nothing was ever recorded', () => {
    expect(compareStatus(undefined, undefined)).toBe('unknown');
  });
});

function result(status: CheckResult['status']): CheckResult {
  return {
    serviceName: 'x',
    check: { kind: 'image' },
    key: 'image-digest',
    status,
  };
}

describe('hasActionableUpdate', () => {
  it('is true only when something is actually stale', () => {
    expect(hasActionableUpdate([result('update-available')])).toBe(true);
  });

  it.each([['up-to-date'], ['never-recorded'], ['unknown']] as const)(
    'is false for %s',
    (status) => {
      expect(hasActionableUpdate([result(status)])).toBe(false);
    },
  );

  it('does not let an unknown mask a real update', () => {
    expect(
      hasActionableUpdate([result('unknown'), result('update-available')]),
    ).toBe(true);
  });
});
