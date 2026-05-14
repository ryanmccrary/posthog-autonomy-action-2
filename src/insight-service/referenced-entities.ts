/**
 * Walk a generated PostHog query and collect the event names + property
 * names it references. Used by the analytics reviewer to detect insights
 * that depend on events / properties the customer's project hasn't seen
 * yet, so we can prefix the visible description with a "⏳ Waiting for X"
 * marker rather than silently saving an unrenderable insight.
 *
 * Best-effort across the four supported kinds:
 *   - TrendsQuery / FunnelsQuery:  series[].event,  breakdownFilter.breakdown
 *   - RetentionQuery:              retentionFilter.{targetEntity,returningEntity}.{id,name}
 *   - HogQLQuery:                  regex over the SQL (event = '...', properties.X)
 *
 * If we can't confidently extract a reference (e.g. HogQL that doesn't
 * pattern-match), we err on the side of NOT flagging — false positives
 * here would pollute every insight description with a Waiting marker.
 */

import type { ExistingEvent } from '../posthog/client.js';
import type { PostHogStructuredQuery } from './types.js';

export interface ReferencedEntities {
  /** Distinct event names the query touches. */
  events: string[];
  /** Distinct property names the query touches (breakdown / filter / breakdown by). */
  properties: string[];
}

export interface MissingEntities {
  events: string[];
  properties: string[];
}

/**
 * Public entry point. Returns the subset of referenced entities that AREN'T
 * present in the project's existing schema, in the order they appear in
 * the query (so the human-readable message can show the first few).
 *
 * `existingProperties` is the union of properties across all
 * `existingEvents` — flatten upstream to avoid re-flattening per insight.
 */
export function findMissingEntities(args: {
  query: PostHogStructuredQuery | undefined;
  existingEventNames: ReadonlySet<string>;
  existingPropertyNames: ReadonlySet<string>;
}): MissingEntities {
  if (!args.query || typeof args.query !== 'object') {
    return { events: [], properties: [] };
  }
  const refs = collectReferencedEntities(args.query);
  const missingEvents = dedupe(
    refs.events.filter((name) => name && !args.existingEventNames.has(name)),
  );
  const missingProperties = dedupe(
    refs.properties.filter((name) => name && !args.existingPropertyNames.has(name)),
  );
  return { events: missingEvents, properties: missingProperties };
}

export function collectReferencedEntities(query: PostHogStructuredQuery): ReferencedEntities {
  const events: string[] = [];
  const properties: string[] = [];

  switch (query.kind) {
    case 'TrendsQuery':
    case 'FunnelsQuery': {
      const series = (query as { series?: Array<{ event?: string }> }).series ?? [];
      for (const s of series) if (s?.event) events.push(s.event);
      const breakdown = (query as { breakdownFilter?: { breakdown?: string | string[] } })
        .breakdownFilter?.breakdown;
      if (typeof breakdown === 'string') properties.push(breakdown);
      else if (Array.isArray(breakdown)) properties.push(...breakdown.filter((b) => typeof b === 'string'));
      // Top-level filter clauses
      const filters = (query as { properties?: Array<{ key?: string }> }).properties ?? [];
      for (const f of filters) if (f?.key) properties.push(f.key);
      break;
    }

    case 'RetentionQuery': {
      const rf = (query as {
        retentionFilter?: {
          targetEntity?: { id?: string; name?: string };
          returningEntity?: { id?: string; name?: string };
        };
      }).retentionFilter ?? {};
      const target = rf.targetEntity?.id ?? rf.targetEntity?.name;
      const returning = rf.returningEntity?.id ?? rf.returningEntity?.name;
      if (target) events.push(target);
      if (returning) events.push(returning);
      break;
    }

    case 'HogQLQuery': {
      const sql = (query as { query?: string }).query ?? '';
      // event = '<name>' or event IN ('<a>', '<b>') — capture the literals.
      const eqMatches = sql.matchAll(/\bevent\s*=\s*'([^']+)'/gi);
      for (const m of eqMatches) if (m[1]) events.push(m[1]);
      const inMatches = sql.matchAll(/\bevent\s+in\s*\(([^)]+)\)/gi);
      for (const m of inMatches) {
        for (const lit of (m[1] ?? '').matchAll(/'([^']+)'/g)) {
          if (lit[1]) events.push(lit[1]);
        }
      }
      // properties.<name> or properties['<name>'] — capture property keys.
      const dotProps = sql.matchAll(/\bproperties\.([A-Za-z_$][A-Za-z0-9_$]*)/g);
      for (const m of dotProps) if (m[1]) properties.push(m[1]);
      const bracketProps = sql.matchAll(/\bproperties\[['"]([^'"]+)['"]\]/g);
      for (const m of bracketProps) if (m[1]) properties.push(m[1]);
      break;
    }
    default:
      // Unknown kind — return empty rather than over-warn.
      break;
  }

  return { events: dedupe(events), properties: dedupe(properties) };
}

function dedupe<T>(arr: readonly T[]): T[] {
  return Array.from(new Set(arr));
}

/**
 * Render the human-readable "Waiting for..." prefix that the analytics
 * reviewer prepends to an insight's `viz_description` when entities are
 * missing. Pulled out as a tiny helper so the reviewer code stays terse
 * and the wording is centralised for future tweaking.
 */
export function buildWaitingPrefix(missing: MissingEntities): string | null {
  if (missing.events.length === 0 && missing.properties.length === 0) {
    return null;
  }
  const parts: string[] = [];
  if (missing.events.length > 0) {
    const list = formatList(missing.events.map((e) => `\`${e}\``));
    parts.push(`⏳ Waiting for ${list} to start firing`);
  }
  if (missing.properties.length > 0) {
    const list = formatList(missing.properties.map((p) => `\`${p}\``));
    parts.push(missing.events.length > 0
      ? `(and property ${list} to be sent)`
      : `⏳ Waiting for property ${list} to be sent`);
  }
  return `${parts.join(' ')}. Once instrumentation lands the chart will populate.`;
}

function formatList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
