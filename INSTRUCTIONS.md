# portkill — build instructions

> Self-contained build spec. A fresh session should be able to build, test, and ship this tool by following this file top to bottom. Do not add runtime dependencies.

| Field | Value |
| --- | --- |
| Product name | **portkill** |
| Tagline | *Find and kill whatever's hogging a port — on any OS, in one command.* |
| Folder id | `star-tool1-portkill` |
| Intended repo / npm name | `portkill` (verify availability; fallbacks: `portkill-cli`, `whatsonport`) |
| Status | Planned |
| License | MIT |

---

## 1. Problem & audience
Every developer hits `EADDRINUSE: address already in use :::3000`. The current "fix" is a cross-platform ritual nobody remembers: `lsof -i :3000` on mac/linux, `netstat -ano | findstr :3000` then `taskkill /PID` on Windows. It's different on every OS and easy to get wrong.

**Audience:** every backend/frontend/full-stack dev, especially people who switch OSes or onboard onto new machines.

## 2. Why it earns stars
- Solves a **universal, daily** annoyance with a single memorable command.
- **Zero install friction:** `npx portkill 3000` just works.
- Cross-platform parity is the hook — one command replaces three OS-specific incantations.
- Demos in one screenshot/GIF (the "star magnet").

## 3. Scope
**MVP (must-have)**
- `portkill <port>` — find the process on that port and kill it (after confirm).
- Works on Windows, macOS, Linux.
- Shows what will be killed (PID, process name, command) **before** killing.
- Handles "nothing is listening on that port" gracefully.
- Handles multiple PIDs on one port (e.g., IPv4 + IPv6).

**Stretch (nice-to-have)**
- `portkill 3000 4000 8080` — multiple ports at once.
- `portkill -f/--force` — skip confirmation.
- `portkill -l/--list <port>` — list only, never kill.
- `portkill --json` — machine-readable output.
- `portkill 3000-3010` — port ranges.
- Coloured output (implement ANSI manually; no `chalk`).

**Non-goals**
- No daemon/background process. No config file. No GUI. No remote hosts.

## 4. Tech & constraints
- Node **>= 18**, ESM (`"type": "module"`).
- **Zero runtime dependencies.** Use `node:child_process`, `node:readline`, `node:util`, `node:os`.
- Single-file entry: `bin/portkill.mjs` (or `index.mjs` with a thin bin shim).
- Cross-platform: detect `process.platform` and branch.

## 5. CLI / UX design
```
Usage: portkill <port> [ports...] [options]

Options:
  -f, --force     Kill without confirmation
  -l, --list      List processes on the port(s), don't kill
      --json      Output JSON
  -h, --help      Show help
  -v, --version   Show version

Examples:
  npx portkill 3000
  npx portkill 3000 8080 --force
  npx portkill 3000 --list
```

Example run:
```
$ npx portkill 3000
port 3000 is used by:
  PID 48213  node       node server.js
Kill it? [y/N] y
✓ killed PID 48213 — port 3000 is free
```

## 6. How to find the process (per OS)
- **Windows:** `netstat -ano -p tcp` → parse the line with `:<port>` in LISTENING state → last column is PID. Resolve name via `tasklist /FI "PID eq <pid>" /FO CSV /NH`. Kill via `taskkill /PID <pid> /F`.
- **macOS/Linux:** prefer `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` for PIDs; get details from `ps -p <pid> -o comm=,args=`. Kill via `process.kill(pid, 'SIGTERM')`, escalate to `SIGKILL` after a short timeout. Fallback to `fuser` if `lsof` is missing.
- Wrap all spawns with a helper that returns `{stdout, code}` and never throws on non-zero.

## 7. Architecture & file layout
```
portkill/
  bin/portkill.mjs        # shebang + arg parse + orchestration
  src/find.mjs            # findProcessesOnPort(port) -> [{pid,name,cmd}]
  src/kill.mjs            # kill(pid) with SIGTERM->SIGKILL escalation
  src/args.mjs            # tiny zero-dep arg parser
  src/ui.mjs              # ansi colours + confirm prompt (readline)
  test/find.test.mjs
  test/args.test.mjs
  package.json            # bin: { "portkill": "bin/portkill.mjs" }, files: [bin, src]
  README.md
  LICENSE                 # MIT
  CONTRIBUTING.md
  .github/workflows/ci.yml
  .gitignore
```

## 8. Implementation steps (ordered)
1. **Scaffold:** `package.json` (name, version 0.1.0, type module, bin, engines node>=18, files), `.gitignore` (node_modules), MIT `LICENSE`.
2. **Arg parser** (`src/args.mjs`): parse ports (ints + ranges), flags. Unit-test it.
3. **Finder** (`src/find.mjs`): OS branch, spawn, parse, dedupe PIDs. Return normalized objects.
4. **Killer** (`src/kill.mjs`): SIGTERM, wait ~1.5s, check alive, SIGKILL. On Windows use `taskkill /F`.
5. **UI** (`src/ui.mjs`): ANSI colour helpers (respect `NO_COLOR` + non-TTY), `confirm()` via `node:readline/promises`.
6. **Wire `bin/portkill.mjs`:** help/version, `--list`, confirm unless `--force`, `--json`, exit codes.
7. **Polish:** friendly empty-state, error messages, `--help` examples.
8. **Tests + CI + README.**

## 9. Edge cases & safety
- **Confirm before killing** unless `--force`. This is the primary safety gate.
- **Refuse to kill PID 0/1** and, on Windows, obvious system PIDs (System, PID 4); warn and skip.
- If the port has no listener, print a clear message and exit 0 (not an error).
- Permission denied (need sudo/admin) → explain clearly, exit non-zero.
- Multiple PIDs → list all, confirm once, kill each, report per-PID result.
- Never interpolate the port straight into a shell string — validate it's an integer in 1–65535 first (injection guard).

## 10. Testing plan (`node --test`)
- `args`: single port, multiple ports, range expansion, flags, invalid port rejected.
- `find` parsing: feed captured `netstat`/`lsof` sample output strings to a pure parser fn and assert PIDs — keep parsing pure/testable, separate from spawning.
- Empty result path returns `[]`.
- Port validation rejects `0`, `70000`, `abc`.

## 11. README outline (mirror Polyrule's style)
- Title + badges (CI, license, npm version).
- One-liner + the `EADDRINUSE` pain, then the fix in one code block.
- Animated GIF placeholder: `![demo](docs/demo.gif)`.
- Quick start (`npx portkill 3000`), Options table, How it works (per-OS, "no magic"), Install (`npm i -g portkill`), Contributing, License.

## 12. Distribution
- `npm publish` (public). Ensure `bin` is executable + shebang `#!/usr/bin/env node`.
- Tag `v0.1.0`, create a GitHub Release with the GIF.
- Optional later: `scoop`/`brew` formula.

## 13. Launch checklist
- Record a 6–8s asciinema/GIF.
- Show HN: "Show HN: portkill – kill whatever's on a port, any OS".
- r/programming, r/node, r/webdev, r/commandline.
- X/Twitter + dev.to post.
- Add to `star-tool10-awesome-zero-dependency`.

## 14. Definition of Done + star-magnet checklist
- [ ] Works on Windows, macOS, Linux (tested on at least Windows + one Unix).
- [ ] `npx portkill <port>` gives value in < 60s, zero config.
- [ ] Confirmation gate + system-PID guard implemented.
- [ ] README with GIF + badges; CI green; `node --test` passes.
- [ ] Published to npm; GitHub Release cut.
- [ ] "good first issue" labels for stretch features to invite contributors.
