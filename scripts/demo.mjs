import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeIncident } from '../src/router.mjs';
const directory = await mkdtemp(join(tmpdir(), 'on-call-demo-'));
try {
  const config = { maxAgeSeconds: 900, stateDirectory: directory, shifts: [
    { id: 'day', startsAt: '2030-10-17T08:00:00.000Z', endsAt: '2030-10-17T16:00:00.000Z', room: 'DAYTEAM12345' },
    { id: 'night', startsAt: '2030-10-17T16:00:00.000Z', endsAt: '2030-10-18T08:00:00.000Z', room: 'NIGHTEAM1234' },
  ] };
  const connection = { token: 'demo-only-token', apiUrl: 'https://api.pingroom.io' };
  let sends = 0;
  const send = async (_incident, shift) => { sends++; console.log(`SIMULATED delivery to ${shift.room}`); return { notificationId: '12345678-1234-4123-8123-123456789012' }; };
  const incident = { id: 'demo-1', occurredAt: '2030-10-17T15:59:00.000Z', title: 'Import incident', message: 'A data import needs investigation.' };
  console.log(await routeIncident(incident, config, connection, send, () => Date.parse('2030-10-17T15:59:30.000Z')));
  console.log('Replaying after shift change:');
  console.log(await routeIncident(incident, config, connection, send, () => Date.parse('2030-10-17T16:00:10.000Z')));
  console.log(await routeIncident({ ...incident, id: 'demo-2', occurredAt: '2030-10-17T16:00:00.000Z' }, config, connection, send, () => Date.parse('2030-10-17T16:00:10.000Z')));
  if (sends !== 2) throw new Error('Demo expected exactly two simulated sends.');
  console.log('Two incidents, two simulated sends. The replay kept its original recipient.');
} finally { await rm(directory, { recursive: true, force: true }); }
