// Finding which process holds a TCP port.
//
// The OS-specific text parsing is split into small PURE functions so they can be
// unit-tested against captured real-world output. The impure orchestration
// (findProcessesOnPort) takes an injectable `run` + `platform` for testability.
import { run as defaultRun } from './run.mjs';
import { TIMEOUT_MS } from './run.mjs';

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
 * Parse `lsof -nP -iTCP -sTCP:LISTEN -FpnP` field output into (pid, port) pairs.
 *
 * lsof "-F" mode prints one field per line, prefixed by a type character, and
 * groups fields under the most recent process ("p<pid>") and file ("n<name>")
 * records, e.g.:
 *   p48213
 *   n*:3000
 *   p777
 *   n127.0.0.1:8080
 * The current pid applies to every subsequent `n` line until the next `p` line.
 * Only the trailing `:<port>` of the name is used, so IPv4, IPv6 (`[::]:3000`),
 * and wildcard (`*:3000`) listeners are all handled. Deduped per (pid, port).
 *
 * @returns {Array<{ pid: number, port: number }>}
 */
export function parseLsofFull(stdout) {
  const out = [];
  const seen = new Set();
  let pid = null;
  for (const raw of String(stdout).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const type = line[0];
    const value = line.slice(1);
    if (type === 'p') {
      const n = Number(value);
      pid = Number.isInteger(n) && n > 0 ? n : null;
    } else if (type === 'n' && pid != null) {
      const colon = value.lastIndexOf(':');
      if (colon === -1) continue;
      const port = Number(value.slice(colon + 1));
      if (!Number.isInteger(port) || port <= 0) continue;
      const key = `${pid}:${port}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ pid, port });
      }
    }
  }
  return out;
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
  const { stdout: tl } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: TIMEOUT_MS });
  return parseTasklistName(tl) || 'unknown';
}

/** True when a `run` result indicates the binary isn't installed. */
function isMissing(res) {
  return Boolean(res && res.error && res.error.code === 'ENOENT');
}

/**
 * Resolve ps details (name + command line) for a list of PIDs, once each.
 * @returns {Promise<Map<number, { name: string, cmd: string }>>}
 */
async function psDetails(pids, run) {
  const details = new Map();
  for (const pid of pids) {
    if (details.has(pid)) continue;
    const ps = await run('ps', ['-p', String(pid), '-o', 'comm=,args='], { timeout: TIMEOUT_MS });
    const { name, cmd } = parsePsOutput(ps.stdout);
    details.set(pid, { name: name || 'unknown', cmd });
  }
  return details;
}

/**
 * Discover listener PIDs on a single POSIX port, trying lsof, then fuser, then
 * ss. Each fallback only fires when the previous probe is not installed
 * (ENOENT), so minimal containers that ship only `ss` still work. When none of
 * the three is installed, throws an ENOTOOL error rather than silently
 * reporting the port as free.
 * @returns {Promise<number[]>}
 */
async function posixPidsOnPort(port, run) {
  const res = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: TIMEOUT_MS });
  let pids = parseLsofPids(res.stdout);
  if (pids.length === 0 && isMissing(res)) {
    const f = await run('fuser', [`${port}/tcp`], { timeout: TIMEOUT_MS });
    pids = parseFuser(`${f.stdout}\n${f.stderr}`, port);
    if (pids.length === 0 && isMissing(f)) {
      // Minimal Linux (Alpine/Debian): only iproute2's `ss` is present.
      const s = await run('ss', ['-lptnH', `sport = :${port}`], { timeout: TIMEOUT_MS });
      pids = parseSs(`${s.stdout}\n${s.stderr}`);
      if (pids.length === 0 && isMissing(s)) {
        throw Object.assign(
          new Error('no port-scanning tool found (install lsof, fuser, or ss)'),
          { code: 'ENOTOOL' },
        );
      }
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
    const res = await run('netstat', ['-ano'], { timeout: TIMEOUT_MS });
    if (isMissing(res)) {
      throw Object.assign(new Error('netstat not found'), { code: 'ENOTOOL' });
    }
    const pids = parseNetstat(res.stdout, port);
    const out = [];
    for (const pid of pids) {
      out.push({ pid, name: await tasklistName(pid, run), cmd: '' });
    }
    return out;
  }

  // POSIX (macOS / Linux): prefer lsof, fall back to fuser, then ss.
  const pids = await posixPidsOnPort(port, run);
  const details = await psDetails(pids, run);
  return pids.map((pid) => ({ pid, ...details.get(pid) }));
}

/**
 * Find all processes listening on ANY of the requested TCP ports.
 *
 * On Windows this runs a single `netstat -ano` snapshot and matches every port
 * against it, instead of spawning one netstat per port (scanning a range like
 * 3000-3050 previously spawned 51 processes). tasklist is still queried once
 * per distinct PID.
 *
 * On POSIX it first tries ONE batched `lsof ... -FpnP` snapshot of all TCP
 * listeners and filters it to the requested ports — so a range is a single
 * lsof call there too. If lsof isn't installed it falls back to the per-port
 * fuser/ss probes (which can only query one port at a time).
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
    const res = await run('netstat', ['-ano'], { timeout: TIMEOUT_MS });
    if (isMissing(res)) {
      throw Object.assign(new Error('netstat not found'), { code: 'ENOTOOL' });
    }
    const names = new Map(); // pid -> name (one tasklist call per PID)
    for (const port of portList) {
      for (const pid of parseNetstat(res.stdout, port)) {
        if (!names.has(pid)) names.set(pid, await tasklistName(pid, run));
        out.push({ port, pid, name: names.get(pid), cmd: '' });
      }
    }
    return out;
  }

  // POSIX: one batched lsof snapshot of every TCP listener, then filter.
  const wanted = new Set(portList);
  const lsof = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-FpnP'], { timeout: TIMEOUT_MS });
  if (!isMissing(lsof)) {
    const pairs = parseLsofFull(lsof.stdout).filter((pp) => wanted.has(pp.port));
    const details = await psDetails([...new Set(pairs.map((pp) => pp.pid))], run);
    for (const pp of pairs) {
      out.push({ port: pp.port, pid: pp.pid, ...details.get(pp.pid) });
    }
    return out;
  }

  // lsof missing: fall back to the per-port probes (fuser/ss).
  for (const port of portList) {
    const procs = await findProcessesOnPort(port, { platform, run });
    for (const p of procs) out.push({ port, pid: p.pid, name: p.name, cmd: p.cmd });
  }
  return out;
}
