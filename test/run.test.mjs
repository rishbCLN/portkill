import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/run.mjs';

const NODE = process.execPath;

test('run: captures stdout and a zero exit code', async () => {
  const r = await run(NODE, ['-e', "process.stdout.write('hi')"]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'hi');
});

test('run: a non-zero exit does not throw', async () => {
  const r = await run(NODE, ['-e', 'process.exit(3)']);
  assert.equal(r.code, 3);
  assert.ok(!r.error);
});

test('run: a missing binary resolves with ENOENT, never throws', async () => {
  const r = await run('definitely-not-a-real-bin-xyz');
  assert.equal(r.code, -1);
  assert.ok(r.error);
  assert.equal(r.error.code, 'ENOENT');
});

test('run: a timeout kills the child and reports an error', async () => {
  const r = await run(NODE, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 150 });
  assert.equal(r.code, -1);
  assert.ok(r.error);
  assert.match(r.error.message, /timed out/i);
});

test('run: feeds stdin via the input option', async () => {
  const r = await run(NODE, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'ok' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'ok');
});
