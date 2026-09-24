#!/usr/bin/env node
// portkill — find and kill whatever process is hogging a TCP port, on any OS.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseArgs, HELP } from '../src/args.mjs';
import { findProcessesOnPort } from '../src/find.mjs';
import { killProcess, isProtectedPid } from '../src/kill.mjs';
import { makeStyler, colorEnabled, confirm, formatTable } from '../src/ui.mjs';

function getVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  const c = makeStyler(colorEnabled());

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`portkill ${getVersion()}\n`);
    return 0;
  }
  if (opts.errors.length) {
    for (const e of opts.errors) process.stderr.write(`${c.red('error:')} ${e}\n`);
    process.stderr.write(`\nRun ${c.cyan('portkill --help')} for usage.\n`);
    return 2;
  }
  if (opts.ports.length === 0) {
    process.stderr.write(`${c.red('error:')} specify at least one port\n`);
    process.stderr.write(`\nRun ${c.cyan('portkill --help')} for usage.\n`);
    return 2;
  }

  // 1. Discover everything listening on the requested ports.
  const found = [];
  for (const port of opts.ports) {
    let procs;
    try {
      procs = await findProcessesOnPort(port);
    } catch (err) {
      process.stderr.write(`${c.red('error:')} scanning port ${port}: ${err.message || err}\n`);
      continue;
    }
    if (procs.length === 0) {
      if (!opts.json) {
        process.stdout.write(`${c.dim('\u00b7')} port ${c.bold(String(port))} is free \u2014 nothing is listening\n`);
      }
      continue;
    }
    for (const p of procs) found.push({ port, pid: p.pid, name: p.name, cmd: p.cmd });
  }

  const isProtected = (p) => isProtectedPid(p.pid) || p.pid === process.pid;

  // 2. --list never kills.
  if (opts.list) {
    if (opts.json) process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
    else if (found.length) process.stdout.write(`${formatTable(found, c)}\n`);
    return 0;
  }

  if (found.length === 0) {
    if (opts.json) process.stdout.write('[]\n');
    return 0;
  }

  const killable = found.filter((p) => !isProtected(p));
  const skipped = found.filter(isProtected);

  // 3. JSON without --force is a read-only listing (no destructive prompt in machine mode).
  if (opts.json && !opts.force) {
    process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
    return 0;
  }

  // 4. Human, interactive path: show, warn about protected, confirm.
  if (!opts.json) {
    process.stdout.write(`${formatTable(found, c)}\n`);
    for (const p of skipped) {
      process.stdout.write(`${c.yellow(`  \u26a0 skipping PID ${p.pid} (${p.name}) \u2014 protected process`)}\n`);
    }
    if (killable.length === 0) {
      process.stdout.write(`${c.yellow('nothing to kill \u2014 all matches are protected.')}\n`);
      return 0;
    }
    if (!opts.force) {
      if (!process.stdin.isTTY) {
        process.stderr.write(`${c.red('error:')} refusing to kill without confirmation (no interactive terminal).\n`);
        process.stderr.write(`Re-run with ${c.cyan('--force')} to skip the prompt.\n`);
        return 2;
      }
      const noun = killable.length === 1 ? 'process' : 'processes';
      const ok = await confirm(`Kill ${c.bold(String(killable.length))} ${noun}?`);
      if (!ok) {
        process.stdout.write('aborted.\n');
        return 0;
      }
    }
  }

  // 5. Kill.
  const results = [];
  let failures = 0;
  for (const t of killable) {
    const r = await killProcess(t.pid);
    results.push({ ...t, killed: r.ok, error: r.error || null });
    if (!r.ok) failures += 1;
    if (!opts.json) {
      if (r.ok) {
        process.stdout.write(`${c.green(`  \u2713 killed PID ${t.pid} (${t.name})`)} \u2014 port ${t.port} freed\n`);
      } else {
        process.stderr.write(`${c.red(`  \u2717 PID ${t.pid} (${t.name}):`)} ${r.error}\n`);
      }
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ killed: results, skipped }, null, 2)}\n`);
  }

  return failures > 0 ? 1 : 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`unexpected error: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
