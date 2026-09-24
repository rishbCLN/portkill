# Contributing to portkill

Thanks for helping! portkill is a small, **zero-dependency** Node CLI, and the goal is
to keep it that way: fast, obvious, and cross-platform.

## Principles

- **No runtime dependencies.** Everything uses Node built-ins (`child_process`,
  `readline`, etc.). PRs that add a dependency will be asked to remove it.
- **Parsing is pure.** OS command output is parsed by small pure functions
  (`parseNetstat`, `parseLsofPids`, `parsePsOutput`, …). Side effects (spawning,
  signalling) are injectable so everything is testable without real processes.
- **Safe by default.** Anything that kills must be gated behind confirmation or
  `--force`, and must never target protected PIDs.

## Getting started

```bash
git clone https://github.com/rishbCLN/portkill.git
cd portkill
node --test                 # run the suite
node bin/portkill.mjs 3000  # try it
```

There's nothing to install — no `npm install` step.

## Adding support or fixing parsing

If you're fixing how a platform is detected or parsed:

1. Capture the **real** command output on that OS.
2. Add it as a fixture string in `test/find.test.mjs` and assert the expected PIDs.
3. Make the pure parser pass. Keep the spawning code (`findProcessesOnPort`) thin.

## Before you open a PR

- Run `node --test` — CI runs the same on Windows, macOS, and Linux across Node 18/20/22.
- Keep the change focused and update the README if you touch the CLI surface.
- If your change affects the kill path, describe how you verified it (e.g., started a
  local server on a port and killed it).

## Ideas / good first issues

- `--dry-run` alias for `--list`.
- Show the user/owner of each process.
- UDP support behind a flag.
- A short demo GIF for the README.
