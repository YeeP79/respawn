import { describe, it, expect } from 'vitest';
import { withAwsOptions } from './exec.js';

// The arg-assembly is where the five old wrappers diverged; pin it down.
describe('withAwsOptions', () => {
  it('returns the args unchanged when no region/profile', () => {
    expect(withAwsOptions(['ecs', 'list-clusters'])).toEqual(['ecs', 'list-clusters']);
  });

  it('appends region then profile, in that order', () => {
    expect(
      withAwsOptions(['ecs', 'list-clusters'], { region: 'us-east-1', profile: 'respawn' }),
    ).toEqual(['ecs', 'list-clusters', '--region', 'us-east-1', '--profile', 'respawn']);
  });

  it('appends only what is provided', () => {
    expect(withAwsOptions(['s'], { region: 'eu-west-1' })).toEqual(['s', '--region', 'eu-west-1']);
    expect(withAwsOptions(['s'], { profile: 'p' })).toEqual(['s', '--profile', 'p']);
  });

  it('does not mutate the input array', () => {
    const args = ['ssm', 'get-parameter'];
    withAwsOptions(args, { region: 'us-east-1' });
    expect(args).toEqual(['ssm', 'get-parameter']);
  });

  it('ignores empty-string region/profile', () => {
    expect(withAwsOptions(['x'], { region: '', profile: '' })).toEqual(['x']);
  });
});
