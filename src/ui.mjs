// Terminal presentation: manual ANSI colors (no dependency), a yes/no prompt,
// and a small aligned table. Colors auto-disable for non-TTY / NO_COLOR.
import { createInterface } from 'node:readline/promises';

/** Build a set of style functions. When `enabled` is false they are no-ops. */
export function makeStyler(enabled) {
  const wrap = (open, close) => (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
  return {
    enabled,
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    dim: wrap(2, 22),
    bold: wrap(1, 22),
  };
}

/** Decide whether to emit colors. Honors NO_COLOR and FORCE_COLOR conventions. */
export function colorEnabled(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR != null) return false;
  if (env.FORCE_COLOR != null) return true;
  return Boolean(stream && stream.isTTY);
}

/** Ask a yes/no question. Defaults to "no". */
export async function confirm(question, opts = {}) {
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function truncate(s, n) {
  const clean = String(s).replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}\u2026` : clean;
}

/**
 * Render an aligned table of matches.
 * @param {Array<{ port: number, pid: number, name: string, cmd: string }>} rows
 * @param {ReturnType<typeof makeStyler>} c
 */
export function formatTable(rows, c) {
  if (!rows || rows.length === 0) return '';
  const header = ['PORT', 'PID', 'PROCESS', 'COMMAND'];
  const data = rows.map((r) => [
    String(r.port),
    String(r.pid),
    r.name || 'unknown',
    truncate(r.cmd || '', 60),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const renderRow = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();

  const lines = [c.bold(renderRow(header))];
  for (const d of data) lines.push(renderRow(d));
  return lines.join('\n');
}
