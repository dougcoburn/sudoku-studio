import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

// Runs the exact inlined helper from index.html (no copy to keep in sync).
const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(html.match(/<script id="note-logic">([\s\S]*?)<\/script>/)[1], context);
const { clearPeerNotes, provenSolution, isCorrectEntry, peers } = vm.runInContext('SudokuNotes', context);

const row = i => Math.floor(i / 9), col = i => i % 9, box = i => Math.floor(row(i) / 3) * 3 + Math.floor(col(i) / 3);
const sees = (a, b) => a !== b && (row(a) === row(b) || col(a) === col(b) || box(a) === box(b));

test('notes: every cell has exactly 20 peers sharing a row, column, or box', () => {
  for (let i = 0; i < 81; i++) {
    assert.equal(peers[i].length, 20);
    assert.ok(peers[i].every(p => sees(i, p)));
  }
});

test('notes: placing a digit clears it only from peer notes', () => {
  for (const index of [0, 40, 80, 23]) for (let value = 1; value <= 9; value++) {
    const notes = Array(81).fill(511), bit = 1 << (value - 1);
    const next = clearPeerNotes(notes, index, value);
    assert.notEqual(next, notes, 'returns a new array');
    assert.ok(notes.every(mask => mask === 511), 'input is not mutated');
    for (let i = 0; i < 81; i++) assert.equal(next[i], sees(index, i) ? 511 & ~bit : 511, `cell ${i}`);
  }
});

test('notes: other digits survive and zero/invalid values are no-ops', () => {
  const notes = Array.from({ length: 81 }, (_, i) => (i * 37) % 512);
  const next = clearPeerNotes(notes, 10, 3);
  for (let i = 0; i < 81; i++) assert.equal(next[i] & ~4, notes[i] & ~4);
  assert.deepEqual(clearPeerNotes(notes, 10, 0), notes);
  assert.deepEqual(clearPeerNotes(notes, 10, 10), notes);
});

const digits = text => Array.from(text, Number);
const EXAMPLE = digits('530070000600195000098000060800060003400803001700020006060000280000419005000080079');
const SOLUTION = digits('534678912672195348198342567859761423426853791713924856961537284287419635345286179');
const proof = { clues: EXAMPLE, solution: SOLUTION };

test('notes: only digits matching a proven unique solution count as correct', () => {
  assert.equal(isCorrectEntry(EXAMPLE, proof, 2, 4), true);
  assert.equal(isCorrectEntry(EXAMPLE, proof, 2, 2), false);
  assert.equal(isCorrectEntry(EXAMPLE, null, 2, 4), false, 'no proof means unknown, never correct');
  assert.equal(isCorrectEntry(EXAMPLE, proof, 2, 0), false);
  const wrong = EXAMPLE.slice(); wrong[2] = 2;
  assert.equal(isCorrectEntry(wrong, proof, 2, 4), true, 'overwriting a wrong digit with the right one is correct');
  assert.equal(isCorrectEntry(wrong, proof, 3, 6), false, 'a wrong digit elsewhere voids the proof');
});

test('notes: a proof survives correct additions but not removed or changed clues', () => {
  const more = EXAMPLE.slice(); more[2] = 4; more[3] = 6;
  assert.equal(provenSolution(more, proof), SOLUTION);
  const fewer = EXAMPLE.slice(); fewer[0] = 0;
  assert.equal(provenSolution(fewer, proof), null, 'removing a proven clue may allow other solutions');
  assert.equal(isCorrectEntry(fewer, proof, 2, 4), false);
  assert.equal(provenSolution(EXAMPLE, null), null);
});
