import assert from 'node:assert/strict';
import { test } from 'node:test';
import { max, mean, sum } from '../src/calc.mjs';

test('sum adds the values', () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(sum([]), 0);
});

test('mean is the average, and refuses an empty list', () => {
  assert.equal(mean([2, 4, 6]), 4);
  assert.throws(() => mean([]), RangeError);
});

test('max is the largest value', () => {
  assert.equal(max([3, 9, 2]), 9);
});
