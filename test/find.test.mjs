import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNetstat,
  parseLsofPids,
  parseFuser,
  parseSs,
  parseLsofFull,
  parsePsOutput,
  parseTasklistName,
  findProcessesOnPort,
  findProcessesOnPorts,
} from '../src/find.mjs';

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       48213
  TCP    [::]:3000              [::]:0                 LISTENING       48213
  TCP    127.0.0.1:3000         127.0.0.1:54321        ESTABLISHED     48213
  TCP    0.0.0.0:13000          0.0.0.0:0              LISTENING       999
  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       777
`;

test('parseNetstat: only LISTENING PIDs for the exact port, deduped', () => {
  assert.deepEqual(parseNetstat(NETSTAT, 3000), [48213]);
});

test('parseNetstat: does not confuse 3000 with 13000', () => {
  assert.deepEqual(parseNetstat(NETSTAT, 13000), [999]);
});

test('parseNetstat: empty when no match', () => {
  assert.deepEqual(parseNetstat(NETSTAT, 9999), []);
});

// Regression: netstat localizes the STATE column on non-English Windows, so the
// tool must not rely on the literal "LISTENING" text. Listeners are detected by
// their wildcard foreign address (:0) instead.
const NETSTAT_DE = `
Aktive Verbindungen

  Proto  Lokale Adresse         Remoteadresse          Status          PID
  TCP    0.0.0.0:3000           0.0.0.0:0              ABHÖREN         48213
  TCP    [::]:3000              [::]:0                 ABHÖREN         48213
  TCP    127.0.0.1:3000         127.0.0.1:54321        HERGESTELLT     4444
`;

test('parseNetstat: finds listeners on a German (non-English) locale', () => {
  // Old English-only logic returned [] here; the ESTABLISHED row (pid 4444)
  // must still be excluded.
  assert.deepEqual(parseNetstat(NETSTAT_DE, 3000), [48213]);
});

// French state text has a space ("À L'ÉCOUTE"), which shifts the column count;
// keying off the foreign address (parts[2]) and the last column for the PID
// keeps this robust.
const NETSTAT_FR = `
Connexions actives

  Proto  Adresse locale         Adresse distante       État            PID
  TCP    0.0.0.0:8080           0.0.0.0:0              À L'ÉCOUTE      1234
`;

test('parseNetstat: tolerates a multi-word localized state (French)', () => {
  assert.deepEqual(parseNetstat(NETSTAT_FR, 8080), [1234]);
});

test('parseLsofPids: one pid per line, deduped', () => {
  assert.deepEqual(parseLsofPids('48213\n48213\n777\n'), [48213, 777]);
});

test('parseLsofPids: empty input', () => {
  assert.deepEqual(parseLsofPids(''), []);
});

test('parseFuser: extracts pids and drops the port', () => {
  assert.deepEqual(parseFuser('3000/tcp:            48213 48990\n', 3000), [48213, 48990]);
});

const SS_OUT = `LISTEN 0 128 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=48213,fd=20))
LISTEN 0 128 [::]:3000 [::]:* users:(("node",pid=48213,fd=21))`;

test('parseSs: extracts pids from the users:(...) field, deduped', () => {
  assert.deepEqual(parseSs(SS_OUT), [48213]);
});

test('parseSs: empty input', () => {
  assert.deepEqual(parseSs(''), []);
});

test('parsePsOutput: splits name from the full command line', () => {
  assert.deepEqual(
    parsePsOutput('node node /srv/app.js --port 3000'),
    { name: 'node', cmd: 'node /srv/app.js --port 3000' },
  );
});

test('parsePsOutput: empty input', () => {
  assert.deepEqual(parsePsOutput('   '), { name: '', cmd: '' });
});

test('parseTasklistName: reads the CSV image name', () => {
  assert.equal(parseTasklistName('"node.exe","48213","Console","1","52,340 K"'), 'node.exe');
});

test('parseTasklistName: no matching task -> empty', () => {
  assert.equal(
    parseTasklistName('INFO: No tasks are running which match the specified criteria.'),
    '',
  );
});

test('findProcessesOnPort: windows path (injected run)', async () => {
  const run = async (cmd) => {
    if (cmd === 'netstat') return { code: 0, stdout: NETSTAT, stderr: '' };
    if (cmd === 'tasklist') return { code: 0, stdout: '"node.exe","48213","Console","1","10 K"', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const res = await findProcessesOnPort(3000, { platform: 'win32', run });
  assert.deepEqual(res, [{ pid: 48213, name: 'node.exe', cmd: '' }]);
});

test('findProcessesOnPort: posix path via lsof (injected run)', async () => {
  const run = async (cmd) => {
    if (cmd === 'lsof') return { code: 0, stdout: '48213\n', stderr: '' };
    if (cmd === 'ps') return { code: 0, stdout: 'node node /srv/app.js', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const res = await findProcessesOnPort(3000, { platform: 'linux', run });
  assert.deepEqual(res, [{ pid: 48213, name: 'node', cmd: 'node /srv/app.js' }]);
});

test('findProcessesOnPort: falls back to fuser when lsof is missing', async () => {
  const run = async (cmd) => {
    if (cmd === 'lsof') {
      return { code: -1, stdout: '', stderr: '', error: Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }) };
    }
    if (cmd === 'fuser') return { code: 0, stdout: '3000/tcp: 48213', stderr: '' };
    if (cmd === 'ps') return { code: 0, stdout: 'node node /srv/app.js', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const res = await findProcessesOnPort(3000, { platform: 'linux', run });
  assert.deepEqual(res, [{ pid: 48213, name: 'node', cmd: 'node /srv/app.js' }]);
});

test('findProcessesOnPort: empty when nothing is listening', async () => {
  const run = async () => ({ code: 1, stdout: '', stderr: '' });
  const res = await findProcessesOnPort(3000, { platform: 'linux', run });
  assert.deepEqual(res, []);
});

// Regression: `netstat -ano -p tcp` is IPv4-only on Windows and silently drops
// IPv6 listeners ([::]:port), which is exactly how Node's default dual-stack
// listen / Vite / many dev servers bind. That made portkill report a busy port
// as free. findProcessesOnPort must invoke netstat WITHOUT a family filter and
// still discover an IPv6-only listener.
const NETSTAT_V6_ONLY = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    [::]:3000              [::]:0                 LISTENING       55123
`;

test('findProcessesOnPort: does not filter to IPv4 (finds IPv6 listeners)', async () => {
  let netstatArgs = null;
  const run = async (cmd, args) => {
    if (cmd === 'netstat') {
      netstatArgs = args;
      // Emulate Windows: with `-p tcp` the IPv6 row would be absent. Only
      // return the listener when the family filter is NOT present.
      const filtered = args.includes('-p') && args.includes('tcp');
      return { code: 0, stdout: filtered ? '' : NETSTAT_V6_ONLY, stderr: '' };
    }
    if (cmd === 'tasklist') return { code: 0, stdout: '"node.exe","55123","Console","1","10 K"', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const res = await findProcessesOnPort(3000, { platform: 'win32', run });
  assert.ok(!(netstatArgs.includes('-p') && netstatArgs.includes('tcp')),
    'netstat must not be restricted to a single family');
  assert.deepEqual(res, [{ pid: 55123, name: 'node.exe', cmd: '' }]);
});

// Minimal Linux images (Alpine/Debian containers) ship neither lsof nor fuser,
// only iproute2's `ss`. findProcessesOnPort must fall through lsof -> fuser ->
// ss, with each fallback firing only when the previous probe is not installed.
test('findProcessesOnPort: falls back to ss when lsof and fuser are both missing', async () => {
  const enoent = (name) => ({
    code: -1, stdout: '', stderr: '',
    error: Object.assign(new Error(`spawn ${name} ENOENT`), { code: 'ENOENT' }),
  });
  const run = async (cmd) => {
    if (cmd === 'lsof') return enoent('lsof');
    if (cmd === 'fuser') return enoent('fuser');
    if (cmd === 'ss') {
      return { code: 0, stdout: 'LISTEN 0 128 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=48213,fd=20))', stderr: '' };
    }
    if (cmd === 'ps') return { code: 0, stdout: 'node node /srv/app.js', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const res = await findProcessesOnPort(3000, { platform: 'linux', run });
  assert.deepEqual(res, [{ pid: 48213, name: 'node', cmd: 'node /srv/app.js' }]);
});

// Regression: scanning a range used to spawn one netstat per port. The batched
// scan must call netstat exactly once and still attribute PIDs to the right
// ports, and query tasklist once per distinct PID.
test('findProcessesOnPorts: windows batches a single netstat for many ports', async () => {
  const NETSTAT_MULTI = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       48213
  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       777
`;
  let netstatCalls = 0;
  let tasklistCalls = 0;
  const run = async (cmd) => {
    if (cmd === 'netstat') { netstatCalls += 1; return { code: 0, stdout: NETSTAT_MULTI, stderr: '' }; }
    if (cmd === 'tasklist') {
      tasklistCalls += 1;
      return { code: 0, stdout: '"node.exe","0","Console","1","10 K"', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '' };
  };
  const res = await findProcessesOnPorts([3000, 8080, 9999], { platform: 'win32', run });
  assert.equal(netstatCalls, 1, 'netstat must be invoked exactly once for the batch');
  assert.equal(tasklistCalls, 2, 'tasklist once per distinct PID');
  assert.deepEqual(res, [
    { port: 3000, pid: 48213, name: 'node.exe', cmd: '' },
    { port: 8080, pid: 777, name: 'node.exe', cmd: '' },
  ]);
});

test('findProcessesOnPorts: one process on several ports is queried via tasklist once', async () => {
  const NETSTAT_SHARED = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       48213
  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       48213
`;
  let tasklistCalls = 0;
  const run = async (cmd) => {
    if (cmd === 'netstat') return { code: 0, stdout: NETSTAT_SHARED, stderr: '' };
    if (cmd === 'tasklist') { tasklistCalls += 1; return { code: 0, stdout: '"node.exe","48213","Console","1","10 K"', stderr: '' }; }
    return { code: 1, stdout: '', stderr: '' };
  };
  const res = await findProcessesOnPorts([3000, 3001], { platform: 'win32', run });
  assert.equal(tasklistCalls, 1);
  assert.deepEqual(res, [
    { port: 3000, pid: 48213, name: 'node.exe', cmd: '' },
    { port: 3001, pid: 48213, name: 'node.exe', cmd: '' },
  ]);
});

// lsof -F field output: `p<pid>` applies to each following `n<addr>:<port>`.
const LSOF_FULL = `p48213
nlocalhost:3000
n*:3000
p777
n127.0.0.1:8080
p55123
n[::1]:9229`;

test('parseLsofFull: pairs each pid with its listening port(s), deduped', () => {
  assert.deepEqual(parseLsofFull(LSOF_FULL), [
    { pid: 48213, port: 3000 },
    { pid: 777, port: 8080 },
    { pid: 55123, port: 9229 },
  ]);
});

test('parseLsofFull: empty input', () => {
  assert.deepEqual(parseLsofFull(''), []);
});

// Regression: a POSIX range used to spawn one lsof per port. The batched scan
// must issue a single `lsof ... -FpnP` and filter to the requested ports.
test('findProcessesOnPorts: posix batches a single lsof -F scan', async () => {
  let lsofCalls = 0;
  let lsofArgs = null;
  const run = async (cmd, args) => {
    if (cmd === 'lsof') {
      lsofCalls += 1;
      lsofArgs = args;
      return { code: 0, stdout: LSOF_FULL, stderr: '' };
    }
    if (cmd === 'ps') {
      return { code: 0, stdout: `proc proc for pid`, stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '' };
  };
  const res = await findProcessesOnPorts([3000, 8080], { platform: 'linux', run });
  assert.equal(lsofCalls, 1, 'lsof must be invoked exactly once for the batch');
  assert.ok(lsofArgs.includes('-FpnP'), 'batched lsof must use -F field output');
  assert.deepEqual(res, [
    { port: 3000, pid: 48213, name: 'proc', cmd: 'proc for pid' },
    { port: 8080, pid: 777, name: 'proc', cmd: 'proc for pid' },
  ]);
});

// When lsof is absent the batched path must fall back to the per-port probes
// (which can still find listeners via fuser / ss).
test('findProcessesOnPorts: posix falls back to per-port probes when lsof is missing', async () => {
  const enoent = (name) => ({
    code: -1, stdout: '', stderr: '',
    error: Object.assign(new Error(`spawn ${name} ENOENT`), { code: 'ENOENT' }),
  });
  const run = async (cmd, args) => {
    if (cmd === 'lsof') return enoent('lsof');
    if (cmd === 'fuser') return { code: 0, stdout: `${args[0]}: 48213`, stderr: '' };
    if (cmd === 'ps') return { code: 0, stdout: 'node node app.js', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  };
  const res = await findProcessesOnPorts([3000], { platform: 'linux', run });
  assert.deepEqual(res, [{ port: 3000, pid: 48213, name: 'node', cmd: 'node app.js' }]);
});

// A hard failure (no scanning tool at all) must surface as a thrown ENOTOOL
// error, so the CLI can exit non-zero instead of reporting the port free.
test('findProcessesOnPort: throws ENOTOOL when lsof, fuser and ss are all missing', async () => {
  const enoent = (name) => ({
    code: -1, stdout: '', stderr: '',
    error: Object.assign(new Error(`spawn ${name} ENOENT`), { code: 'ENOENT' }),
  });
  const run = async (cmd) => enoent(cmd);
  await assert.rejects(
    () => findProcessesOnPort(3000, { platform: 'linux', run }),
    (e) => e.code === 'ENOTOOL',
  );
});

test('findProcessesOnPort: throws ENOTOOL when netstat is missing on Windows', async () => {
  const run = async (cmd) => ({
    code: -1, stdout: '', stderr: '',
    error: Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }),
  });
  await assert.rejects(
    () => findProcessesOnPort(3000, { platform: 'win32', run }),
    (e) => e.code === 'ENOTOOL',
  );
});
