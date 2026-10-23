import test from 'node:test';
import assert from 'node:assert/strict';
import { hasJsonComments, mergeJson } from '../lib/merge/json.mjs';

test('mergeJson preserves unrelated keys and nested objects', () => {
  const input = JSON.stringify({
    theme: 'dark',
    compaction: { auto: false, other: true },
  }, null, 2);
  const parsed = JSON.parse(mergeJson(input, {
    compaction: { auto: true, keep: { tokens: 50000 }, buffer: 10000 },
  }));
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.compaction.auto, true);
  assert.equal(parsed.compaction.other, true);
  assert.deepEqual(parsed.compaction.keep, { tokens: 50000 });
  assert.equal(parsed.compaction.buffer, 10000);
});

test('hasJsonComments ignores comment markers inside strings', () => {
  assert.equal(hasJsonComments('{"url":"https://example.com"}'), false);
  assert.equal(hasJsonComments('{"a":"/* not a comment */"}'), false);
  assert.equal(hasJsonComments('// comment\n{}'), true);
  assert.equal(hasJsonComments('/* block */ {}'), true);
});

test('mergeJson rejects invalid JSON', () => {
  assert.throws(() => mergeJson('{', {}), /JSON/);
});

test('mergeJson replaces arrays and scalars and is idempotent', () => {
  const input = JSON.stringify({
    tags: ['a', 'b'],
    compact: { mode: 'old' },
  }, null, 2);
  const once = mergeJson(input, { tags: ['c'], compact: { mode: 'new' } });
  const parsed = JSON.parse(once);
  assert.deepEqual(parsed.tags, ['c']);
  assert.equal(parsed.compact.mode, 'new');
  assert.equal(mergeJson(once, { tags: ['c'], compact: { mode: 'new' } }), once);
});
