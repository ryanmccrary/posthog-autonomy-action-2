/**
 * Tests for the promote-on-merge entry points that don't need real PostHog
 * credentials:
 *   - scanLandedEntities: regex scan of the merged diff for capture() calls +
 *     property keys matching the bot's prior suggestions.
 *   - renderPromotionMarkdown: PR-comment surfacing of what got registered.
 *
 * The orchestrator wiring (config.prMerged → runPromotion → reviewer re-run)
 * isn't unit-tested here because it spans multiple async dependencies that
 * each need their own mocks; integration testing happens against a real
 * project on the next merge run.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { findCapturesInDiff, renderPromotionMarkdown, scanLandedEntities } from './promote.js';

describe('scanLandedEntities — capture() calls', () => {
  test('matches a JS posthog.capture call against a suggested event', () => {
    const diff = `
+ posthog.capture('co_host_added', { matched_user: true });
+ // some other line
    `.trim();

    const result = scanLandedEntities(diff, {
      suggestedEventNames: new Set(['co_host_added']),
      suggestedPropertyNames: new Set(),
    });

    assert.deepEqual(result.events, ['co_host_added']);
    assert.deepEqual(result.properties, []);
  });

  test('matches a Python posthoganalytics.capture call', () => {
    const diff = `
+ posthoganalytics.capture('hog_flow_activated', properties={'trigger_type': 'schedule'})
    `.trim();

    const result = scanLandedEntities(diff, {
      suggestedEventNames: new Set(['hog_flow_activated']),
      suggestedPropertyNames: new Set(['trigger_type']),
    });

    assert.deepEqual(result.events, ['hog_flow_activated']);
    assert.deepEqual(result.properties, ['trigger_type']);
  });

  test('ignores capture calls for events the bot did NOT suggest', () => {
    const diff = `
+ posthog.capture('something_else', {});
+ posthog.capture('co_host_added', {});
    `.trim();

    const result = scanLandedEntities(diff, {
      suggestedEventNames: new Set(['co_host_added']),
      suggestedPropertyNames: new Set(),
    });

    assert.deepEqual(result.events, ['co_host_added']);
  });

  test('returns empty events when no suggestions match the diff', () => {
    const diff = "+ posthog.capture('unrelated_event', {});";
    const result = scanLandedEntities(diff, {
      suggestedEventNames: new Set(['workflow_created']),
      suggestedPropertyNames: new Set(),
    });
    assert.deepEqual(result.events, []);
  });

  test('handles double-quoted event names', () => {
    const diff = '+ posthog.capture("co_host_added", {});';
    const result = scanLandedEntities(diff, {
      suggestedEventNames: new Set(['co_host_added']),
      suggestedPropertyNames: new Set(),
    });
    assert.deepEqual(result.events, ['co_host_added']);
  });
});

describe('scanLandedEntities — property additions', () => {
  test('detects a suggested property added inside an existing capture call (the trigger_type case)', () => {
    // Mirrors the "extend hog_flow_created with trigger_type" example.
    const diff = `
@@ -10,3 +10,4 @@
 posthog.capture('hog_flow_created', {
   flow_id: id,
+  trigger_type: 'schedule',
 })
    `.trim();

    const result = scanLandedEntities(diff, {
      suggestedEventNames: new Set(),
      suggestedPropertyNames: new Set(['trigger_type']),
    });

    assert.deepEqual(result.properties, ['trigger_type']);
  });

  test('ignores property additions outside a capture call (e.g. random object literals)', () => {
    const diff = `
@@ -1,2 +1,3 @@
 const someConfig = {
+  trigger_type: 'foo',
 }
    `.trim();

    const result = scanLandedEntities(diff, {
      suggestedEventNames: new Set(),
      suggestedPropertyNames: new Set(['trigger_type']),
    });

    // No capture() in scope, so the property addition isn't claimed.
    assert.deepEqual(result.properties, []);
  });

  test('handles property keys on context lines that re-enter a capture window', () => {
    // After a "@@" hunk header, the capture-window should reset.
    const diff = `
@@ -1,3 +1,3 @@
 posthog.capture('foo', {
+  trigger_type: 'a',
 })
@@ -10,2 +10,3 @@
 const other = {
+  trigger_type: 'b',
 }
    `.trim();

    const result = scanLandedEntities(diff, {
      suggestedEventNames: new Set(),
      suggestedPropertyNames: new Set(['trigger_type']),
    });

    // Only the first one is inside a capture window. The second's hunk
    // header reset the window before we hit the property line.
    assert.deepEqual(result.properties, ['trigger_type']);
  });
});

describe('scanLandedEntities — defensive', () => {
  test('empty diff returns empty result', () => {
    const r = scanLandedEntities('', {
      suggestedEventNames: new Set(['a']),
      suggestedPropertyNames: new Set(['b']),
    });
    assert.deepEqual(r, { events: [], properties: [] });
  });

  test('diff with no capture calls returns empty events', () => {
    const r = scanLandedEntities('+ const foo = 1;\n+ const bar = 2;', {
      suggestedEventNames: new Set(['x']),
      suggestedPropertyNames: new Set(),
    });
    assert.deepEqual(r.events, []);
  });
});

describe('findCapturesInDiff — used by the analytics reviewer to gate insight creation', () => {
  test('returns every event name that appears in a capture() call, unfiltered by any suggestions', () => {
    const diff = `
+ posthog.capture('co_host_added', {});
+ posthog.capture('something_else', {});
    `.trim();
    const r = findCapturesInDiff(diff);
    assert.deepEqual([...r.eventsInDiff].sort(), ['co_host_added', 'something_else']);
  });

  test('returns every property key added inside any capture-call window, unfiltered', () => {
    const diff = `
@@ -10,3 +10,5 @@
 posthog.capture('foo', {
+  trigger_type: 'schedule',
+  flow_id: id,
 })
    `.trim();
    const r = findCapturesInDiff(diff);
    assert.ok(r.propertiesInDiff.has('trigger_type'));
    assert.ok(r.propertiesInDiff.has('flow_id'));
  });

  test('does not claim property keys outside a capture window', () => {
    const diff = `
@@ -1,2 +1,3 @@
 const someConfig = {
+  trigger_type: 'foo',
 }
    `.trim();
    const r = findCapturesInDiff(diff);
    assert.equal(r.propertiesInDiff.size, 0);
  });

  test('empty diff returns empty sets', () => {
    const r = findCapturesInDiff('');
    assert.equal(r.eventsInDiff.size, 0);
    assert.equal(r.propertiesInDiff.size, 0);
  });
});

describe('renderPromotionMarkdown', () => {
  test('renders the "nothing to register" path when nothing matched', () => {
    const out = renderPromotionMarkdown({
      registeredEvents: [],
      registeredProperties: [],
      notLanded: [],
    });
    assert.match(out, /Promoted on merge/);
    assert.match(out, /No bot-suggested events \/ properties found/);
  });

  test('lists registered events with their data-management links', () => {
    const out = renderPromotionMarkdown({
      registeredEvents: [
        {
          kind: 'event_definition',
          id: 'evt-1',
          name: 'co_host_added',
          url: 'https://us.posthog.com/project/1/data-management/events/evt-1',
        },
      ],
      registeredProperties: [],
      notLanded: [],
    });
    assert.match(out, /Pre-registered event definitions/);
    assert.match(out, /`co_host_added`/);
    assert.match(out, /data-management\/events\/evt-1/);
  });

  test('lists "not landed" entries when bot-suggested names did not appear in the merged diff', () => {
    const out = renderPromotionMarkdown({
      registeredEvents: [],
      registeredProperties: [],
      notLanded: ['matched_user', 'trigger_type'],
    });
    assert.match(out, /Bot-suggested but not in the merged diff/);
    assert.match(out, /`matched_user`/);
    assert.match(out, /`trigger_type`/);
  });
});
