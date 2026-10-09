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
    // Only the LISTENING socket holds the port. Detect it via the *foreign*
    // address being the wildcard ":0" (e.g. 0.0.0.0:0 or [::]:0), which is the
    // sole TCP state with a zero foreign port. This is locale-independent:
    // netstat translates the "LISTENING" text on non-English Windows (e.g.
    // "ABHÖREN", "À L'ÉCOUTE", "ESCUCHAR"), and a translated — possibly
    // multi-word — state would otherwise be missed. The English /LISTEN/i
    // check is kept as a fast path / belt-and-suspenders.
    const foreign = parts[2];
    const fColon = foreign.lastIndexOf(':');
    const foreignIsWildcard = fColon !== -1 && foreign.slice(fColon + 1) === '0';
    if (!foreignIsWildcard && !/LISTEN/i.test(parts[3])) continue;
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
 * Parse `ss -lptnH 'sport = :<port>'` output. ss embeds the owning pid in a
 * `users:(("name",pid=1234,fd=20))` field; we extract every `pid=<n>`.
 * This is the only listener probe available on minimal Linux images
 * (Alpine/Debian containers) that ship neither lsof nor fuser.
 * @returns {number[]} unique PIDs
 */
export function parseSs(stdout) {
  const pids = new Set();
  for (const m of String(stdout).matchAll(/pid=(\d+)/g)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) pids.add(n);
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
 * Resolve a Windows image name for a PID via tasklist.
 */
async function tasklistName(pid, run) {
  const { stdout: tl } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  return parseTasklistName(tl) || 'unknown';
}

/**
 * Discover listener PIDs on a single POSIX port, trying lsof, then fuser, then
 * ss. Each fallback only fires when the previous probe is not installed
 * (ENOENT), so minimal containers that ship only `ss` still work.
 * @returns {Promise<number[]>}
 */
async function posixPidsOnPort(port, run) {
  const res = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  let pids = parseLsofPids(res.stdout);
  if (pids.length === 0 && res.error && res.error.code === 'ENOENT') {
    const f = await run('fuser', [`${port}/tcp`]);
    pids = parseFuser(`${f.stdout}\n${f.stderr}`, port);
    if (pids.length === 0 && f.error && f.error.code === 'ENOENT') {
      // Minimal Linux (Alpine/Debian): only iproute2's `ss` is present.
      const s = await run('ss', ['-lptnH', `sport = :${port}`]);
      pids = parseSs(`${s.stdout}\n${s.stderr}`);
    }
  }
  return pids;
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
    // NOTE: `-p tcp` restricts netstat to IPv4 only, silently dropping every
    // IPv6 listener (rows like `[::]:3000`). Since many servers (Node's default
    // dual-stack listen, Vite, etc.) bind on `::`, that would make portkill
    // report the port as free. Plain `netstat -ano` still labels IPv6 rows as
    // proto "TCP", so parseNetstat handles both families; we just must not
    // filter the family away here.
    const { stdout } = await run('netstat', ['-ano']);
    const pids = parseNetstat(stdout, port);
    const out = [];
    for (const pid of pids) {
      out.push({ pid, name: await tasklistName(pid, run), cmd: '' });
    }
    return out;
  }

  // POSIX (macOS / Linux): prefer lsof, fall back to fuser, then ss.
  const pids = await posixPidsOnPort(port, run);
  const out = [];
  for (const pid of pids) {
    const ps = await run('ps', ['-p', String(pid), '-o', 'comm=,args=']);
    const { name, cmd } = parsePsOutput(ps.stdout);
    out.push({ pid, name: name || 'unknown', cmd });
  }
  return out;
}

/**
 * Find all processes listening on ANY of the requested TCP ports.
 *
 * On Windows this runs a single `netstat -ano` snapshot and matches every port
 * against it, instead of spawning one netstat per port (scanning a range like
 * 3000-3050 previously spawned 51 processes). tasklist is still queried once
 * per distinct PID. The POSIX path probes per port (lsof/fuser/ss filter by
 * port) but reuses one code path.
 *
 * @param {number[]} ports
 * @param {{ platform?: NodeJS.Platform, run?: typeof defaultRun }} [opts]
 * @returns {Promise<Array<{ port: number, pid: number, name: string, cmd: string }>>}
 */
export async function findProcessesOnPorts(ports, opts = {}) {
  const platform = opts.platform || process.platform;
  const run = opts.run || defaultRun;
  const portList = [...new Set(ports)];
  const out = [];

  if (platform === 'win32') {
    const { stdout } = await run('netstat', ['-ano']);
    const names = new Map(); // pid -> name (one tasklist call per PID)
    for (const port of portList) {
      for (const pid of parseNetstat(stdout, port)) {
        if (!names.has(pid)) names.set(pid, await tasklistName(pid, run));
        out.push({ port, pid, name: names.get(pid), cmd: '' });
      }
    }
    return out;
  }

  for (const port of portList) {
    const procs = await findProcessesOnPort(port, { platform, run });
    for (const p of procs) out.push({ port, pid: p.pid, name: p.name, cmd: p.cmd });
  }
  return out;
}
