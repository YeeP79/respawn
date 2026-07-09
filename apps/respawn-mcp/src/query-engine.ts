import type { Query } from './manifest.js';

export interface QueryResult {
  /** Single values pulled from the whole reply (e.g. map, hostname). */
  [key: string]: unknown;
  /** Per-line records, present when the query defines a `row` spec. */
  rows?: Array<Record<string, string>>;
  /** The raw rcon reply, so nothing the patterns missed is lost. */
  raw: string;
}

/**
 * Applies a manifest query's patterns to an rcon reply.
 *
 * All parsing is driven by the manifest — the MCP holds no game- or mod-specific
 * knowledge. Patterns are operator-authored and live in the repo, so they are
 * trusted input.
 *
 * @throws When a pattern in the manifest is not a valid regex (surfaced at call
 *   time; the build already validated the manifest's shape).
 */
export function runQuery(query: Query, raw: string): QueryResult {
  const result: QueryResult = { raw };

  if (query.singles) {
    for (const [field, pattern] of Object.entries(query.singles)) {
      // Applied to the whole reply, so `^`/`$` in the manifest anchor to lines.
      const match = compile(pattern, 'm').exec(raw);
      if (match) result[field] = (match[1] ?? match[0]).trim();
    }
  }

  if (query.row) {
    const rowRe = compile(query.row.match);
    const skipRe = query.row.skipIf ? compile(query.row.skipIf) : undefined;
    const rows: Array<Record<string, string>> = [];

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (skipRe?.test(trimmed)) continue;

      const match = rowRe.exec(trimmed);
      if (!match) continue;

      const record: Record<string, string> = {};
      query.row.fields.forEach((field, i) => {
        const value = match[i + 1];
        if (value !== undefined) record[field] = value;
      });
      rows.push(record);
    }
    result.rows = rows;
  }

  return result;
}

function compile(pattern: string, flags?: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw new Error(
      `Invalid query regex ${JSON.stringify(pattern)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
