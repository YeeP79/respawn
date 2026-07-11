import type { Manifest } from './manifest.js';

/**
 * Diagnostic surface for authoring and debugging a manifest against a live server,
 * without dropping to a shell. These are the moves that recur when a new game's wire
 * format is unknown: read what the transport reports, capture an unparsed reply, and
 * watch a value move over time. They are protocol-agnostic — the sidecar speaks the
 * protocol; nothing here knows or cares which.
 */

export interface TransportInfo {
  service?: string;
  protocol?: string;
  target?: string;
  /** Write transport, when the sidecar fronts a separate write path (UT99: uweb). */
  writeProtocol?: string;
  writeTarget?: string;
}

/**
 * Parses `rcon.py --info` output (`key=value` lines) into a transport description.
 * Unknown keys are ignored so a future field never breaks the parse.
 */
export function parseTransportInfo(raw: string): TransportInfo {
  const info: TransportInfo = {};
  for (const line of raw.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === 'service') info.service = value;
    else if (key === 'protocol') info.protocol = value;
    else if (key === 'target') info.target = value;
    else if (key === 'write_protocol') info.writeProtocol = value;
    else if (key === 'write_target') info.writeTarget = value;
  }
  return info;
}

export interface TransportReport {
  service: string;
  /** Whether the server is running and reachable via ECS Exec right now. */
  reachable: boolean;
  /** From the live sidecar (`--info`); absent when the server is down. */
  live?: TransportInfo;
  /** Query and command names the manifest declares, from the bundle (always available). */
  manifest?: {
    displayName?: string;
    engine?: string;
    queries: string[];
    commands: string[];
    cvars: string[];
    notes?: string;
  };
  /** Why `live` is absent, when the server is not reachable. */
  note?: string;
}

/** Summarises a manifest's declared surface — the offline half of describe_transport. */
export function manifestSummary(manifest: Manifest | undefined): TransportReport['manifest'] {
  if (!manifest) return undefined;
  return {
    ...(manifest.displayName !== undefined ? { displayName: manifest.displayName } : {}),
    ...(manifest.engine !== undefined ? { engine: manifest.engine } : {}),
    queries: manifest.queries.map((q) => q.name),
    commands: manifest.commands.map((c) => c.name),
    cvars: manifest.cvars.map((c) => c.name),
    ...(manifest.notes !== undefined ? { notes: manifest.notes } : {}),
  };
}

export interface SamplePoint {
  /** 1-based index of this sample in the run. */
  n: number;
  /** The value pulled from the reply, or null when the pattern did not match. */
  value: string | null;
}

export interface SampleReport {
  service: string;
  query: string;
  field: string;
  count: number;
  intervalSeconds: number;
  points: SamplePoint[];
  /** Distinct non-null values seen, in first-seen order — the point of sampling. */
  distinct: string[];
  /** How many samples failed to produce the field. */
  misses: number;
}

/**
 * Clamps a sample request to safe bounds.
 *
 * Every sample is one ECS Exec session, and rapid back-to-back sessions drop the SSM
 * control channel (observed against a live task, recovered only by restarting it), so
 * a floor on the interval is a correctness guard, not a nicety. The count is capped so
 * a single tool call cannot open an unbounded run of sessions.
 */
export function clampSample(count: number, intervalSeconds: number): { count: number; intervalSeconds: number } {
  return {
    count: Math.max(1, Math.min(10, Math.floor(count))),
    intervalSeconds: Math.max(3, Math.min(60, intervalSeconds)),
  };
}

/** Collapses a series of sampled values into the distinct set, preserving first-seen order. */
export function summariseSamples(points: SamplePoint[]): { distinct: string[]; misses: number } {
  const distinct: string[] = [];
  let misses = 0;
  for (const p of points) {
    if (p.value === null) {
      misses++;
      continue;
    }
    if (!distinct.includes(p.value)) distinct.push(p.value);
  }
  return { distinct, misses };
}
