import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/config.mjs';

function run(args) {
  return spawnSync(process.execPath, ['scripts/plan.mjs', ...args], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 5000,
  });
}

test('CLI calculates an explicitly marked demo, no Token or npm install required', () => {
  const result = run(['--budget', '25', '--drink']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /固定演示数据，不是官方实时价格/);
  assert.match(result.stdout, /样例实付 ¥22\.00/);
  assert.match(result.stdout, /实付反而增加 ¥3\.00/);
});

test('CLI JSON preserves integer cents and group budget semantics', () => {
  const result = run(['--budget', '25', '--people', '2', '--drink', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.source, 'demo');
  assert.equal(output.request.totalBudgetCents, 5000);
  assert.equal(output.plans[0].payableCents, 3800);
});

for (const args of [['--budget'], ['--main'], ['--people'], ['--budget', '--drink'], ['--people', '--json'], ['--main', '--json']]) {
  test(`CLI rejects a missing value instead of silently using defaults: ${args.join(' ')}`, () => {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /需要提供一个值/);
  });
}

test('CLI refuses unsupported flags and invalid budget values', () => {
  for (const args of [['--live'], ['--budget', 'NaN'], ['--people', '7']]) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
  }
});

test('CLI no-solution result does not change the requested amount', () => {
  const result = run(['--budget', '10', '--drink', '--json']);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.plans.length, 0);
  assert.equal(output.request.totalBudgetCents, 1000);
  assert.equal(output.minimumTotalCents, 2200);
});