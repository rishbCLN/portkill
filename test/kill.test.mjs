import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProtectedPid, killProcess } from '../src/kill.mjs';

const noWait = async () => {};
const esrch = () => Object.assign(new Error('no such process'), { code: 'ESRCH' });
const eperm = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });

test('isProtectedPid: PID 0 and 1 are always protected', () => {
  assert.equal(isProtectedPid(0, 'linux'), true);
  assert.equal(isProtectedPid(1, 'linux'), true);
});

test('isProtectedPid: Windows PID 4 protected, but not on linux', () => {
  assert.equal(isProtectedPid(4, 'win32'), true);
  assert.equal(isProtectedPid(4, 'linux'), false);
});

test('isProtectedPid: a normal PID is not protected', () => {
  assert.equal(isProtectedPid(48213, 'linux'), false);
});

test('isProtectedPid: rejects non-integers and negatives', () => {
  assert.equal(isProtectedPid(NaN, 'linux'), true);
  assert.equal(isProtectedPid(-5, 'linux'), true);
});

test('killProcess posix: SIGTERM alone succeeds when the process exits', async () => {
  const sent = [];
  let alive = true;
  const signal = (pid, sig) => {
    sent.push(sig);
    if (sig === 'SIGTERM') { alive = false; return; }
    if (sig === 0 && !alive) throw esrch();
  };
  const r = await killProcess(1234, { platform: 'linux', signal, wait: noWait });
  assert.deepEqual(r, { pid: 1234, ok: true });
  assert.ok(sent.includes('SIGTERM'));
  assert.ok(!sent.includes('SIGKILL'));
});

test('killProcess posix: escalates to SIGKILL when SIGTERM is ignored', async () => {
  const sent = [];
  let alive = true;
  const signal = (pid, sig) => {
    sent.push(sig);
    if (sig === 'SIGKILL') { alive = false; return; }
    if (sig === 0) { if (alive) return; throw esrch(); }
    // SIGTERM: ignored, process stays alive
  };
  const r = await killProcess(1234, { platform: 'linux', signal, wait: noWait });
  assert.equal(r.ok, true);
  assert.ok(sent.includes('SIGKILL'));
});

test('killProcess posix: EPERM is reported as permission denied', async () => {
  const signal = () => { throw eperm(); };
  const r = await killProcess(1234, { platform: 'linux', signal, wait: noWait });
  assert.equal(r.ok, false);
  assert.match(r.error, /permission/i);
});

test('killProcess posix: ESRCH means the process is already gone (ok)', async () => {
  const signal = () => { throw esrch(); };
  const r = await killProcess(1234, { platform: 'linux', signal, wait: noWait });
  assert.deepEqual(r, { pid: 1234, ok: true });
});

test('killProcess win32: taskkill success', async () => {
  const run = async (cmd, args) => {
    assert.equal(cmd, 'taskkill');
    assert.deepEqual(args, ['/PID', '1234', '/F', '/T']);
    return { code: 0, stdout: 'SUCCESS', stderr: '' };
  };
  const r = await killProcess(1234, { platform: 'win32', run });
  assert.deepEqual(r, { pid: 1234, ok: true });
});

test('killProcess win32: taskkill failure surfaces stderr', async () => {
  const run = async () => ({ code: 1, stdout: '', stderr: 'ERROR: Access is denied.' });
  const r = await killProcess(1234, { platform: 'win32', run });
  assert.equal(r.ok, false);
  assert.match(r.error, /access is denied/i);
});
