// Killing a process safely, with a SIGTERM -> SIGKILL escalation on POSIX and
// taskkill on Windows. Side effects (signals / spawning) are injectable so the
// escalation logic can be unit-tested without touching real processes.
import { run as defaultRun } from './run.mjs';

/**
 * Never let the tool kill a system-critical process.
 * PID 0 (scheduler/idle) and PID 1 (init/launchd) on POSIX; PID 4 (System) on Windows.
 */
export function isProtectedPid(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 1) return true;
  if (platform === 'win32' && pid === 4) return true;
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is the process still alive? Uses signal 0 (no-op probe). */
function isAlive(pid, signal) {
  try {
    signal(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it; ESRCH means it's gone.
    return Boolean(err && err.code === 'EPERM');
  }
}

/**
 * Kill a process by PID.
 * @param {number} pid
 * @param {{
 *   platform?: NodeJS.Platform,
 *   run?: typeof defaultRun,
 *   signal?: (pid: number, sig: number|string) => void,
 *   wait?: (ms: number) => Promise<void>,
 *   termDelay?: number,
 * }} [opts]
 * @returns {Promise<{ pid: number, ok: boolean, error?: string }>}
 */
export async function killProcess(pid, opts = {}) {
  const platform = opts.platform || process.platform;
  const run = opts.run || defaultRun;
  const signal = opts.signal || ((p, s) => process.kill(p, s));
  const wait = opts.wait || sleep;
  const termDelay = opts.termDelay ?? 1500;

  if (platform === 'win32') {
    // /T also terminates child processes; /F forces it.
    const { code, stderr, error } = await run('taskkill', ['/PID', String(pid), '/F', '/T']);
    if (code === 0) return { pid, ok: true };
    const msg = (stderr || (error && error.message) || `taskkill exited with code ${code}`).trim();
    return { pid, ok: false, error: msg };
  }

  // POSIX: ask nicely first.
  try {
    signal(pid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') return { pid, ok: true }; // already gone
    if (err.code === 'EPERM') return { pid, ok: false, error: 'permission denied (try running with sudo)' };
    return { pid, ok: false, error: err.message || String(err) };
  }

  await wait(termDelay);
  if (!isAlive(pid, signal)) return { pid, ok: true };

  // Still there — escalate.
  try {
    signal(pid, 'SIGKILL');
  } catch (err) {
    if (err.code === 'ESRCH') return { pid, ok: true };
    if (err.code === 'EPERM') return { pid, ok: false, error: 'permission denied (try running with sudo)' };
    return { pid, ok: false, error: err.message || String(err) };
  }

  await wait(200);
  if (!isAlive(pid, signal)) return { pid, ok: true };
  return { pid, ok: false, error: 'process is still running after SIGKILL' };
}
