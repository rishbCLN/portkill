// Orchestration for the portkill CLI, extracted from bin/portkill.mjs so it can
// be unit-tested. All side effects (process scanning, killing, prompting, and
// the I/O streams / process identity) are injectable via `deps`, defaulting to
// the real implementations.
import { HELP, parseArgs } from './args.mjs';
import { findProcessesOnPorts } from './find.mjs';
import { killProcess, isProtectedPid } from './kill.mjs';
import { makeStyler, colorEnabled, confirm as realConfirm, formatTable } from './ui.mjs';

/**
 * Run the portkill CLI.
 * @param {string[]} argv - argv without node + script.
 * @param {object} [deps] - injectable dependencies (all default to real impls).
 * @returns {Promise<number>} the process exit code.
 */
export async function run(argv, deps = {}) {
  const {
    find = findProcessesOnPorts,
    kill = killProcess,
    isProtected: isProtectedFn = isProtectedPid,
    confirm = realConfirm,
    out = process.stdout,
    err = process.stderr,
    stdin = process.stdin,
    env = process.env,
    pid = process.pid,
    ppid = process.ppid,
    version = '0.0.0',
  } = deps;

  const opts = parseArgs(argv);
  const c = makeStyler(colorEnabled(env, out));

  if (opts.help) {
    out.write(HELP);
    return 0;
  }
  if (opts.version) {
    out.write(`portkill ${version}\n`);
    return 0;
  }
  if (opts.errors.length) {
    for (const e of opts.errors) err.write(`${c.red('error:')} ${e}\n`);
    err.write(`\nRun ${c.cyan('portkill --help')} for usage.\n`);
    return 2;
  }
  if (opts.ports.length === 0) {
    err.write(`${c.red('error:')} specify at least one port\n`);
    err.write(`\nRun ${c.cyan('portkill --help')} for usage.\n`);
    return 2;
  }

  const buildJson = (success, found, killed, skipped) =>
    JSON.stringify({ success, ports: opts.ports, found, killed, skipped }, null, 2);

  // 1. Discover everything listening on the requested ports. A single batched
  //    scan is used so a range (e.g. 3000-3050) does not spawn one netstat per
  //    port. A hard scan failure (e.g. no scanning tool installed) is an error,
  //    not an empty result: exit non-zero instead of reporting the ports free.
  let found;
  try {
    found = await find(opts.ports);
  } catch (scanErr) {
    err.write(`${c.red('error:')} scanning ports: ${scanErr.message || scanErr}\n`);
    if (opts.json) out.write(`${buildJson(false, [], [], [])}\n`);
    return 1;
  }

  const busyPorts = new Set(found.map((p) => p.port));
  if (!opts.json) {
    for (const port of opts.ports) {
      if (!busyPorts.has(port)) {
        out.write(`${c.dim('\u00b7')} port ${c.bold(String(port))} is free \u2014 nothing is listening\n`);
      }
    }
  }

  // Protect system-critical PIDs, portkill itself, and the parent shell: if the
  // terminal that launched portkill owns the listening port, killing it would
  // make the user's shell window vanish mid-command.
  const isProtected = (p) => isProtectedFn(p.pid) || p.pid === pid || p.pid === ppid;
  const skipped = found.filter(isProtected);

  // 2. --list never kills.
  if (opts.list) {
    if (opts.json) out.write(`${buildJson(true, found, [], skipped)}\n`);
    else if (found.length) out.write(`${formatTable(found, c)}\n`);
    return 0;
  }

  if (found.length === 0) {
    if (opts.json) out.write(`${buildJson(true, [], [], [])}\n`);
    return 0;
  }

  // Deduplicate kill targets by PID: one process can listen on several of the
  // requested ports, which would otherwise make us run taskkill/kill against
  // the same (now-dead) PID multiple times and count false failures.
  const seenPid = new Set();
  const killable = found
    .filter((p) => !isProtected(p))
    .filter((p) => {
      if (seenPid.has(p.pid)) return false;
      seenPid.add(p.pid);
      return true;
    });

  // 3. JSON without --force is a read-only listing (no destructive prompt in machine mode).
  if (opts.json && !opts.force) {
    out.write(`${buildJson(true, found, [], skipped)}\n`);
    return 0;
  }

  // 4. Human, interactive path: show, warn about protected, confirm.
  if (!opts.json) {
    out.write(`${formatTable(found, c)}\n`);
    for (const p of skipped) {
      out.write(`${c.yellow(`  \u26a0 skipping PID ${p.pid} (${p.name}) \u2014 protected process`)}\n`);
    }
    if (killable.length === 0) {
      out.write(`${c.yellow('nothing to kill \u2014 all matches are protected.')}\n`);
      return 0;
    }
    if (!opts.force) {
      if (!stdin.isTTY) {
        err.write(`${c.red('error:')} refusing to kill without confirmation (no interactive terminal).\n`);
        err.write(`Re-run with ${c.cyan('--force')} to skip the prompt.\n`);
        return 2;
      }
      const noun = killable.length === 1 ? 'process' : 'processes';
      const ok = await confirm(`Kill ${c.bold(String(killable.length))} ${noun}?`);
      if (!ok) {
        out.write('aborted.\n');
        return 0;
      }
    }
  }

  // 5. Kill.
  const results = [];
  let failures = 0;
  for (const t of killable) {
    const r = await kill(t.pid);
    results.push({ ...t, killed: r.ok, error: r.error || null });
    if (!r.ok) failures += 1;
    if (!opts.json) {
      if (r.ok) {
        out.write(`${c.green(`  \u2713 killed PID ${t.pid} (${t.name})`)} \u2014 port ${t.port} freed\n`);
      } else {
        err.write(`${c.red(`  \u2717 PID ${t.pid} (${t.name}):`)} ${r.error}\n`);
      }
    }
  }

  if (opts.json) {
    out.write(`${buildJson(failures === 0, found, results, skipped)}\n`);
  }

  return failures > 0 ? 1 : 0;
}
