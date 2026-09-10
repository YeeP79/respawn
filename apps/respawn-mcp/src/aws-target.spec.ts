import { describe, expect, it } from 'vitest';
import { resolveAwsTarget } from './aws-target.js';

const FALLBACK = { region: 'us-east-1', profile: 'respawn' };

describe('resolveAwsTarget', () => {
  it('falls back to the process environment when a service declares nothing', () => {
    expect(resolveAwsTarget({}, FALLBACK)).toEqual({
      region: 'us-east-1',
      profile: 'respawn',
    });
  });

  it('prefers a declared region and profile together', () => {
    expect(
      resolveAwsTarget(
        { region: 'us-east-2', profile: 'marketplace-dev--dev' },
        FALLBACK,
      ),
    ).toEqual({ region: 'us-east-2', profile: 'marketplace-dev--dev' });
  });

  // The regression this module exists for: region resolved per-service while profile did
  // not, so a cross-account service was reached in the RIGHT region with the WRONG
  // account's credentials — which reads as "the secret does not exist" rather than as an
  // access problem.
  it('does not pair a declared region with the fallback profile', () => {
    const target = resolveAwsTarget({ region: 'us-east-2', profile: 'marketplace-dev--dev' }, FALLBACK);
    expect(target.region).toBe('us-east-2');
    expect(target.profile).not.toBe('respawn');
  });

  it('takes a declared profile even when the region is inherited', () => {
    expect(resolveAwsTarget({ profile: 'marketplace-dev--dev' }, FALLBACK)).toEqual({
      region: 'us-east-1',
      profile: 'marketplace-dev--dev',
    });
  });

  it('omits profile entirely when neither side has one, so the AWS default chain applies', () => {
    expect(resolveAwsTarget({}, { region: 'us-east-1' })).toEqual({ region: 'us-east-1' });
    expect('profile' in resolveAwsTarget({}, { region: 'us-east-1' })).toBe(false);
  });

  it('treats an explicitly undefined declaration as absent, not as a value', () => {
    expect(resolveAwsTarget({ region: undefined, profile: undefined }, FALLBACK)).toEqual({
      region: 'us-east-1',
      profile: 'respawn',
    });
  });
});
