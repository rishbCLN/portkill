// Finding which process holds a TCP port.
//
// The OS-specific text parsing is split into small PURE functions so they can be
// unit-tested against captured real-world output. The impure orchestration
// (findProcessesOnPort) takes an injectable `run` + `platform` for testability.
import { run as defaultRun } from './run.mjs';

/**
 * Parse `netstat -ano -p tcp` (Windows) output for PIDs LISTENING on `port`.
 * @returns {number[]} unique PIDs
 */
export function parseNetstat(stdout, port) {
  const pids = new Set();
  for (const raw of String(stdout).split(/\r?\n/)) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 5) continue;
    if (parts[0].toUpperCase() !== 'TCP') continue;
    if (!/LISTEN/i.test(parts[3])) continue; // only the listening socket holds the port
    const local = parts[1];
    const colon = local.lastIndexOf(':');
    if (colon === -1) continue;
    if (Number(local.slice(colon + 1)) !== port) continue;
    const pid = Number(parts[parts.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/**
 * Parse `lsof -t` output (one PID per line).
 * @returns {number[]} unique PIDs
 */
export function parseLsofPids(stdout) {
  const pids = new Set();
  for (const line of String(stdout).split(/\r?\n/)) {
    const n = Number(line.trim());
    if (Number.isInteger(n) && n > 0) pids.add(n);
  }
  return [...pids];
}

/**
 * Parse `fuser <port>/tcp` output. The port number precedes a colon; PIDs follow.
 * @returns {number[]} unique PIDs (excluding the port itself)
 */
export function parseFuser(text, port) {
  const pids = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const colon = line.indexOf(':');
    const tail = colon === -1 ? line : line.slice(colon + 1);
    for (const m of tail.matchAll(/\d+/g)) {
      const n = Number(m[0]);
      if (Number.isInteger(n) && n > 0 && n !== port) pids.add(n);
    }
  }
  return [...pids];
}

/**
 * Parse `ps -p <pid> -o comm=,args=` output into a name + full command line.
 * @returns {{ name: string, cmd: string }}
 */
export function parsePsOutput(stdout) {
  const line = String(stdout).trim();
  if (!line) return { name: '', cmd: '' };
  const sp = line.indexOf(' ');
  if (sp === -1) return { name: line, cmd: line };
  return { name: line.slice(0, sp), cmd: line.slice(sp + 1).trim() };
}

/**
 * Parse the first row of `tasklist /FO CSV /NH` for the image name.
 * @returns {string}
 */
export function parseTasklistName(stdout) {
  const first = String(stdout).trim().split(/\r?\n/)[0] || '';
  const m = first.match(/^"([^"]*)"/);
  return m ? m[1] : '';
}

/**
 * Find all processes listening on a TCP port.
 * @param {number} port
 * @param {{ platform?: NodeJS.Platform, run?: typeof defaultRun }} [opts]
 * @returns {Promise<Array<{ pid: number, name: string, cmd: string }>>}
 */
export async function findProcessesOnPort(port, opts = {}) {
  const platform = opts.platform || process.platform;
  const run = opts.run || defaultRun;

  if (platform === 'win32') {
    const { stdout } = await run('netstat', ['-ano', '-p', 'tcp']);
    const pids = parseNetstat(stdout, port);
    const out = [];
    for (const pid of pids) {
      const { stdout: tl } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
      out.push({ pid, name: parseTasklistName(tl) || 'unknown', cmd: '' });
    }
    return out;
  }

  // POSIX (macOS / Linux): prefer lsof, fall back to fuser if it isn't installed.
  const res = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  let pids = parseLsofPids(res.stdout);
  if (pids.length === 0 && res.error && res.error.code === 'ENOENT') {
    const f = await run('fuser', [`${port}/tcp`]);
    pids = parseFuser(`${f.stdout}\n${f.stderr}`, port);
  }

  const out = [];
  for (const pid of pids) {
    const ps = await run('ps', ['-p', String(pid), '-o', 'comm=,args=']);
    const { name, cmd } = parsePsOutput(ps.stdout);
    out.push({ pid, name: name || 'unknown', cmd });
  }
  return out;
}
