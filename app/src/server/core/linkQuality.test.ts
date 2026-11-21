import assert from 'node:assert/strict';
import { test } from 'node:test';

import { judgeLink, LINK } from './linkQuality';

test('link: a server on the same Wi-Fi is good', () => {
  assert.deepEqual(judgeLink([37, 12, 40, 9, 25]), { good: true, medianMs: 25, lost: 0, probes: 5 });
  // one request lost among five is still good
  assert.equal(judgeLink([30, null, 28, 35, 31]).good, true);
  // the median, not the mean: one slow answer does not spoil it
  assert.deepEqual(judgeLink([20, 22, 1400, 25, 21]), { good: true, medianMs: 22, lost: 0, probes: 5 });
});

test('link: two requests lost of five, or slow answers, is bad', () => {
  assert.deepEqual(judgeLink([30, null, null, 35, 31]), { good: false, medianMs: 31, lost: 2, probes: 5 });
  assert.equal(judgeLink([700, 650, 900, 520, 610]).good, false);
  assert.equal(judgeLink([LINK.maxMedianMs, LINK.maxMedianMs, LINK.maxMedianMs]).good, true);
  assert.equal(judgeLink([LINK.maxMedianMs + 1, LINK.maxMedianMs + 1, LINK.maxMedianMs + 1]).good, false);
});

test('link: no answer at all, and nothing to judge by', () => {
  assert.deepEqual(judgeLink([null, null, null, null, null]), { good: false, medianMs: null, lost: 5, probes: 5 });
  assert.deepEqual(judgeLink([]), { good: false, medianMs: null, lost: 0, probes: 0 });
  // broken numbers count as lost
  assert.equal(judgeLink([Number.NaN, -1, 20, 20, 20]).lost, 2);
});
