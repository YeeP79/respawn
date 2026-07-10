import { describe, it, expect } from 'vitest';
import type { ServiceStatus } from '@respawn/core';
import { formatServiceStatus, summariseServiceStatus } from './status.js';

// chalk may or may not emit ANSI depending on TTY detection, so assert on the text
// content rather than exact colour codes.
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '');
}

describe('formatServiceStatus', () => {
  it('renders not-deployed', () => {
    const s: ServiceStatus = { service: 'ut99', environment: 'dev', state: 'not-deployed' };
    expect(plain(formatServiceStatus(s))).toContain('ut99: Not deployed in dev');
    expect(summariseServiceStatus(s)).toBe('Not deployed');
  });

  it('renders not-found', () => {
    const s: ServiceStatus = { service: 'ut99', environment: 'prod', state: 'not-found' };
    expect(plain(formatServiceStatus(s))).toContain('ut99: Not found in prod');
    expect(summariseServiceStatus(s)).toBe('Not found');
  });

  it('renders a running service with counts and last deploy', () => {
    const s: ServiceStatus = {
      service: 'ut99',
      environment: 'dev',
      state: 'running',
      status: 'ACTIVE',
      runningCount: 2,
      desiredCount: 3,
      lastDeploy: '2026-07-10T00:00:00Z',
    };
    const line = plain(formatServiceStatus(s));
    expect(line).toContain('ut99');
    expect(line).toContain('Status: ACTIVE');
    expect(line).toContain('Tasks: 2/3');
    expect(line).toContain('Last deploy: 2026-07-10T00:00:00Z');
    expect(summariseServiceStatus(s)).toBe('ACTIVE (2/3 tasks)');
  });

  it('falls back to N/A when there is no last deploy', () => {
    const s: ServiceStatus = {
      service: 'ut99',
      environment: 'dev',
      state: 'running',
      status: 'ACTIVE',
      runningCount: 1,
      desiredCount: 1,
    };
    expect(plain(formatServiceStatus(s))).toContain('Last deploy: N/A');
  });
});
