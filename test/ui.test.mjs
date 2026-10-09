import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { makeStyler, colorEnabled, confirm, formatTable } from '../src/ui.mjs';

test('makeStyler(false) is a no-op', () => {
  const c = makeStyler(false);
  assert.equal(c.red('x'), 'x');
  assert.equal(c.bold('y'), 'y');
  assert.equal(c.enabled, false);
});

test('makeStyler(true) wraps with ANSI escapes', () => {
  const c = makeStyler(true);
  assert.equal(c.red('x'), '\x1b[31mx\x1b[39m');
  assert.equal(c.bold('y'), '\x1b[1my\x1b[22m');
});

test('colorEnabled: NO_COLOR disables even on a TTY', () => {
  assert.equal(colorEnabled({ NO_COLOR: '1' }, { isTTY: true }), false);
});

test('colorEnabled: FORCE_COLOR enables even off a TTY', () => {
  assert.equal(colorEnabled({ FORCE_COLOR: '1' }, { isTTY: false }), true);
});

test('colorEnabled: defaults to the stream TTY-ness', () => {
  assert.equal(colorEnabled({}, { isTTY: true }), true);
  assert.equal(colorEnabled({}, { isTTY: false }), false);
});

async function ask(answer) {
  const input = Readable.from([`${answer}\n`]);
  const output = new PassThrough();
  return confirm('Kill it?', { input, output });
}

test('confirm: "y" and "yes" are true', async () => {
  assert.equal(await ask('y'), true);
  assert.equal(await ask('yes'), true);
  assert.equal(await ask('Y'), true);
});

test('confirm: "n", empty, and anything else are false', async () => {
  assert.equal(await ask('n'), false);
  assert.equal(await ask(''), false);
  assert.equal(await ask('nope'), false);
});

test('formatTable: returns empty string for no rows', () => {
  assert.equal(formatTable([], makeStyler(false)), '');
});

test('formatTable: aligns columns and keeps COMMAND when present', () => {
  const c = makeStyler(false);
  const out = formatTable([{ port: 3000, pid: 48213, name: 'node', cmd: 'node app.js' }], c);
  const lines = out.split('\n');
  assert.match(lines[0], /PORT\s+PID\s+PROCESS\s+COMMAND/);
  assert.match(lines[1], /3000\s+48213\s+node\s+node app\.js/);
});

test('formatTable: truncates long commands with an ellipsis', () => {
  const c = makeStyler(false);
  const long = 'x'.repeat(100);
  const out = formatTable([{ port: 3000, pid: 1, name: 'n', cmd: long }], c);
  assert.match(out, /\u2026/);
  assert.ok(!out.includes(long));
});

test('formatTable: omits the COMMAND column when every cmd is empty (Windows)', () => {
  const c = makeStyler(false);
  const out = formatTable([
    { port: 3000, pid: 48213, name: 'node.exe', cmd: '' },
    { port: 8080, pid: 777, name: 'nginx.exe', cmd: '' },
  ], c);
  assert.doesNotMatch(out, /COMMAND/);
  assert.match(out, /PORT\s+PID\s+PROCESS/);
});
