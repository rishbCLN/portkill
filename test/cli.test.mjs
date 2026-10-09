import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/cli.mjs';

// A fake writable stream that records everything written to it.
function sink() {
  const chunks = [];
  return {
    chunks,
    isTTY: false,
    write(s) { chunks.push(String(s)); return true; },
    get text() { return chunks.join(''); },
  };
}

// Build a deps object with sensible test defaults (plain output via NO_COLOR,
// a non-TTY stdin, and no real process scanning/killing).
function makeDeps(overrides = {}) {
  const out = sink();
  const err = sink();
  const killed = [];
  return {
    out,
    err,
    killed,
    deps: {
      out,
      err,
      env: { NO_COLOR: '1' },
      stdin: { isTTY: false },
      pid: 999999,
      ppid: 999998,
      version: '9.9.9',
      isProtected: (pid) => pid === 1,
      find: async () => [],
      kill: async (pid) => { killed.push(pid); return { pid, ok: true }; },
      confirm: async () => true,
      ...overrides,
    },
  };
}

test('cli: --version prints version and exits 0', async () => {
  const { out, deps } = makeDeps();
  const code = await run(['--version'], deps);
  assert.equal(code, 0);
  assert.equal(out.text, 'portkill 9.9.9\n');
});

test('cli: no ports is a usage error (exit 2)', async () => {
  const { err, deps } = makeDeps();
  const code = await run([], deps);
  assert.equal(code, 2);
  assert.match(err.text, /specify at least one port/);
});

test('cli: invalid port is a usage error (exit 2)', async () => {
  const { deps } = makeDeps();
  const code = await run(['abc'], deps);
  assert.equal(code, 2);
});

test('cli: free port reports "is free" and exits 0', async () => {
  const { out, deps } = makeDeps({ find: async () => [] });
  const code = await run(['3000'], deps);
  assert.equal(code, 0);
  assert.match(out.text, /port 3000 is free/);
});

test('cli: --list shows the table but never kills', async () => {
  const { out, killed, deps } = makeDeps({
    find: async () => [{ port: 3000, pid: 48213, name: 'node', cmd: 'node app.js' }],
  });
  const code = await run(['3000', '--list'], deps);
  assert.equal(code, 0);
  assert.match(out.text, /48213/);
  assert.equal(killed.length, 0);
});

test('cli: --list --json includes skipped', async () => {
  const { out, deps } = makeDeps({
    isProtected: (pid) => pid === 1,
    find: async () => [
      { port: 3000, pid: 48213, name: 'node', cmd: '' },
      { port: 3000, pid: 1, name: 'init', cmd: '' },
    ],
  });
  const code = await run(['3000', '--list', '--json'], deps);
  assert.equal(code, 0);
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.killed, []);
  assert.equal(parsed.skipped.length, 1);
  assert.equal(parsed.skipped[0].pid, 1);
});

test('cli: --json without --force is read-only (no kill), exit 0', async () => {
  const { out, killed, deps } = makeDeps({
    find: async () => [{ port: 3000, pid: 48213, name: 'node', cmd: '' }],
  });
  const code = await run(['3000', '--json'], deps);
  assert.equal(code, 0);
  assert.equal(killed.length, 0);
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.killed, []);
  assert.equal(parsed.found.length, 1);
});

test('cli: --json --force kills and reports killed', async () => {
  const { out, killed, deps } = makeDeps({
    find: async () => [{ port: 3000, pid: 48213, name: 'node', cmd: '' }],
  });
  const code = await run(['3000', '--json', '--force'], deps);
  assert.equal(code, 0);
  assert.deepEqual(killed, [48213]);
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.success, true);
  assert.equal(parsed.killed.length, 1);
  assert.equal(parsed.killed[0].killed, true);
});

test('cli: protected pids are skipped, not killed', async () => {
  const { killed, deps } = makeDeps({
    isProtected: (pid) => pid === 1,
    find: async () => [{ port: 3000, pid: 1, name: 'init', cmd: '' }],
  });
  const code = await run(['3000', '--force'], deps);
  assert.equal(code, 0);
  assert.equal(killed.length, 0);
});

test('cli: own pid and parent pid are protected', async () => {
  const { killed, deps } = makeDeps({
    pid: 4242,
    ppid: 4243,
    isProtected: () => false,
    find: async () => [
      { port: 3000, pid: 4242, name: 'portkill', cmd: '' },
      { port: 3001, pid: 4243, name: 'bash', cmd: '' },
    ],
  });
  const code = await run(['3000', '3001', '--force'], deps);
  assert.equal(code, 0);
  assert.equal(killed.length, 0);
});

test('cli: one pid on several ports is killed once (dedupe)', async () => {
  const { killed, deps } = makeDeps({
    find: async () => [
      { port: 3000, pid: 48213, name: 'node', cmd: '' },
      { port: 3001, pid: 48213, name: 'node', cmd: '' },
    ],
  });
  const code = await run(['3000', '3001', '--force'], deps);
  assert.equal(code, 0);
  assert.deepEqual(killed, [48213]);
});

test('cli: confirm "no" aborts without killing (exit 0)', async () => {
  const { out, killed, deps } = makeDeps({
    stdin: { isTTY: true },
    confirm: async () => false,
    find: async () => [{ port: 3000, pid: 48213, name: 'node', cmd: '' }],
  });
  const code = await run(['3000'], deps);
  assert.equal(code, 0);
  assert.equal(killed.length, 0);
  assert.match(out.text, /aborted/);
});

test('cli: confirm "yes" kills', async () => {
  const { killed, deps } = makeDeps({
    stdin: { isTTY: true },
    confirm: async () => true,
    find: async () => [{ port: 3000, pid: 48213, name: 'node', cmd: '' }],
  });
  const code = await run(['3000'], deps);
  assert.equal(code, 0);
  assert.deepEqual(killed, [48213]);
});

test('cli: non-TTY without --force refuses (exit 2)', async () => {
  const { err, killed, deps } = makeDeps({
    stdin: { isTTY: false },
    find: async () => [{ port: 3000, pid: 48213, name: 'node', cmd: '' }],
  });
  const code = await run(['3000'], deps);
  assert.equal(code, 2);
  assert.equal(killed.length, 0);
  assert.match(err.text, /no interactive terminal/);
});

test('cli: a kill failure yields exit 1', async () => {
  const { deps } = makeDeps({
    kill: async (pid) => ({ pid, ok: false, error: 'permission denied' }),
    find: async () => [{ port: 3000, pid: 48213, name: 'node', cmd: '' }],
  });
  const code = await run(['3000', '--force'], deps);
  assert.equal(code, 1);
});

test('cli: scan failure prints error and exits 1', async () => {
  const { err, deps } = makeDeps({
    find: async () => { throw Object.assign(new Error('no port-scanning tool found'), { code: 'ENOTOOL' }); },
  });
  const code = await run(['3000'], deps);
  assert.equal(code, 1);
  assert.match(err.text, /no port-scanning tool found/);
});

test('cli: scan failure with --json emits success:false, exit 1', async () => {
  const { out, deps } = makeDeps({
    find: async () => { throw new Error('netstat not found'); },
  });
  const code = await run(['3000', '--json'], deps);
  assert.equal(code, 1);
  const parsed = JSON.parse(out.text);
  assert.equal(parsed.success, false);
});
