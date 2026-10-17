import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, incident, now, connection, notification } from '../fixtures/helpers.mjs';
import { listReceipts, planRoute, resolveReceipt, routeIncident } from '../src/router.mjs';
import { validateIncident, validatePolicy } from '../src/values.mjs';
import { readBounded } from '../src/storage.mjs';
import { loadConnection } from '../src/config.mjs';

test('routes exactly one incident to the current room and retains immutable replay', async t => {
  const config = await fixture(t), sent = [];
  const send = async (job, shift) => { sent.push({ job, shift }); return notification; };
  const first = await routeIncident(incident, config, connection, send, () => now);
  assert.equal(first.status, 'sent'); assert.equal(first.room, 'DAYTEAM12345'); assert.equal(sent.length, 1);
  const changed = { ...config, maxAgeSeconds: 1, shifts: config.shifts.map(s => ({ ...s, room: 'OTHERROOM123' })) };
  assert.deepEqual(await routeIncident(incident, changed, connection, send, () => now + 86400000), first);
  assert.equal(sent.length, 1);
  await assert.rejects(routeIncident({ ...incident, message: 'Changed' }, config, connection, send, () => now), /different content/);
  const saved = await readFile(join(config.stateDirectory, 'state.json'), 'utf8');
  assert.ok(!saved.includes(connection.token)); assert.equal(JSON.parse(saved).records[0].incident.message, incident.message);
  if (process.platform !== 'win32') assert.equal((await stat(join(config.stateDirectory, 'state.json'))).mode & 0o777, 0o600);
});

test('half-open shifts use next room at exact boundary', async t => {
  const config = await fixture(t);
  assert.equal(planRoute(incident, config, Date.parse('2030-10-17T15:59:59.999Z')).shift.id, 'day');
  assert.equal(planRoute(incident, config, Date.parse('2030-10-17T16:00:00.000Z')).shift.id, 'night');
  const start = { ...incident, occurredAt: config.shifts[0].startsAt };
  assert.equal(planRoute(start, config, Date.parse(start.occurredAt)).shift.id, 'day');
});

test('roster overlap, duplicate ID and invalid intervals are rejected', async t => {
  const config = await fixture(t);
  for (const change of [
    { startsAt: '2030-10-17T15:59:59.999Z' }, { id: 'day' }, { endsAt: '2030-10-17T16:00:00.000Z' },
    { startsAt: '2030-10-17T16:00:00+00:00' }, { room: 'lowercase' },
  ]) assert.throws(() => validatePolicy({ ...config, shifts: [config.shifts[0], { ...config.shifts[1], ...change }] }));
  assert.throws(() => validatePolicy({ ...config, maxAgeSeconds: 3601 }));
  assert.throws(() => validatePolicy({ ...config, shifts: Array(257).fill(config.shifts[0]) }));
  assert.throws(() => validatePolicy({ ...config, extra: true }));
});

test('gaps, future incidents and stale incidents fail before any receipt or send', async t => {
  const config = await fixture(t); let calls = 0;
  const send = async () => { calls++; return notification; };
  for (const [job, clock] of [
    [{ ...incident, occurredAt: '2030-10-17T07:59:00.000Z' }, Date.parse('2030-10-17T07:59:30.000Z')],
    [{ ...incident, occurredAt: '2030-10-17T16:00:00.000Z' }, now],
    [{ ...incident, occurredAt: '2030-10-17T15:44:29.999Z' }, now],
  ]) await assert.rejects(routeIncident(job, config, connection, send, () => clock));
  assert.equal(calls, 0); assert.deepEqual(await listReceipts(config, connection), []);
  assert.equal(planRoute({ ...incident, occurredAt: '2030-10-17T15:44:30.000Z' }, config, now).shift.id, 'day');
});

test('crossing a shift boundary during reservation blocks the ID without rerouting', async t => {
  const config = await fixture(t); let reads = 0, sends = 0;
  const result = await routeIncident(incident, config, connection, async () => { sends++; return notification; }, () => reads++ ? Date.parse('2030-10-17T16:00:00.000Z') : now);
  assert.equal(result.status, 'blocked'); assert.equal(result.room, 'DAYTEAM12345'); assert.equal(sends, 0);
  assert.equal((await routeIncident(incident, config, connection, async () => { sends++; return notification; }, () => now + 60000)).status, 'blocked');
  assert.equal(sends, 0);
});

test('incident expiring during durable reservation is blocked', async t => {
  const config = await fixture(t); config.maxAgeSeconds = 30; let reads = 0, sends = 0;
  const result = await routeIncident(incident, config, connection, async () => { sends++; return notification; }, () => now + (reads++ ? 1 : 0));
  assert.equal(result.status, 'blocked'); assert.equal(sends, 0);
});

test('failed or malformed send remains unknown and is never retried', async t => {
  const config = await fixture(t); let calls = 0;
  const send = async () => { calls++; throw new Error('private upstream details'); };
  assert.equal((await routeIncident(incident, config, connection, send, () => now)).status, 'unknown');
  assert.equal((await routeIncident(incident, config, connection, send, () => now)).status, 'unknown');
  assert.equal(calls, 1);
  assert.equal((await resolveReceipt(incident.id, 'confirmed', config, connection)).status, 'confirmed');
  assert.equal((await routeIncident(incident, config, connection, send, () => now)).status, 'confirmed');
  assert.equal(calls, 1);
  assert.equal((await routeIncident({ ...incident, id: 'bad-result' }, config, connection, async () => ({}), () => now)).status, 'unknown');
  assert.equal((await resolveReceipt('bad-result', 'abandoned', config, connection)).status, 'abandoned');
  assert.equal((await resolveReceipt('bad-result', 'abandoned', config, connection)).status, 'abandoned');
});

test('durable sending state survives interruption and permits only manual resolution', async t => {
  const config = await fixture(t);
  await routeIncident(incident, config, connection, async () => notification, () => now);
  const path = join(config.stateDirectory, 'state.json'), state = JSON.parse(await readFile(path));
  state.records[0].status = 'sending'; delete state.records[0].notificationId; await writeFile(path, JSON.stringify(state));
  let calls = 0;
  assert.equal((await routeIncident(incident, config, connection, async () => { calls++; return notification; }, () => now)).status, 'unknown');
  assert.equal(calls, 0);
  await assert.rejects(resolveReceipt(incident.id, 'sent', config, connection));
  assert.equal((await resolveReceipt(incident.id, 'abandoned', config, connection)).status, 'abandoned');
});

test('another token, corrupt receipt or corrupt state cannot reset replay protection', async t => {
  const config = await fixture(t);
  await routeIncident(incident, config, connection, async () => notification, () => now);
  await assert.rejects(listReceipts(config, { ...connection, token: 'other' }), /different token/);
  const path = join(config.stateDirectory, 'state.json'), state = JSON.parse(await readFile(path));
  state.records[0].incident.message = 'tampered'; await writeFile(path, JSON.stringify(state));
  await assert.rejects(listReceipts(config, connection), /Invalid routing receipt/);
  await writeFile(path, 'null'); await assert.rejects(listReceipts(config, connection), /State cannot be read/);
});

test('exclusive lock blocks concurrent router and is retained when already owned', async t => {
  const config = await fixture(t), lock = join(config.stateDirectory, 'run.lock');
  await mkdir(lock);
  await assert.rejects(routeIncident(incident, config, connection, async () => notification, () => now), /Another run/);
  assert.ok((await stat(lock)).isDirectory());
});

test('content limits, invalid date, URL credentials and extra fields fail closed', () => {
  for (const change of [ { title: 'a'.repeat(41) }, { message: '\nunsafe' }, { occurredAt: '2030-02-30T12:00:00.000Z' },
    { id: '../escape' }, { url: 'https://user:secret@example.com' }, { url: 'javascript:alert(1)' }, { extra: true }, { title: '' } ]) assert.throws(() => validateIncident({ ...incident, ...change }));
});

test('large input files and unknown receipts are rejected', async t => {
  const config = await fixture(t), path = join(config.stateDirectory, 'large');
  await writeFile(path, 'a'.repeat(8193)); await assert.rejects(readBounded(path, 8192));
  await assert.rejects(resolveReceipt('missing', 'confirmed', config, connection));
});

test('environment token overrides saved connection and blank token never falls back', async t => {
  const config = await fixture(t), home = config.stateDirectory;
  await writeFile(join(home, 'credentials.json'), JSON.stringify({ token: 'saved-token', api_url: 'https://api.pingroom.io' }));
  assert.equal((await loadConnection({ PINGROOM_HOME: home })).token, 'saved-token');
  assert.equal((await loadConnection({ PINGROOM_HOME: home, PINGROOM_TOKEN: 'env-token' })).token, 'env-token');
  await assert.rejects(loadConnection({ PINGROOM_HOME: home, PINGROOM_TOKEN: '' }));
  await assert.rejects(loadConnection({ PINGROOM_HOME: home, CI: 'true' }));
  await writeFile(join(home, 'credentials.json'), JSON.stringify({ token: 'saved-token', api_url: 'https://other.example' }));
  await assert.rejects(loadConnection({ PINGROOM_HOME: home }), /production/);
});
