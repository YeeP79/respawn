import { describe, it, expect } from 'vitest';
import {
  explainExit,
  formatLimit,
  isUnlimited,
  resolveWindow,
  sparkline,
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
    expect(s).toEqual({ average: 15, maximum: 30, samples: 2, series: [] });
  });

  it('tolerates datapoints missing one statistic', () => {
    expect(summarizeDatapoints([{ Average: 5 }])).toEqual({
      average: 5,
      maximum: 0,
      samples: 1,
      series: [],
    });
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

describe('summarizeDatapoints series', () => {
  it('keeps the timeline, sorted oldest first', () => {
    // avg/peak alone cannot tell a startup spike from sustained saturation.
    const s = summarizeDatapoints([
      { Timestamp: '2026-07-09T18:02:00Z', Average: 20, Maximum: 30 },
      { Timestamp: '2026-07-09T18:01:00Z', Average: 90, Maximum: 100 },
    ]);
    expect(s?.series.map((p) => p.at)).toEqual([
      '2026-07-09T18:01:00Z',
      '2026-07-09T18:02:00Z',
    ]);
    expect(s?.maximum).toBe(100);
  });

  it('yields an empty series when datapoints carry no timestamps', () => {
    expect(summarizeDatapoints([{ Average: 5, Maximum: 5 }])?.series).toEqual([]);
  });
});

describe('sparkline', () => {
  it('scales values across the block ramp', () => {
    expect(sparkline([0, 100])).toBe('▁█');
    expect(sparkline([])).toBe('');
  });

  it('clamps values above the max rather than indexing off the end', () => {
    expect(sparkline([150], 100)).toBe('█');
  });
});

describe('resolveWindow', () => {
  const now = Date.parse('2026-07-09T20:00:00Z');

  it('defaults to a 30 minute relative lookback', () => {
    expect(resolveWindow({ now })).toEqual({ start: now - 30 * 60_000 });
  });

  it('honours an explicit relative lookback', () => {
    expect(resolveWindow({ minutes: 10, now })).toEqual({ start: now - 10 * 60_000 });
  });

  it('accepts an absolute window and lets since override minutes', () => {
    const w = resolveWindow({
      minutes: 5,
      since: '2026-07-09T19:46:00Z',
      until: '2026-07-09T19:47:00Z',
      now,
    });
    expect(w).toEqual({
      start: Date.parse('2026-07-09T19:46:00Z'),
      end: Date.parse('2026-07-09T19:47:00Z'),
    });
  });

  it('leaves the window open-ended when until is omitted', () => {
    expect(resolveWindow({ since: '2026-07-09T19:46:00Z', now })).toEqual({
      start: Date.parse('2026-07-09T19:46:00Z'),
    });
  });

  it('rejects an unparseable timestamp instead of querying the epoch', () => {
    expect(() => resolveWindow({ since: 'last tuesday', now })).toThrow(/parseable/);
  });

  it('rejects an inverted window', () => {
    expect(() =>
      resolveWindow({ since: '2026-07-09T19:47:00Z', until: '2026-07-09T19:46:00Z', now }),
    ).toThrow(/must be after/);
  });

  it('rejects until without since', () => {
    expect(() => resolveWindow({ until: '2026-07-09T19:47:00Z', now })).toThrow(/requires since/);
  });
});
