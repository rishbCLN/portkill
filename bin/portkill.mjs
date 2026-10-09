#!/usr/bin/env node
// portkill — find and kill whatever process is hogging a TCP port, on any OS.
// Thin shim: resolve the version and hand off to src/cli.mjs (kept separate so
// the orchestration is unit-testable with injected dependencies).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { run } from '../src/cli.mjs';

function getVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

run(process.argv.slice(2), { version: getVersion() })
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`unexpected error: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
