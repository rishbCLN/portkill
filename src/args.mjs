// Zero-dependency argument + port parsing. Kept pure so it is fully unit-testable.

export const MIN_PORT = 1;
export const MAX_PORT = 65535;
/** Guard against someone expanding a giant range (e.g. `1-65535`). */
export const MAX_RANGE = 1000;

export const HELP = `portkill — kill whatever's hogging a port, on any OS

Usage:
  portkill <port> [ports...] [options]

Options:
  -f, --force     Kill without the confirmation prompt
  -l, --list      List matching processes, don't kill anything
      --json      Output JSON (machine-readable)
  -h, --help      Show this help
  -v, --version   Show the version

Examples:
  portkill 3000              # find & kill the process on port 3000 (asks first)
  portkill 3000 8080 --force # kill several ports, no prompt
  portkill 3000 --list       # just show what's there
  portkill 3000-3010         # a whole range

Notes:
  * You are always asked to confirm before anything is killed (unless --force).
  * System-critical processes (PID 0/1, and Windows PID 4) are never touched.
`;

function isValidPort(n) {
  return Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT;
}

/**
 * Parse a single CLI token into a list of ports.
 * Accepts "3000" or a range "3000-3010".
 * @returns {{ ports: number[], error: string|null }}
 */
export function parsePortToken(token) {
  const range = /^(\d+)-(\d+)$/.exec(token);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (!isValidPort(start) || !isValidPort(end)) {
      return { ports: [], error: `invalid port range "${token}" (ports must be ${MIN_PORT}-${MAX_PORT})` };
    }
    if (start > end) {
      return { ports: [], error: `invalid port range "${token}" (start is greater than end)` };
    }
    if (end - start + 1 > MAX_RANGE) {
      return { ports: [], error: `port range "${token}" is too large (max ${MAX_RANGE} ports)` };
    }
    const ports = [];
    for (let p = start; p <= end; p++) ports.push(p);
    return { ports, error: null };
  }

  if (/^\d+$/.test(token)) {
    const p = Number(token);
    if (!isValidPort(p)) {
      return { ports: [], error: `invalid port "${token}" (must be ${MIN_PORT}-${MAX_PORT})` };
    }
    return { ports: [p], error: null };
  }

  return { ports: [], error: `not a port: "${token}"` };
}

/**
 * Parse the full argv (excluding node + script).
 * @returns {{ ports: number[], force: boolean, list: boolean, json: boolean,
 *             help: boolean, version: boolean, errors: string[] }}
 */
export function parseArgs(argv) {
  const result = {
    ports: [],
    force: false,
    list: false,
    json: false,
    help: false,
    version: false,
    errors: [],
  };
  const seen = new Set();

  for (const arg of argv) {
    switch (arg) {
      case '-h':
      case '--help':
        result.help = true;
        break;
      case '-v':
      case '--version':
        result.version = true;
        break;
      case '-f':
      case '--force':
        result.force = true;
        break;
      case '-l':
      case '--list':
        result.list = true;
        break;
      case '--json':
        result.json = true;
        break;
      default: {
        if (arg.length > 1 && arg.startsWith('-')) {
          result.errors.push(`unknown option: ${arg}`);
          break;
        }
        const { ports, error } = parsePortToken(arg);
        if (error) {
          result.errors.push(error);
        } else {
          for (const p of ports) {
            if (!seen.has(p)) {
              seen.add(p);
              result.ports.push(p);
            }
          }
        }
      }
    }
  }

  return result;
}
