import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { chromium } from 'playwright';

const appUrl = new URL('../index.html', import.meta.url);
const html = await fs.readFile(appUrl, 'utf8');
const source = html.match(/<script id="solver-worker" type="text\/plain">([\s\S]*?)<\/script>/)[1];
const solver = vm.createContext({ performance, self: {} });
vm.runInContext(source, solver);
const hintContext = vm.createContext({});
vm.runInContext(html.match(/<script id="hint-engine">([\s\S]*?)<\/script>/)[1], hintContext);
const hints = vm.runInContext('SudokuHints', hintContext);
const hintFixtures = JSON.parse(await fs.readFile(new URL('./hint-fixtures.json', import.meta.url), 'utf8')).states;
const digits = text => Array.from(text, Number);
const EXAMPLE = '530070000600195000098000060800060003400803001700020006060000280000419005000080079';
const SOLUTION = '534678912672195348198342567859761423426853791713924856961537284287419635345286179';
const HARD = '100007090030020008009600500005300900010080002600004000300000010040000007007000300';
const VERY_HARD = '800000000003600000070090200050007000000045700000100030001000068008500010090000400';
const SEVENTEEN = '000000010400000000020000000000050407008000300001090000300400200050100000000806000';
const IMPOSSIBLE = '531' + EXAMPLE.slice(3);
function solve(board, budgetMs = 8000) {
  solver.input = board; solver.budgetMs = budgetMs;
  return vm.runInContext('countSolutions(input, budgetMs)', solver);
}
function removable(board, budgetMs = 8000) {
  solver.input = board; solver.budgetMs = budgetMs;
  return vm.runInContext('findRemovableClue(input, budgetMs)', solver);
}
function assertCompletion(givens, solution) {
  assert.ok(Array.isArray(solution));
  assert.equal(solution.length, 81);
  for (let i = 0; i < 81; i++) {
    assert.ok(Number.isInteger(solution[i]) && solution[i] >= 1 && solution[i] <= 9);
    if (givens[i]) assert.equal(solution[i], givens[i], `Changed given at cell ${i}`);
  }
  for (let unit = 0; unit < 9; unit++) {
    const row = [], col = [], box = [];
    for (let pos = 0; pos < 9; pos++) {
      row.push(solution[unit * 9 + pos]);
      col.push(solution[pos * 9 + unit]);
      box.push(solution[(Math.floor(unit / 3) * 3 + Math.floor(pos / 3)) * 9 + (unit % 3) * 3 + pos % 3]);
    }
    for (const values of [row, col, box]) assert.equal(new Set(values).size, 9);
  }
}

// Independent reference: Algorithm X with Set-based exact-cover constraints.
// It shares no candidate propagation or search code with the app's bit-mask solver.
function referenceCount(board) {
  const columns = new Map(Array.from({ length: 324 }, (_, i) => [i, new Set()]));
  const rows = new Map();
  for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) for (let d = 0; d < 9; d++) {
    if (board[r * 9 + c] && board[r * 9 + c] !== d + 1) continue;
    const id = (r * 9 + c) * 9 + d;
    const constraints = [r * 9 + c, 81 + r * 9 + d, 162 + c * 9 + d, 243 + (Math.floor(r / 3) * 3 + Math.floor(c / 3)) * 9 + d];
    rows.set(id, constraints);
    for (const col of constraints) columns.get(col).add(id);
  }
  let count = 0;
  function search() {
    if (!columns.size) { count++; return; }
    let smallest;
    for (const set of columns.values()) if (!smallest || set.size < smallest.size) smallest = set;
    if (!smallest.size) return;
    for (const row of [...smallest]) {
      const removed = [];
      for (const col of rows.get(row)) {
        const set = columns.get(col);
        for (const otherRow of set) for (const otherCol of rows.get(otherRow)) {
          if (otherCol !== col && columns.has(otherCol)) columns.get(otherCol).delete(otherRow);
        }
        removed.push([col, set]); columns.delete(col);
      }
      search();
      for (const [col, set] of removed.reverse()) {
        columns.set(col, set);
        for (const otherRow of set) for (const otherCol of rows.get(otherRow)) {
          if (otherCol !== col && columns.has(otherCol)) columns.get(otherCol).add(otherRow);
        }
      }
      if (count >= 2) return;
    }
  }
  search(); return count;
}

test('solver: known unique, multiple, conflict, and impossible grids', () => {
  const fixtures = [
    ['blank', '0'.repeat(81), 'multiple', 2],
    ['one clue', '1' + '0'.repeat(80), 'multiple', 2],
    ['example', EXAMPLE, 'unique', 1],
    ['hard', HARD, 'unique', 1],
    ['very hard', VERY_HARD, 'unique', 1],
    ['17 clues', SEVENTEEN, 'unique', 1],
    ['complete', SOLUTION, 'unique', 1],
    ['no duplicates but impossible', IMPOSSIBLE, 'none', 0],
    ['duplicate givens', '55' + EXAMPLE.slice(2), 'conflict', 0]
  ];
  for (const [name, text, status, count] of fixtures) {
    const result = solve(digits(text));
    assert.equal(result.status, status, name);
    assert.equal(result.count, count, name);
    if (count) assertCompletion(digits(text), result.solution);
    else assert.equal(result.solution, null);
    assert.equal(referenceCount(digits(text)), count, `Reference disagrees on ${name}`);
    assert.ok(result.elapsed < 1000, `${name} exceeded one second: ${result.elapsed} ms`);
    console.log(`${name}: ${result.status}, ${result.elapsed.toFixed(2)} ms, ${result.nodes} search nodes`);
  }
});

test('solver: 180 deterministic edited boards match the independent reference', () => {
  let seed = 981734;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let maxMs = 0;
  for (let run = 0; run < 180; run++) {
    const keep = .12 + random() * .73;
    const board = digits(SOLUTION).map(value => random() < keep ? value : 0);
    // Include arbitrary wrong clues as well as valid partial solutions.
    if (run % 3 === 0) board[Math.floor(random() * 81)] = 1 + Math.floor(random() * 9);
    const expected = referenceCount(board), actual = solve(board);
    assert.notEqual(actual.status, 'incomplete', `Board ${run} timed out`);
    assert.equal(actual.count, expected, `Mismatch on board ${run}: ${board.join('')}`);
    if (expected) assertCompletion(board, actual.solution);
    else assert.equal(actual.solution, null);
    maxMs = Math.max(maxMs, actual.elapsed);
  }
  assert.ok(maxMs < 1000, `Worst solve: ${maxMs} ms`);
  console.log(`180 edited boards: reference agreed on all; slowest solver check ${maxMs.toFixed(2)} ms`);
});

test('solver: exhausted time budget never claims uniqueness', () => {
  const result = solve(digits(HARD), 0);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.count, 0);
  assert.equal(result.solution, null);
});

test('solver: repeated safe removals stop only when every remaining clue is essential', () => {
  const board = digits(EXAMPLE);
  let removed = 0;
  const started = performance.now();
  while (true) {
    const before = board.slice(), result = removable(board);
    assert.deepEqual(board, before, 'Removal analysis must not edit the puzzle');
    if (result.status === 'minimal') break;
    assert.equal(result.status, 'available');
    assert.ok(Number.isInteger(result.index) && board[result.index] > 0);
    board[result.index] = 0;
    assert.equal(referenceCount(board), 1, 'Every removed clue must preserve uniqueness');
    assert.ok(++removed <= 81);
  }
  assert.ok(removed > 0);
  for (let i = 0; i < 81; i++) if (board[i]) {
    const trial = board.slice(); trial[i] = 0;
    assert.equal(referenceCount(trial), 2, `Clue ${i} was incorrectly called essential`);
  }
  console.log(`Removed ${removed} clues, then independently verified all ${board.filter(Boolean).length} remaining clues are essential (${(performance.now() - started).toFixed(2)} ms)`);
});

test('solver: minimal grids and incomplete removal checks are distinct', () => {
  assert.equal(removable(digits(SEVENTEEN)).status, 'minimal');
  const result = removable(digits(EXAMPLE), 0);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.index, null);
  const full = removable(digits(SOLUTION));
  assert.equal(full.status, 'available');
  const trial = digits(SOLUTION); trial[full.index] = 0;
  assert.equal(referenceCount(trial), 1);
});

function verifyDeduction(board, hint) {
  const legal = hints.candidates(board);
  if (hint.type === 'placement') {
    assert.equal(board[hint.target], 0);
    for (let n = 1; n <= 9; n++) if (n !== hint.value && (legal[hint.target] & (1 << (n - 1)))) {
      const trial = board.slice(); trial[hint.target] = n;
      assert.equal(referenceCount(trial), 0, `${hint.technique}: ${n} at ${hint.target} is still possible`);
    }
    const trial = board.slice(); trial[hint.target] = hint.value;
    assert.ok(referenceCount(trial) > 0, 'The suggested value must permit a completion');
    const crossed = hint.steps.flatMap(s => s.remove).filter(e => e.index === hint.target).reduce((mask, e) => mask | e.mask, 0);
    assert.equal(hint.notes[hint.target] & ~crossed, 1 << (hint.value - 1), 'The displayed steps must leave exactly the suggested digit');
  } else if (hint.type === 'elimination') {
    assert.ok(hint.remove.length);
    for (const { index, mask } of hint.remove) {
      assert.equal(board[index], 0);
      assert.equal(mask & hint.notes[index], mask, 'Only existing notes may be eliminated');
      for (let n = 1; n <= 9; n++) if (mask & (1 << (n - 1))) {
        const trial = board.slice(); trial[index] = n;
        assert.equal(referenceCount(trial), 0, `${hint.technique}: eliminated ${n} at ${index} is still possible`);
      }
    }
  }
}

test('hints: every teaching strategy produces deductions verified by independent exact cover', () => {
  const seen = new Set(); let maxMs = 0;
  for (const fixture of hintFixtures) {
    const board = digits(fixture.board), excluded = Array(81).fill(0);
    for (const [index, mask] of fixture.excluded) excluded[index] = mask;
    const before = board.slice(), started = performance.now();
    const hint = hints.next(board, excluded); maxMs = Math.max(maxMs, performance.now() - started);
    assert.equal(hint.technique, fixture.technique);
    assert.equal(hint.rank, fixture.rank);
    assert.deepEqual(board, before, 'Requesting a hint must never change the board');
    verifyDeduction(board, hint); seen.add(hint.technique);
  }
  for (const strategy of ['Row alone', 'Column alone', 'Box alone', 'Row + column', 'Row + box', 'column + box', 'Row + column + box', 'Hidden single in a row', 'Hidden single in a column', 'Hidden single in a box', 'Locked candidates · pointing', 'Locked candidates · claiming', 'Naked pair', 'Hidden pair', 'Naked triple', 'Hidden triple', 'X-Wing', 'XY-Wing', 'Swordfish']) assert.ok(seen.has(strategy), `Missing coverage for ${strategy}`);
  assert.ok(maxMs < 1000);
  console.log(`Independently verified ${seen.size} hint outcomes; slowest hint ${maxMs.toFixed(2)} ms`);
});

test('hints: a complete logical walkthrough, invalid input, and a truthful stall', () => {
  const board = digits(EXAMPLE), excluded = Array(81).fill(0); let placements = 0;
  for (let turn = 0; turn < 200; turn++) {
    const hint = hints.next(board, excluded);
    if (hint.type === 'complete') break;
    verifyDeduction(board, hint);
    if (hint.type === 'placement') { board[hint.target] = hint.value; placements++; }
    else if (hint.type === 'elimination') for (const { index, mask } of hint.remove) excluded[index] |= mask;
    else assert.fail(`Unexpected ${hint.type} on the example`);
  }
  assert.equal(board.join(''), SOLUTION); assert.equal(placements, 51);
  assert.equal(hints.next(digits('55' + EXAMPLE.slice(2))).type, 'invalid');
  const stalled = hints.next(Array(81).fill(0));
  assert.equal(stalled.type, 'stalled'); assert.equal(stalled.value, null); assert.equal(stalled.remove.length, 0);
  assert.match(stalled.conclusion, /not proof that guessing is unavoidable/);
});

test('browser: standalone file, editing, live checks, persistence, and responsive layout', { timeout: 60000 }, async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const screenshots = path.join(tmpdir(), 'sudoku-ux');
  await fs.mkdir(screenshots, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [], network = [];
  page.on('pageerror', e => { errors.push(e.message); console.error(`Browser error: ${e.message}`); });
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  const cell = i => page.locator(`.cell[data-index="${i}"]`);
  const state = () => page.locator('#status-panel').getAttribute('data-state');
  const displayedGrid = () => page.locator('.cell').allTextContents().then(values => values.map(v => v || '0').join(''));
  const toggle = page.locator('#solution-toggle');
  const harder = page.locator('#harder'), easier = page.locator('#easier');
  async function settled(expected) {
    await page.waitForFunction(() => document.querySelector('#status-panel').dataset.state !== 'checking');
    assert.equal(await state(), expected);
  }
  async function paste(text) {
    await cell(0).focus();
    await page.evaluate(value => {
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', value);
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }, text);
  }
  async function removalsSettled(expected) {
    await page.waitForFunction(() => {
      const state = document.querySelector('#difficulty-controls').dataset.removalState;
      return state === 'available' || state === 'minimal' || state === 'incomplete' || state === 'error';
    });
    if (expected) assert.equal(await page.locator('#difficulty-controls').getAttribute('data-removal-state'), expected);
  }
  try {
    await page.goto(appUrl.href);
    assert.deepEqual(errors, [], 'The editor must load without browser errors');
    await t.test('blank grid is usable with no network requests', async () => {
      await settled('multiple');
      assert.equal(await page.getByRole('gridcell').count(), 81);
      assert.equal(await page.locator('#given-count').innerText(), '0');
      assert.equal(await page.locator('.cell[tabindex="0"]').count(), 1);
      await page.screenshot({ path: path.join(screenshots, 'desktop-empty.png'), fullPage: true });
    });
    await t.test('keyboard and pad input, row/column/box conflicts, and undo/redo', async () => {
      await cell(0).click(); await page.keyboard.press('5');
      await page.keyboard.press('ArrowRight'); await page.getByRole('button', { name: 'Enter 5', exact: true }).click();
      await settled('conflict'); assert.equal(await page.locator('.cell.conflict').count(), 2);
      await page.locator('#undo').click(); await settled('multiple');
      assert.equal(await cell(1).innerText(), '');
      await page.locator('#redo').click(); await settled('conflict');
      await page.keyboard.press('Backspace'); await settled('multiple');
      await cell(9).click(); await page.keyboard.press('5'); await settled('conflict');
      await page.keyboard.press('ControlOrMeta+z'); await settled('multiple');
      await cell(10).click(); await page.keyboard.press('5'); await settled('conflict');
      await page.screenshot({ path: path.join(screenshots, 'desktop-conflict.png'), fullPage: true });
      await page.locator('#erase').click(); await settled('multiple');
      await cell(0).click(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowUp');
      assert.equal(await page.locator('#selected-coordinate').innerText(), 'A1');
      await cell(80).click(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
      assert.equal(await page.locator('#selected-coordinate').innerText(), 'I9');
    });
    await t.test('example is unique; clear and replacement undo in one step', async () => {
      await page.locator('#load-example').click(); await settled('unique');
      assert.equal(await page.locator('#given-count').innerText(), '30');
      const elapsed = Number(await page.locator('#status-panel').getAttribute('data-elapsed-ms'));
      assert.ok(elapsed < 1000, `Example UI check took ${elapsed} ms`);
      console.log(`Example edit-to-result in Chrome: ${elapsed.toFixed(2)} ms`);
      for (const selector of ['#sudoku-grid', '#load-example']) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box.y + box.height <= 800, `${selector} should fit on a laptop screen (bottom: ${box.y + box.height}px)`);
      }
      await page.screenshot({ path: path.join(screenshots, 'desktop-example.png'), fullPage: true });
      await page.locator('#clear').click(); await settled('multiple');
      assert.equal(await page.locator('#given-count').innerText(), '0');
      await page.locator('#undo').click(); await settled('unique');
      assert.equal(await page.locator('#given-count').innerText(), '30');
    });
    await t.test('unique solution preview preserves clues, history, and the saved draft', async () => {
      await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Draft saved in this browser');
      const saved = await page.evaluate(() => localStorage.getItem('sudoku-studio-draft-v1'));
      const elapsed = await page.locator('#status-panel').getAttribute('data-elapsed-ms');
      assert.equal(await toggle.innerText(), 'Show the solution');
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#board-title').innerText(), 'The solution');
      assert.equal(await displayedGrid(), SOLUTION);
      assert.equal(await page.locator('.cell.solution-value').count(), 51);
      assert.equal(await page.locator('.cell.given-value').count(), 30);
      assert.equal(await page.locator('#given-count').innerText(), '30');
      assert.equal(await page.locator('#status-panel').getAttribute('data-elapsed-ms'), elapsed, 'Preview should use the cached solution');
      assert.equal(await page.evaluate(() => localStorage.getItem('sudoku-studio-draft-v1')), saved);
      await cell(2).click(); await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('.cell.same-value').count(), 9);
      assert.equal(await cell(2).getAttribute('aria-label'), 'Row 1, column C, 4, solution value');
      await page.screenshot({ path: path.join(screenshots, 'desktop-solution.png'), fullPage: true });
      await toggle.click();
      assert.equal(await displayedGrid(), EXAMPLE);
      assert.equal(await page.locator('#board-title').innerText(), 'Your puzzle');
      await toggle.click(); await page.reload(); await settled('unique');
      assert.equal(await displayedGrid(), EXAMPLE, 'Reload must restore only the givens');
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
      assert.ok(await page.locator('#undo').isDisabled());
      await toggle.click(); await toggle.click();
      assert.ok(await page.locator('#undo').isDisabled(), 'Toggling must not create history entries');
    });
    await t.test('editing a preview immediately clears it and changes only the intended clue', async () => {
      await toggle.click(); await cell(2).click();
      const immediate = await page.evaluate(() => {
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '4', bubbles: true, cancelable: true }));
        return {
          disabled: document.querySelector('#solution-toggle').disabled,
          preview: document.querySelectorAll('.solution-value').length,
          givens: document.querySelector('#given-count').textContent
        };
      });
      assert.deepEqual(immediate, { disabled: true, preview: 0, givens: '31' });
      await settled('unique');
      assert.equal(await displayedGrid(), '534' + EXAMPLE.slice(3));
      await page.locator('#undo').click(); await settled('unique');
      assert.equal(await displayedGrid(), EXAMPLE);
    });
    await t.test('multiple solutions are labeled possible; impossible and conflicting grids disable preview', async () => {
      const partial = SOLUTION.slice(0, 9) + '0'.repeat(72);
      await paste(partial); await settled('multiple');
      assert.equal(await toggle.innerText(), 'Show a possible solution');
      await toggle.click();
      assert.equal(await page.locator('#board-title').innerText(), 'A possible solution');
      assertCompletion(digits(partial), digits(await displayedGrid()));
      assert.equal(await page.locator('#given-count').innerText(), '9');
      await toggle.click(); assert.equal(await displayedGrid(), partial);
      await toggle.click(); await cell(0).click(); await page.keyboard.press('3');
      await settled('conflict');
      assert.ok(await toggle.isDisabled());
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('.solution-value').count(), 0);
      await page.waitForTimeout(100); assert.ok(await toggle.isDisabled());
      await page.locator('#undo').click(); await settled('multiple');
      await toggle.click(); await paste(IMPOSSIBLE); await settled('none');
      assert.ok(await toggle.isDisabled());
      assert.equal(await displayedGrid(), IMPOSSIBLE);
      await paste(EXAMPLE); await settled('unique');
    });
    await t.test('non-duplicate contradiction is reported separately', async () => {
      await cell(2).click(); await page.keyboard.press('1'); await settled('none');
      assert.equal(await page.locator('.cell.conflict').count(), 0);
      await page.keyboard.press('ControlOrMeta+z'); await settled('unique');
    });
    await t.test('pasting a grid and reload preserve givens', async () => {
      await paste(HARD); await settled('unique');
      assert.ok(Number(await page.locator('#status-panel').getAttribute('data-elapsed-ms')) < 1000);
      await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Draft saved in this browser');
      await page.reload(); await settled('unique');
      assert.equal(await page.locator('.cell').allTextContents().then(values => values.map(v => v || '0').join('')), HARD);
    });
    await t.test('rapid edits cannot publish an obsolete result', async () => {
      await page.locator('#clear').click();
      await cell(0).click();
      await page.keyboard.press('1'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('1');
      await settled('conflict');
      await page.waitForTimeout(150);
      assert.equal(await state(), 'conflict');
      await page.keyboard.press('Backspace'); await settled('multiple');
    });
    await t.test('harder removes exactly one verified clue and supports undo/redo', async () => {
      await paste(EXAMPLE); await settled('unique'); await removalsSettled('available');
      assert.ok(await harder.isEnabled());
      await toggle.click(); await harder.click(); await settled('unique'); await removalsSettled();
      const adjusted = await displayedGrid();
      const differences = [...EXAMPLE].flatMap((value, i) => value !== adjusted[i] ? [i] : []);
      assert.equal(differences.length, 1);
      assert.notEqual(EXAMPLE[differences[0]], '0');
      assert.equal(adjusted[differences[0]], '0');
      assert.equal(referenceCount(digits(adjusted)), 1);
      assert.equal(await page.locator('#given-count').innerText(), '29');
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
      await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Draft saved in this browser');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sudoku-studio-draft-v1')).join('')), adjusted);
      await page.locator('#undo').click(); await settled('unique'); await removalsSettled('available');
      assert.equal(await displayedGrid(), EXAMPLE);
      await page.locator('#redo').click(); await settled('unique'); await removalsSettled();
      assert.equal(await displayedGrid(), adjusted);
    });
    await t.test('easier adds one random solution clue; harder disables on an essential-clue puzzle', async () => {
      await paste(SEVENTEEN); await settled('unique'); await removalsSettled('minimal');
      assert.ok(await harder.isDisabled());
      assert.match(await page.locator('#difficulty-note').innerText(), /Every remaining clue is needed/);
      assert.ok(await easier.isEnabled());
      await toggle.click(); const completion = await displayedGrid();
      await easier.click(); await settled('unique'); await removalsSettled('available');
      const adjusted = await displayedGrid();
      const differences = [...SEVENTEEN].flatMap((value, i) => value !== adjusted[i] ? [i] : []);
      assert.equal(differences.length, 1);
      const index = differences[0];
      assert.equal(SEVENTEEN[index], '0');
      assert.equal(adjusted[index], completion[index]);
      assert.equal(await page.locator('#given-count').innerText(), '18');
      assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
      assert.ok(await harder.isEnabled());
      await page.locator('#undo').click(); await settled('unique'); await removalsSettled('minimal');
      assert.equal(await displayedGrid(), SEVENTEEN);
      assert.ok(await harder.isDisabled());
      await page.locator('#redo').click(); await settled('unique'); await removalsSettled('available');
      assert.equal(await displayedGrid(), adjusted);
      await page.screenshot({ path: path.join(screenshots, 'desktop-clue-controls.png'), fullPage: true });
    });
    await t.test('full, multiple-solution, and invalid grids enable only valid clue actions', async () => {
      await paste(SOLUTION); await settled('unique'); await removalsSettled('available');
      assert.ok(await easier.isDisabled()); assert.ok(await harder.isEnabled());
      await page.locator('#clear').click(); await settled('multiple');
      assert.ok(await harder.isDisabled()); assert.ok(await easier.isEnabled());
      await toggle.click(); const completion = await displayedGrid();
      await easier.click(); await settled('multiple');
      const next = await displayedGrid();
      assert.equal([...next].filter(v => v !== '0').length, 1);
      const index = [...next].findIndex(v => v !== '0');
      assert.equal(next[index], completion[index]);
      for (const puzzle of [IMPOSSIBLE, '55' + EXAMPLE.slice(2)]) {
        await paste(puzzle); await settled(puzzle === IMPOSSIBLE ? 'none' : 'conflict');
        assert.ok(await harder.isDisabled()); assert.ok(await easier.isDisabled());
      }
    });
    await t.test('delayed removal results cannot re-enable harder after a conflicting edit', async () => {
      const delayedContext = await browser.newContext();
      await delayedContext.addInitScript(() => {
        const NativeWorker = window.Worker;
        window.Worker = class {
          constructor(url) {
            this.worker = new NativeWorker(url);
            this.worker.onmessage = event => {
              if (event.data.kind === 'removal') setTimeout(() => this.onmessage?.(event), 300);
              else this.onmessage?.(event);
            };
            this.worker.onerror = event => this.onerror?.(event);
          }
          postMessage(data) { this.worker.postMessage(data); }
          terminate() { this.worker.terminate(); }
        };
      });
      const delayedPage = await delayedContext.newPage();
      try {
        await delayedPage.goto(appUrl.href);
        await delayedPage.locator('#load-example').click();
        await delayedPage.waitForFunction(() => document.querySelector('#status-panel').dataset.state === 'unique');
        assert.ok(await delayedPage.locator('#harder').isDisabled());
        await delayedPage.locator('.cell[data-index="2"]').click();
        await delayedPage.keyboard.press('5');
        await delayedPage.waitForTimeout(400);
        assert.equal(await delayedPage.locator('#status-panel').getAttribute('data-state'), 'conflict');
        assert.equal(await delayedPage.locator('#difficulty-controls').getAttribute('data-removal-state'), 'unavailable');
        assert.ok(await delayedPage.locator('#harder').isDisabled());
        assert.ok(await delayedPage.locator('#easier').isDisabled());
      } finally { await delayedContext.close(); }
    });
    await t.test('teaching steps color supporting cells and cross out notes without editing clues', async () => {
      await paste(EXAMPLE); await settled('unique');
      await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Draft saved in this browser');
      const expected = hints.next(digits(EXAMPLE));
      assert.ok(expected.steps.length > 1);
      const saved = await page.evaluate(() => localStorage.getItem('sudoku-studio-draft-v1'));
      await page.locator('#show-hint').click();
      assert.equal(await page.locator('#lesson-panel').getAttribute('data-hint-type'), 'placement');
      assert.equal(await page.locator('#hint-title').innerText(), expected.technique);
      assert.equal(await page.locator('.hint-target').getAttribute('data-index'), String(expected.target));
      assert.deepEqual((await page.locator('.hint-support').evaluateAll(nodes => nodes.map(n => Number(n.dataset.index)))).sort((a,b) => a-b), [...expected.steps[0].cells].sort((a,b) => a-b));
      assert.ok(await page.locator('#apply-hint').isDisabled());
      assert.ok(await page.locator('#hint-notes .cut').count() > 0);
      assert.match(await page.locator('#hint-message').getAttribute('class'), new RegExp(`color-${expected.steps[0].color}`));
      for (let i = 1; i < expected.steps.length; i++) await page.locator('#next-step').click();
      assert.equal(await page.locator('#hint-notes .cut').count(), 8);
      assert.equal(await page.locator('#hint-notes .kept').innerText(), String(expected.value));
      assert.ok(await page.locator('#apply-hint').isEnabled());
      await page.screenshot({ path: path.join(screenshots, 'desktop-teaching.png'), fullPage: true });
      await page.locator('#previous-step').click();
      assert.ok(await page.locator('#hint-notes .cut').count() < 8, 'Previous step must restore notes not yet eliminated');
      await page.locator('#next-step').click(); await page.locator('#apply-hint').click();
      assert.equal(await page.locator('.cell.learned-value').count(), 1);
      assert.equal(await cell(expected.target).innerText(), String(expected.value));
      assert.equal(await page.locator('#given-count').innerText(), '30');
      assert.equal(await page.evaluate(() => localStorage.getItem('sudoku-studio-draft-v1')), saved);
      await cell(expected.target).click(); await page.keyboard.press('Backspace');
      assert.equal(await page.locator('.cell.learned-value').count(), 1, 'Teaching keyboard entry must not erase a clue or learned answer');
      await page.locator('#undo').click(); assert.equal(await page.locator('.cell.learned-value').count(), 0);
      await page.locator('#redo').click(); assert.equal(await page.locator('.cell.learned-value').count(), 1);
      await page.locator('#clear').click(); assert.equal(await page.locator('.cell.learned-value').count(), 0);
      await page.locator('#undo').click(); assert.equal(await page.locator('.cell.learned-value').count(), 1);
      await page.locator('#close-teaching').click(); assert.equal(await displayedGrid(), EXAMPLE);
      await page.locator('#show-hint').click();
      const progressed = digits(EXAMPLE); progressed[expected.target] = expected.value;
      assert.equal(await page.locator('#hint-title').innerText(), hints.next(progressed).technique);
      await page.locator('#close-teaching').click();
      await cell(expected.target).click(); await page.keyboard.press(String(expected.value)); await settled('unique');
      await page.locator('#show-hint').click();
      assert.equal(await page.locator('.cell.learned-value').count(), 0, 'Changing givens resets the learning state');
      await page.locator('#close-teaching').click();
    });
    await t.test('note eliminations are applied, remembered, and undoable in the learning board', async () => {
      const fixture = hintFixtures.find(f => f.technique === 'Locked candidates · pointing');
      const board = digits(fixture.board), expected = hints.next(board);
      await paste(fixture.board); await settled(solve(board).status);
      const givens = board.filter(Boolean).length;
      await page.locator('#show-hint').click();
      assert.equal(await page.locator('#lesson-panel').getAttribute('data-hint-type'), 'elimination');
      for (let i = 1; i < expected.steps.length; i++) await page.locator('#next-step').click();
      assert.ok(await page.locator('.pencil-grid .cut.color-result').count() > 0);
      await page.screenshot({ path: path.join(screenshots, 'desktop-elimination.png'), fullPage: true });
      await page.locator('#apply-hint').click();
      assert.equal(await page.locator('.cell.learned-value').count(), 0);
      assert.equal(await page.locator('#given-count').innerText(), String(givens));
      const excluded = Array(81).fill(0); for (const e of expected.remove) excluded[e.index] |= e.mask;
      await page.locator('#show-hint').click();
      assert.equal(await page.locator('#hint-title').innerText(), hints.next(board, excluded).technique);
      await page.locator('#undo').click(); await page.locator('#show-hint').click();
      assert.equal(await page.locator('#hint-title').innerText(), expected.technique);
      await toggle.click(); assert.equal(await page.locator('#lesson-panel').isVisible(), false);
      assertCompletion(board, digits(await displayedGrid()));
      await toggle.click(); assert.equal(await displayedGrid(), fixture.board);
    });
    await t.test('teaching does not disguise guessing, and handles complete and conflicting grids', async () => {
      await page.locator('#clear').click(); await settled('multiple');
      await page.locator('#show-hint').click();
      assert.equal(await page.locator('#lesson-panel').getAttribute('data-hint-type'), 'stalled');
      assert.match(await page.locator('#hint-conclusion').innerText(), /not proof that guessing is unavoidable/);
      assert.equal(await page.locator('#apply-hint').isVisible(), false);
      assert.equal(await page.locator('.cell.learned-value').count(), 0);
      await page.locator('#close-teaching').click();
      await paste(SOLUTION); await settled('unique'); await page.locator('#show-hint').click();
      assert.equal(await page.locator('#lesson-panel').getAttribute('data-hint-type'), 'complete');
      assert.equal(await page.locator('#apply-hint').isVisible(), false);
      await page.locator('#close-teaching').click();
      await paste('55' + EXAMPLE.slice(2)); await settled('conflict');
      assert.ok(await page.locator('#show-hint').isDisabled());
    });
    const pencil = page.locator('#pencil-toggle');
    const marks = i => cell(i).locator('.manual-notes .pencil-note').allTextContents().then(values => values.join(''));
    const noteButton = n => page.getByRole('button', { name: `Toggle note ${n}`, exact: true });
    await t.test('personal pencil notes toggle in fixed positions, save, and undo with clue edits', async () => {
      await paste(EXAMPLE); await settled('unique'); await removalsSettled('available');
      await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Draft saved in this browser');
      const saved = await page.evaluate(() => localStorage.getItem('sudoku-studio-draft-v1'));
      const elapsed = await page.locator('#status-panel').getAttribute('data-elapsed-ms');
      await cell(2).click(); await pencil.click();
      assert.equal(await pencil.getAttribute('aria-pressed'), 'true');
      for (const n of [1, 5, 9]) await noteButton(n).click();
      assert.deepEqual(await cell(2).locator('.manual-notes .pencil-note').allTextContents(), ['1', '', '', '', '5', '', '', '', '9']);
      await noteButton(5).click(); await page.keyboard.press('7');
      assert.equal(await marks(2), '179');
      assert.equal(await noteButton(7).getAttribute('aria-pressed'), 'true');
      assert.match(await cell(2).getAttribute('aria-label'), /pencil notes 1, 7, 9/);
      await cell(0).click();
      assert.ok(await noteButton(4).isDisabled());
      await page.keyboard.press('4'); assert.equal(await cell(0).innerText(), '5');
      await cell(3).click(); await noteButton(2).click();
      assert.equal(await marks(2), '179'); assert.equal(await marks(3), '2');
      assert.equal(await page.locator('#given-count').innerText(), '30');
      assert.equal(await page.locator('#status-panel').getAttribute('data-elapsed-ms'), elapsed, 'Notes must not trigger another solution check');
      assert.equal(await page.evaluate(() => localStorage.getItem('sudoku-studio-draft-v1')), saved);
      await page.locator('#undo').click(); assert.equal(await marks(3), '');
      await page.locator('#undo').click(); assert.equal(await marks(2), '19');
      await page.locator('#redo').click(); assert.equal(await marks(2), '179');
      await cell(2).click();
      await page.screenshot({ path: path.join(screenshots, 'desktop-pencil.png'), fullPage: true });
      await pencil.click(); await page.keyboard.press('4'); await settled('unique');
      assert.equal(await cell(2).innerText(), '4'); assert.equal(await marks(2), '');
      await page.locator('#undo').click(); await settled('unique'); assert.equal(await marks(2), '179');
      await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Draft saved in this browser');
      await page.reload(); await settled('unique');
      assert.equal(await marks(2), '179'); assert.equal(await pencil.getAttribute('aria-pressed'), 'false');
      await toggle.click(); assert.equal(await displayedGrid(), SOLUTION);
      await toggle.click(); assert.equal(await marks(2), '179');
      await cell(2).click(); await page.locator('#erase').click(); assert.equal(await marks(2), '');
      await page.locator('#undo').click(); assert.equal(await marks(2), '179');
      await page.locator('#load-example').click(); assert.equal(await marks(2), '', 'Replacing the puzzle clears its old notes');
      await page.locator('#undo').click(); assert.equal(await marks(2), '179');
      await page.locator('#clear').click(); await settled('multiple');
      assert.equal(await page.locator('.manual-notes').count(), 0);
      await pencil.click(); await noteButton(3).click();
      assert.ok(await page.locator('#clear').isEnabled(), 'A grid with only notes can be cleared');
      await page.locator('#clear').click(); assert.equal(await page.locator('.manual-notes').count(), 0);
      await pencil.click();
    });
    await t.test('Ctrl temporarily inverts pencil mode, Control-click acts once, and a pencil click pins the mode', async () => {
      await cell(0).click();
      await page.keyboard.down('Control'); await page.keyboard.down('Control');
      assert.equal(await pencil.getAttribute('aria-pressed'), 'true');
      assert.equal(await pencil.getAttribute('data-temporary'), 'true');
      await noteButton(1).click(); assert.equal(await marks(0), '1', 'Control-click adds the note exactly once');
      await noteButton(1).click(); assert.equal(await marks(0), '', 'A second Control-click removes it exactly once');
      await page.keyboard.press('2'); await page.keyboard.up('Control');
      assert.equal(await marks(0), '2'); assert.equal(await pencil.getAttribute('aria-pressed'), 'false');
      await page.keyboard.press('Control+z'); assert.equal(await marks(0), '');
      await page.keyboard.press('Control+y'); assert.equal(await marks(0), '2');
      assert.equal(await pencil.getAttribute('aria-pressed'), 'false');
      await pencil.click(); await page.keyboard.down('Control');
      assert.equal(await pencil.getAttribute('aria-pressed'), 'false');
      await page.keyboard.press('3'); await page.keyboard.up('Control'); await settled('multiple');
      assert.equal(await cell(0).innerText(), '3'); assert.equal(await pencil.getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Control+z'); await settled('multiple');
      assert.equal(await marks(0), '2'); assert.equal(await pencil.getAttribute('aria-pressed'), 'true');
      await pencil.click();
      await page.keyboard.down('Control'); await pencil.click(); await page.keyboard.up('Control');
      assert.equal(await pencil.getAttribute('aria-pressed'), 'true', 'Clicking the temporarily active pencil keeps it on');
      await page.keyboard.down('Control'); await pencil.click(); await page.keyboard.up('Control');
      assert.equal(await pencil.getAttribute('aria-pressed'), 'false', 'Clicking temporary number mode keeps it off');
      await page.keyboard.down('Control');
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      assert.equal(await pencil.getAttribute('aria-pressed'), 'false', 'Losing focus clears a held modifier');
      await page.keyboard.up('Control');
    });
    await t.test('entering a correct answer clears that digit from peer notes in one undoable step', async () => {
      await paste(EXAMPLE); await settled('unique');
      // C1 row peer D1, column peer C4, box peer A3, unrelated D4.
      const peers = [3, 29, 18], unrelated = 30;
      await pencil.click();
      for (const i of [...peers, unrelated]) { await cell(i).click(); await noteButton(2).click(); await noteButton(4).click(); }
      await pencil.click();
      for (const i of [...peers, unrelated]) assert.equal(await marks(i), '24');
      // The unique solution has 4 at C1, so 2 is a wrong answer.
      await cell(2).click(); await page.keyboard.press('2'); await settled('none');
      assert.equal(await cell(2).innerText(), '2');
      for (const i of peers) assert.equal(await marks(i), '24', 'A wrong answer leaves peer notes untouched');
      await page.keyboard.press('4'); await settled('unique');
      assert.equal(await cell(2).innerText(), '4');
      for (const i of peers) assert.equal(await marks(i), '2', `peer ${i} loses the 4`);
      assert.equal(await marks(unrelated), '24', 'Cells outside the row, column, and box keep their notes');
      assert.equal(await page.locator('#given-count').innerText(), '31');
      await page.locator('#undo').click(); await settled('none');
      assert.equal(await cell(2).innerText(), '2');
      for (const i of peers) assert.equal(await marks(i), '24', 'One undo restores the previous digit and the cleared notes');
      await page.locator('#undo').click(); await settled('unique');
      assert.equal(await cell(2).innerText(), '');
      await page.locator('#redo').click(); await page.locator('#redo').click(); await settled('unique');
      assert.equal(await cell(2).innerText(), '4');
      for (const i of peers) assert.equal(await marks(i), '2');
      await page.locator('#erase').click(); await settled('unique');
      for (const i of peers) assert.equal(await marks(i), '2', 'Erasing does not restore notes');
      await page.locator('#undo').click(); await page.locator('#undo').click(); await page.locator('#undo').click(); await settled('unique');
      assert.equal(await cell(2).innerText(), '');
      await page.getByRole('button', { name: 'Enter 4', exact: true }).click(); await settled('unique');
      for (const i of peers) assert.equal(await marks(i), '2', 'The on-screen pad clears peer notes too');
      await page.locator('#undo').click(); await settled('unique');
      for (const i of peers) assert.equal(await marks(i), '24');
      // Correct entries keep clearing while the recheck of the previous edit is still running.
      await cell(3).click(); await page.keyboard.press('6'); await cell(2).click(); await page.keyboard.press('4');
      assert.equal(await marks(29), '2', 'A pending recheck does not forget the proven solution');
      await settled('unique');
      await page.locator('#undo').click(); await page.locator('#undo').click(); await settled('unique');
      for (const i of peers) assert.equal(await marks(i), '24');
      // Without a unique solution, correctness is unknown, so nothing is cleared.
      await page.locator('#clear').click(); await settled('multiple');
      await pencil.click(); await cell(1).click(); await noteButton(7).click(); await pencil.click();
      await cell(0).click(); await page.keyboard.press('7'); await settled('multiple');
      assert.equal(await marks(1), '7', 'Multiple-solution puzzles never auto-clear notes');
    });
    await t.test('pencil practice in teaching mode stays separate from proven hint notes and original clues', async () => {
      await paste(EXAMPLE); await settled('unique');
      await cell(2).click(); await pencil.click(); await noteButton(1).click(); await pencil.click();
      const expected = hints.next(digits(EXAMPLE));
      await page.locator('#show-hint').click(); await pencil.click();
      assert.ok(await page.locator('#number-pad').isVisible());
      await cell(expected.target).click(); await noteButton(1).click(); await noteButton(9).click();
      assert.equal(await marks(expected.target), '19');
      assert.equal(await page.locator('#hint-title').innerText(), expected.technique);
      await page.locator('#undo').click(); assert.equal(await marks(expected.target), '1');
      await page.locator('#redo').click(); assert.equal(await marks(expected.target), '19');
      await page.locator('#show-hint').click();
      assert.equal(await page.locator('#hint-title').innerText(), expected.technique, 'User notes must not change which deduction is proven');
      for (let i = 1; i < expected.steps.length; i++) await page.locator('#next-step').click();
      assert.equal(await page.locator('#hint-notes .kept').innerText(), String(expected.value));
      await page.locator('#apply-hint').click();
      assert.equal(await cell(expected.target).innerText(), String(expected.value));
      assert.equal(await marks(expected.target), '');
      await page.locator('#undo').click(); assert.equal(await marks(expected.target), '19');
      await page.locator('#close-teaching').click();
      assert.equal(await marks(2), '1'); assert.equal(await marks(expected.target), '', 'Lesson practice preserves the original builder notes');
      assert.equal(await page.locator('#given-count').innerText(), '30');
      await pencil.click();
    });
    await t.test('mobile layout fits and number entry still works', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#load-example').click(); await settled('unique');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const box = await page.locator('#sudoku-grid').boundingBox();
      assert.ok(box.width > 300 && Math.abs(box.height - box.width) < 2);
      await page.screenshot({ path: path.join(screenshots, 'mobile-example.png'), fullPage: true });
      await removalsSettled('available');
      const exampleBox = await page.locator('#load-example').boundingBox();
      const harderBox = await harder.boundingBox(), easierBox = await easier.boundingBox();
      assert.ok(harderBox.y >= exampleBox.y + exampleBox.height, 'Clue controls should be below the example button');
      assert.ok(Math.abs(harderBox.y - easierBox.y) < 1, 'Harder and easier should sit side by side');
      await cell(2).click(); await page.getByRole('button', { name: 'Enter 4', exact: true }).click();
      assert.equal(await cell(2).innerText(), '4'); await settled('unique');
      await page.setViewportSize({ width: 320, height: 740 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('#clear').click(); await settled('multiple'); await toggle.click();
      assert.equal(await page.locator('#board-title').innerText(), 'A possible solution');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Long preview label must fit a narrow screen');
      assertCompletion(Array(81).fill(0), digits(await displayedGrid()));
      await page.screenshot({ path: path.join(screenshots, 'mobile-solution.png'), fullPage: true });
      await toggle.click(); assert.equal(await displayedGrid(), '0'.repeat(81));
      await page.locator('#load-example').click(); await settled('unique');
      await page.locator('#show-hint').click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('#next-step').click();
      await page.screenshot({ path: path.join(screenshots, 'mobile-teaching.png'), fullPage: true });
      assert.ok(await page.locator('#hint-notes .cut').count() > 0);
      await page.locator('#apply-hint').click(); assert.equal(await page.locator('.cell.learned-value').count(), 1);
      await pencil.click(); await cell(2).click(); await noteButton(3).click();
      assert.equal(await marks(2), '3');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Pencil controls must fit a narrow screen');
      await page.screenshot({ path: path.join(screenshots, 'mobile-pencil.png'), fullPage: true });
    });
    assert.deepEqual(errors, [], 'Uncaught browser errors');
    assert.deepEqual(network, [], 'Standalone app must not make network requests');
    console.log(`UX screenshots: ${screenshots}`);
  } finally { await browser.close(); }
});
