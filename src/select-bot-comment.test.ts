/**
 * Reproducer tests for security-audit Finding 3:
 * "Comment-marker collision allows any commenter to poison the bot's
 *  prehog-state and suppress its review on a PR."
 *
 * Threat: `findCommentByMarker` (`src/github.ts`) matches a comment purely by
 * substring search of the body for `<!-- prehog -->`, with no
 * filter on the comment's author. Any user (including the PR author) who can
 * post a PR comment can include the marker plus a forged `prehog-state` JSON
 * block, and the bot will parse the attacker's state as if it were its own
 * prior state — suppressing inline suggestions, redirecting create/update
 * decisions for PostHog insights, etc.
 *
 * Pre-fix: there is no `selectBotComment` helper — `findCommentByMarker` does
 * `comments.find((c) => (c.body ?? '').includes(marker))` with no author
 * filter. The "rejects User-authored marker comment" test below fails.
 *
 * Post-fix: a `selectBotComment` helper requires `c.user?.type === 'Bot'`,
 * and `findCommentByMarker` delegates to it. The tests pass.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { selectBotComment, type CommentForSelection } from './github.js';

const MARKER = '<!-- prehog -->';

describe('selectBotComment', () => {
  test('rejects a User-authored comment containing the marker (Finding 3 reproducer)', () => {
    const comments: CommentForSelection[] = [
      {
        id: 1,
        body:
          'Looks good!\n\n' +
          MARKER +
          '\n<!-- prehog-state:{"version":1,"created":[],"postedSuggestions":["fake-fp"]} -->',
        user: { type: 'User', login: 'attacker-account' },
      },
      {
        id: 2,
        body:
          'Earlier review by the bot.\n\n' +
          MARKER +
          '\n<!-- prehog-state:{"version":1,"created":[],"postedSuggestions":[]} -->',
        user: { type: 'Bot', login: 'github-actions[bot]' },
      },
    ];

    const result = selectBotComment(comments, MARKER);

    assert.notEqual(result?.id, 1, 'must NOT select the User-authored attacker comment');
    assert.equal(result?.id, 2, 'must select the Bot-authored comment');
  });

  test('selects the bot comment even when the attacker comment is listed first', () => {
    const comments: CommentForSelection[] = [
      {
        id: 1,
        body: 'POISON ' + MARKER + ' state attacker payload',
        user: { type: 'User', login: 'attacker-account' },
      },
      {
        id: 2,
        body: 'real bot review ' + MARKER,
        user: { type: 'Bot', login: 'github-actions[bot]' },
      },
    ];

    const result = selectBotComment(comments, MARKER);

    assert.equal(result?.id, 2);
  });

  test('returns null when only a User-authored marker comment exists', () => {
    const comments: CommentForSelection[] = [
      {
        id: 1,
        body: 'POISON ' + MARKER,
        user: { type: 'User', login: 'attacker-account' },
      },
    ];

    const result = selectBotComment(comments, MARKER);
    assert.equal(result, null, 'must not find a comment to update if no Bot comment exists');
  });

  test('returns null when no comment contains the marker', () => {
    const comments: CommentForSelection[] = [
      { id: 1, body: 'just a normal review', user: { type: 'User', login: 'reviewer' } },
      { id: 2, body: 'lgtm', user: { type: 'Bot', login: 'some-other-bot' } },
    ];

    const result = selectBotComment(comments, MARKER);
    assert.equal(result, null);
  });

  test('handles missing user object defensively', () => {
    const comments: CommentForSelection[] = [
      { id: 1, body: MARKER + ' should not match', user: null },
      { id: 2, body: MARKER + ' should match', user: { type: 'Bot', login: 'github-actions[bot]' } },
    ];

    const result = selectBotComment(comments, MARKER);
    assert.equal(result?.id, 2);
  });
});
