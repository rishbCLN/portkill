import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNetstat,
  parseLsofPids,
  parseFuser,
  parsePsOutput,
  parseTasklistName,
  findProcessesOnPort,
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
