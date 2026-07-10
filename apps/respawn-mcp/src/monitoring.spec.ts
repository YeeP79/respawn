import { describe, it, expect } from 'vitest';
import {
  explainExit,
  formatLimit,
  isUnlimited,
  summarizeDatapoints,
  percentToMiB,
  parseContainerStats,
  toMiB,
} from './monitoring.js';

describe('explainExit', () => {
  it('reads a clean exit', () => {
    expect(explainExit({ name: 'rcon-control', exitCode: 0 })).toBe('clean exit');
  });

  it('does NOT call 137 an OOM kill when ECS asked the task to stop', () => {
    // Every normal doom2/cs16 shutdown looks like this: the game ignores SIGTERM, ECS
    // escalates to SIGKILL. Reporting OOM here would fire on every scale-to-zero.
    const scheduler = explainExit({ name: 'game-server', exitCode: 137 }, 'ServiceSchedulerInitiated');
    expect(scheduler).toMatch(/normal shutdown/);
    expect(scheduler).not.toMatch(/possible OOM kill/);

    const user = explainExit({ name: 'game-server', exitCode: 137 }, 'UserInitiated');
    expect(user).toMatch(/normal shutdown/);
  });

  it('does flag 137 as a possible OOM kill when ECS did not initiate the stop', () => {
    const out = explainExit({ name: 'game-server', exitCode: 137 }, 'TaskFailedToStart');
    expect(out).toMatch(/possible OOM kill/);
  });

  it('names the common fatal signals', () => {
    expect(explainExit({ name: 'g', exitCode: 139 })).toMatch(/SIGSEGV/);
    expect(explainExit({ name: 'g', exitCode: 143 })).toMatch(/SIGTERM/);
  });

  it('treats a non-zero exit outside an ECS stop as a crash', () => {
    expect(explainExit({ name: 'g', exitCode: 1 })).toMatch(/crashed/);
    expect(explainExit({ name: 'g', exitCode: 1 }, 'UserInitiated')).toMatch(/ECS-initiated stop/);
  });

  it('handles a missing exit code', () => {
    expect(explainExit({ name: 'g' })).toBe('no exit code recorded');
  });
});

describe('summarizeDatapoints', () => {
  it('returns undefined when the window has no data', () => {
    // A server scaled to zero for the whole window publishes nothing at all.
    expect(summarizeDatapoints([])).toBeUndefined();
  });

  it('averages the averages and peaks the maximums', () => {
    const s = summarizeDatapoints([
      { Average: 10, Maximum: 30 },
      { Average: 20, Maximum: 25 },
    ]);
    expect(s).toEqual({ average: 15, maximum: 30, samples: 2 });
  });

  it('tolerates datapoints missing one statistic', () => {
    expect(summarizeDatapoints([{ Average: 5 }])).toEqual({ average: 5, maximum: 0, samples: 1 });
  });
});

describe('percentToMiB', () => {
  it('converts a task-level utilization percentage back to MiB', () => {
    expect(percentToMiB(30.859375, 512)).toBe(158);
    expect(percentToMiB(0, 512)).toBe(0);
  });
});

describe('toMiB', () => {
  it('formats bytes', () => {
    expect(toMiB(67108864)).toBe('64.0 MiB');
  });

  it('does not invent a number when the probe omitted the field', () => {
    expect(toMiB(undefined)).toBe('?');
  });
});

describe('parseContainerStats', () => {
  it('extracts the JSON array even with banner noise around it', () => {
    const raw = 'some warning\n[{"name":"rcon-control","rssBytes":40000000}]\n';
    expect(parseContainerStats(raw)).toEqual([{ name: 'rcon-control', rssBytes: 40000000 }]);
  });

  it('throws with the raw text when the probe printed no JSON', () => {
    expect(() => parseContainerStats('Traceback: KeyError')).toThrow(/no JSON/);
  });

  it('throws when the probe printed something that is not an array', () => {
    expect(() => parseContainerStats('[1,2] but really {"a":1}')).not.toThrow();
    expect(() => parseContainerStats('no brackets here')).toThrow();
  });
});

describe('formatLimit / isUnlimited', () => {
  it('treats the cgroup unlimited sentinel as no limit', () => {
    // Fargate reports ~9.2e18 bytes for a container with no memoryLimitMiB; printing
    // that as "8796093022208.0 MiB" (or dividing by it) is worse than useless.
    const sentinel = 9223372036854771712;
    expect(isUnlimited(sentinel)).toBe(true);
    expect(formatLimit(sentinel)).toMatch(/none/);
  });

  it('formats a real limit', () => {
    expect(isUnlimited(192 * 1024 * 1024)).toBe(false);
    expect(formatLimit(192 * 1024 * 1024)).toBe('192.0 MiB');
  });
});
