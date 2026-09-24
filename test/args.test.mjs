import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parsePortToken, MAX_RANGE } from '../src/args.mjs';

test('parsePortToken: single valid port', () => {
  assert.deepEqual(parsePortToken('3000'), { ports: [3000], error: null });
});

test('parsePortToken: range expands inclusively', () => {
  const { ports, error } = parsePortToken('3000-3003');
  assert.equal(error, null);
  assert.deepEqual(ports, [3000, 3001, 3002, 3003]);
});

test('parsePortToken: rejects 0 and out-of-range', () => {
  assert.ok(parsePortToken('0').error);
  assert.ok(parsePortToken('70000').error);
});

test('parsePortToken: rejects non-numeric', () => {
  assert.ok(parsePortToken('abc').error);
  assert.ok(parsePortToken('30a0').error);
});

test('parsePortToken: rejects reversed range', () => {
  assert.ok(parsePortToken('3005-3000').error);
});

test('parsePortToken: rejects a range larger than MAX_RANGE', () => {
  assert.ok(parsePortToken(`1-${MAX_RANGE + 5}`).error);
});

test('parseArgs: single port, defaults off', () => {
  const r = parseArgs(['3000']);
  assert.deepEqual(r.ports, [3000]);
  assert.equal(r.force, false);
  assert.equal(r.list, false);
  assert.equal(r.json, false);
  assert.deepEqual(r.errors, []);
});

test('parseArgs: multiple ports plus flags', () => {
  const r = parseArgs(['3000', '8080', '--force', '--json']);
  assert.deepEqual(r.ports, [3000, 8080]);
  assert.equal(r.force, true);
  assert.equal(r.json, true);
});

test('parseArgs: dedupes ports across singles and ranges', () => {
  const r = parseArgs(['3000', '3000', '3000-3001']);
  assert.deepEqual(r.ports, [3000, 3001]);
});

test('parseArgs: short flags', () => {
  const r = parseArgs(['-l', '-f', '3000']);
  assert.equal(r.list, true);
  assert.equal(r.force, true);
  assert.deepEqual(r.ports, [3000]);
});

test('parseArgs: help and version', () => {
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-v']).version, true);
  assert.equal(parseArgs(['--version']).version, true);
});

test('parseArgs: unknown option becomes an error', () => {
  const r = parseArgs(['--bogus', '3000']);
  assert.ok(r.errors.some((e) => /unknown option/.test(e)));
  assert.deepEqual(r.ports, [3000]);
});

test('parseArgs: invalid port is collected as an error, not a port', () => {
  const r = parseArgs(['abc']);
  assert.equal(r.errors.length, 1);
  assert.deepEqual(r.ports, []);
});
