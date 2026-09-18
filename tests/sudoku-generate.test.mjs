import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  generateSudoku,
  isValidComplete,
  INPUT_SPAN,
  BAND_COUNT,
  BANDS
} = require('./sudoku-generate-lib.js');

test('generateSudoku(0n) is a valid complete grid and deterministic', () => {
  const a = generateSudoku(0n);
  const b = generateSudoku(0n);
  assert.equal(a.length, 81);
  assert.equal(a, b);
  assert.ok(isValidComplete(a));
});

test('generateSudoku is deterministic for several seeds and always valid', () => {
  const seeds = [0n, 1n, 415n, 416n, 12345678901234567890n, INPUT_SPAN - 1n];
  for (const n of seeds) {
    const first = generateSudoku(n);
    const second = generateSudoku(n);
    assert.equal(first, second, `not deterministic for n=${n}`);
    assert.ok(isValidComplete(first), `invalid complete for n=${n}`);
  }
});

test('nearby seeds usually differ (generator consumes n)', () => {
  const a = generateSudoku(0n);
  const b = generateSudoku(1n);
  const c = generateSudoku(BAND_COUNT);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('BANDS table has 416 bands of 27 digits', () => {
  assert.equal(BANDS.length, Number(BAND_COUNT));
  for (const band of BANDS) {
    assert.match(band, /^[1-9]{27}$/);
  }
});

test('negative seeds match their absolute value', () => {
  assert.equal(generateSudoku(-7n), generateSudoku(7n));
});
