/**
 * Tests for findMissingEntities + buildWaitingPrefix.
 *
 * Background: the analytics reviewer creates "forward-looking" insights
 * that depend on events the bot is also suggesting the developer add.
 * Until those events fire, the insight renders an empty chart. These
 * helpers detect that case so the reviewer can prepend "⏳ Waiting for X"
 * to the visible description — closing the UX gap demonstrated by
 * us.posthog.com/project/316309/insights/oBKfTWKd (the `co_host_added`
 * event was suggested in the PR but doesn't exist in the project yet).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildWaitingPrefix, findMissingEntities } from './referenced-entities.js';
import type { PostHogStructuredQuery } from './types.js';

const EMPTY_EVENTS = new Set<string>();
const EMPTY_PROPS = new Set<string>();

describe('findMissingEntities — TrendsQuery', () => {
  test('flags event in series[] that the project hasn\'t seen (the bug repro)', () => {
    const query: PostHogStructuredQuery = {
      kind: 'TrendsQuery',
      series: [{ kind: 'EventsNode', event: 'co_host_added', math: 'total' }],
      breakdownFilter: { breakdown: 'matched_user', breakdown_type: 'event' },
    };
    const missing = findMissingEntities({
      query,
      existingEventNames: EMPTY_EVENTS,
      existingPropertyNames: EMPTY_PROPS,
    });
    assert.deepEqual(missing.events, ['co_host_added']);
    assert.deepEqual(missing.properties, ['matched_user']);
  });

  test('does not flag events that ARE in the project', () => {
    const query: PostHogStructuredQuery = {
      kind: 'TrendsQuery',
      series: [{ kind: 'EventsNode', event: '$pageview' }],
    };
    const missing = findMissingEntities({
      query,
      existingEventNames: new Set(['$pageview']),
      existingPropertyNames: EMPTY_PROPS,
    });
    assert.deepEqual(missing.events, []);
  });

  test('collects multiple distinct missing series + dedupes', () => {
    const query: PostHogStructuredQuery = {
      kind: 'TrendsQuery',
      series: [
        { kind: 'EventsNode', event: 'foo' },
        { kind: 'EventsNode', event: 'bar' },
        { kind: 'EventsNode', event: 'foo' }, // duplicate
      ],
    };
    const missing = findMissingEntities({
      query,
      existingEventNames: EMPTY_EVENTS,
      existingPropertyNames: EMPTY_PROPS,
    });
    assert.deepEqual(missing.events, ['foo', 'bar']);
  });

  test('flags top-level properties[] filter keys not in the project', () => {
    const query: PostHogStructuredQuery = {
      kind: 'TrendsQuery',
      series: [{ kind: 'EventsNode', event: 'known' }],
      properties: [{ key: 'unknown_filter_prop', operator: 'exact', value: 'x', type: 'event' }],
    };
    const missing = findMissingEntities({
      query,
      existingEventNames: new Set(['known']),
      existingPropertyNames: EMPTY_PROPS,
    });
    assert.deepEqual(missing.properties, ['unknown_filter_prop']);
  });
});

describe('findMissingEntities — FunnelsQuery', () => {
  test('flags missing step events', () => {
    const query: PostHogStructuredQuery = {
      kind: 'FunnelsQuery',
      series: [
        { kind: 'EventsNode', event: 'workflow_created' },
        { kind: 'EventsNode', event: 'workflow_activated' },
      ],
    };
    const missing = findMissingEntities({
      query,
      existingEventNames: new Set(['workflow_created']),
      existingPropertyNames: EMPTY_PROPS,
    });
    assert.deepEqual(missing.events, ['workflow_activated']);
  });
});

describe('findMissingEntities — RetentionQuery', () => {
  test('flags missing targetEntity / returningEntity events', () => {
    const query: PostHogStructuredQuery = {
      kind: 'RetentionQuery',
      retentionFilter: {
        targetEntity: { kind: 'EventsNode', id: 'foo', name: 'foo', type: 'events' },
        returningEntity: { kind: 'EventsNode', id: 'bar', name: 'bar', type: 'events' },
        period: 'Week',
      },
    };
    const missing = findMissingEntities({
      query,
      existingEventNames: new Set(['foo']),
      existingPropertyNames: EMPTY_PROPS,
    });
    assert.deepEqual(missing.events, ['bar']);
  });
});

describe('findMissingEntities — HogQLQuery', () => {
  test('extracts event = \'...\' literals from HogQL', () => {
    const query: PostHogStructuredQuery = {
      kind: 'HogQLQuery',
      query: "select count() from events where event = 'mystery_event' and timestamp > now() - interval 30 day",
    };
    const missing = findMissingEntities({
      query,
      existingEventNames: EMPTY_EVENTS,
      existingPropertyNames: EMPTY_PROPS,
    });
    assert.deepEqual(missing.events, ['mystery_event']);
  });

  test('extracts event IN (\'a\', \'b\') literals', () => {
    const query: PostHogStructuredQuery = {
      kind: 'HogQLQuery',
      query: "select 1 from events where event in ('a', 'b', 'c')",
    };
    const missing = findMissingEntities({
      query,
      existingEventNames: new Set(['a']),
      existingPropertyNames: EMPTY_PROPS,
    });
    assert.deepEqual(missing.events, ['b', 'c']);
  });

  test('extracts properties.X and properties[\'X\'] references', () => {
    const query: PostHogStructuredQuery = {
      kind: 'HogQLQuery',
      query: "select properties.$browser, properties['matched_user'] from events",
    };
    const missing = findMissingEntities({
      query,
      existingEventNames: EMPTY_EVENTS,
      existingPropertyNames: new Set(['$browser']),
    });
    assert.deepEqual(missing.properties, ['matched_user']);
  });
});

describe('findMissingEntities — defensive', () => {
  test('returns empty for undefined query', () => {
    const missing = findMissingEntities({
      query: undefined,
      existingEventNames: EMPTY_EVENTS,
      existingPropertyNames: EMPTY_PROPS,
    });
    assert.deepEqual(missing, { events: [], properties: [] });
  });

  test('returns empty for unknown kind (no over-warn)', () => {
    const missing = findMissingEntities({
      query: { kind: 'FuturePathsQuery' as unknown as PostHogStructuredQuery['kind'] } as PostHogStructuredQuery,
      existingEventNames: EMPTY_EVENTS,
      existingPropertyNames: EMPTY_PROPS,
    });
    assert.deepEqual(missing, { events: [], properties: [] });
  });
});

describe('buildWaitingPrefix', () => {
  test('returns null when nothing is missing', () => {
    assert.equal(buildWaitingPrefix({ events: [], properties: [] }), null);
  });

  test('renders a one-event waiting message', () => {
    const out = buildWaitingPrefix({ events: ['co_host_added'], properties: [] });
    assert.ok(out?.includes('⏳'));
    assert.ok(out?.includes('`co_host_added`'));
    assert.ok(out?.includes('Once instrumentation lands'));
  });

  test('renders a multi-event waiting message with Oxford comma', () => {
    const out = buildWaitingPrefix({ events: ['a', 'b', 'c'], properties: [] });
    assert.ok(out?.includes('`a`, `b`, and `c`'));
  });

  test('mentions properties separately when both are missing', () => {
    const out = buildWaitingPrefix({ events: ['e1'], properties: ['p1'] });
    assert.ok(out?.includes('`e1`'));
    assert.ok(out?.includes('`p1`'));
    assert.ok(out?.includes('property'));
  });

  test('handles only-missing-property case', () => {
    const out = buildWaitingPrefix({ events: [], properties: ['matched_user'] });
    assert.ok(out?.includes('property'));
    assert.ok(out?.includes('`matched_user`'));
  });
});
