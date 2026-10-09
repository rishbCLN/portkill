# portkill

[![CI](https://github.com/rishbCLN/portkill/actions/workflows/ci.yml/badge.svg)](https://github.com/rishbCLN/portkill/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/portkill.svg)](https://www.npmjs.com/package/portkill)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Kill whatever's hogging a port — on any OS, in one command.**

You know the error:

```
Error: listen EADDRINUSE: address already in use :::3000
```

The "fix" is a different incantation on every machine — `lsof -i :3000` here,
`netstat -ano | findstr :3000` then `taskkill /PID …` there. portkill replaces all
of that with one command that works the same on Windows, macOS, and Linux:

```bash
npx portkill 3000
```

```
PORT  PID    PROCESS   COMMAND
3000  48213  node      node server.js
Kill 1 process? [y/N] y
  ✓ killed PID 48213 (node) — port 3000 freed
```

No dependencies. No config. No account. Just Node 18+.

<!-- Add a short demo GIF here once recorded: ![demo](docs/demo.gif) -->

## Quick start

```bash
# one-off, no install
npx portkill 3000

# or install globally
npm install -g portkill
portkill 3000
```

## Usage

```
portkill <port> [ports...] [options]
```

| Option | Description |
| --- | --- |
| `-f, --force` | Kill without the confirmation prompt |
| `-l, --list` | List matching processes, don't kill anything |
| `--json` | Output JSON (machine-readable) |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

```bash
portkill 3000                # find & kill the process on port 3000 (asks first)
portkill 3000 8080 --force   # several ports at once, no prompt
portkill 3000 --list         # just show what's there
portkill 3000-3010           # a whole range
curl ... ; portkill 5432 -l  # peek at what's on the DB port
```

Exit codes: `0` success (or nothing to kill), `1` one or more kills failed (or a
port scan failed, e.g. no scanning tool installed), `2` bad usage.

### JSON output

`--json` prints a single object (never partial/streamed):

```json
{
  "success": true,
  "ports": [3000],
  "found":   [{ "port": 3000, "pid": 48213, "name": "node", "cmd": "node app.js" }],
  "killed":  [{ "port": 3000, "pid": 48213, "name": "node", "cmd": "node app.js", "killed": true, "error": null }],
  "skipped": [{ "port": 3000, "pid": 1, "name": "init", "cmd": "" }]
}
```

| Field | Meaning |
| --- | --- |
| `success` | `true` unless a kill failed or the scan errored |
| `ports` | the ports you requested |
| `found` | every listener discovered across those ports |
| `killed` | per-process kill results — **empty** for `--list`, and for `--json` without `--force` (read-only) |
| `skipped` | protected processes that were not killed |

Note: the `cmd` field is empty on Windows — `tasklist` exposes the process image
name only, not its full command line.

## Safety

portkill is destructive by nature, so it's cautious by default:

- **Confirms before killing.** You always see the PID, process name, and command
  first, and are asked to confirm — unless you pass `--force`.
- **Never touches system-critical processes.** PID 0 and 1 (and Windows PID 4) are
  always skipped, as is portkill's own process.
- **`--list` never kills.** Use it to look before you leap.
- **Non-interactive safety.** In a pipe/CI (no TTY), portkill refuses to kill without
  `--force` instead of guessing.

## How it works

No magic — portkill just runs the tools your OS already ships and parses the output:

| OS | Find | Kill |
| --- | --- | --- |
| Windows | `netstat -ano` (both IPv4 and IPv6 listeners) + `tasklist` | `taskkill /PID <pid> /F /T` |
| macOS / Linux | `lsof -nP -iTCP -sTCP:LISTEN` (falls back to `fuser`, then `ss`) + `ps` | `SIGTERM`, then `SIGKILL` if it won't exit |

On Windows, portkill runs `netstat -ano` *without* a `-p tcp` family filter so
that IPv6-only listeners (e.g. Node's default dual-stack `::` bind, Vite) are
not silently missed. On POSIX it prefers `lsof` (a single batched scan covers a
whole range), falling back to `fuser` and then iproute2's `ss` on minimal images
that don't ship `lsof`. It asks the process to stop first (`SIGTERM`) and only
escalates to `SIGKILL` if it's still alive after a moment.

## Development

```bash
node --test          # run the test suite (Node built-in, zero deps)
node bin/portkill.mjs --help
```

The OS-specific text parsing lives in small pure functions (`src/find.mjs`,
`src/args.mjs`, `src/kill.mjs`) that are unit-tested against captured real output,
so contributions are easy to verify. The CLI orchestration (`src/cli.mjs`) takes
injectable dependencies, so it is tested end-to-end without touching real
processes.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues:
port ranges UX, extra `ps`/`tasklist` fields, and a `--dry-run` alias.

## License

MIT. See [LICENSE](LICENSE).
