/**
 * Tests for wrapInsightQueryForStorage — fixes the "insight saved but chart
 * is blank with the BETA tag selected" bug observed when the bot's REST
 * fallback persists insights without the InsightVizNode wrapper that
 * PostHog's renderer expects.
 *
 * Background: PostHog's MCP insight-create endpoint auto-wraps raw
 * TrendsQuery/FunnelsQuery/etc. into InsightVizNode (and HogQLQuery into
 * DataVisualizationNode). The plain REST endpoint does NOT — it stores the
 * value as-is, leaving the insight unrenderable. This wrapper makes the
 * client-side body shape consistent across both transports.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { wrapInsightQueryForStorage } from './client.js';

describe('wrapInsightQueryForStorage', () => {
  test('wraps a raw TrendsQuery in InsightVizNode (the bug repro)', () => {
    const raw = {
      kind: 'TrendsQuery',
      series: [{ kind: 'EventsNode', event: 'workflow_activated', math: 'total' }],
      dateRange: { date_from: '-30d' },
      interval: 'day',
    };
    const wrapped = wrapInsightQueryForStorage(raw);
    assert.equal(wrapped.kind, 'InsightVizNode');
    assert.deepEqual(wrapped.source, raw);
  });

  test('wraps FunnelsQuery in InsightVizNode', () => {
    const wrapped = wrapInsightQueryForStorage({ kind: 'FunnelsQuery', series: [] });
    assert.equal(wrapped.kind, 'InsightVizNode');
    assert.deepEqual((wrapped.source as { kind: string }).kind, 'FunnelsQuery');
  });

  test('wraps RetentionQuery in InsightVizNode', () => {
    const wrapped = wrapInsightQueryForStorage({ kind: 'RetentionQuery', retentionFilter: {} });
    assert.equal(wrapped.kind, 'InsightVizNode');
  });

  test('wraps StickinessQuery / LifecycleQuery / PathsQuery similarly', () => {
    for (const kind of ['StickinessQuery', 'LifecycleQuery', 'PathsQuery']) {
      const wrapped = wrapInsightQueryForStorage({ kind });
      assert.equal(wrapped.kind, 'InsightVizNode', `${kind} should be wrapped in InsightVizNode`);
    }
  });

  test('wraps HogQLQuery in DataVisualizationNode (not InsightVizNode)', () => {
    const raw = { kind: 'HogQLQuery', query: 'select count() from events limit 100' };
    const wrapped = wrapInsightQueryForStorage(raw);
    assert.equal(wrapped.kind, 'DataVisualizationNode');
    assert.deepEqual(wrapped.source, raw);
  });

  test('passes through already-wrapped InsightVizNode unchanged', () => {
    const wrapped = {
      kind: 'InsightVizNode',
      source: { kind: 'TrendsQuery', series: [] },
    };
    const result = wrapInsightQueryForStorage(wrapped);
    assert.equal(result, wrapped, 'identity — must not double-wrap');
  });

  test('passes through already-wrapped DataVisualizationNode unchanged', () => {
    const wrapped = {
      kind: 'DataVisualizationNode',
      source: { kind: 'HogQLQuery', query: 'select 1' },
    };
    const result = wrapInsightQueryForStorage(wrapped);
    assert.equal(result, wrapped);
  });

  test('passes through unknown kinds unchanged (defensive — no silent rewrap)', () => {
    const future = { kind: 'AssistantTrendsQuery', series: [] };
    const result = wrapInsightQueryForStorage(future);
    assert.equal(result, future);
  });

  test('handles nullish input defensively', () => {
    // @ts-expect-error — defensive against undefined
    assert.equal(wrapInsightQueryForStorage(undefined), undefined);
    // @ts-expect-error — defensive against null
    assert.equal(wrapInsightQueryForStorage(null), null);
  });
});
