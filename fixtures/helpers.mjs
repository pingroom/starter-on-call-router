import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const now = Date.parse('2030-10-17T15:59:30.000Z');
export const connection = { token: 'offline-token', apiUrl: 'https://api.pingroom.io' };
export const notification = { notificationId: '12345678-1234-4123-8123-123456789012' };
export const incident = { id: 'incident-1042', occurredAt: '2030-10-17T15:59:00.000Z', title: 'New incident', message: 'Import needs investigation.', url: 'https://example.com/incidents/1042' };
export const shifts = [
  { id: 'day', startsAt: '2030-10-17T08:00:00.000Z', endsAt: '2030-10-17T16:00:00.000Z', room: 'DAYTEAM12345' },
  { id: 'night', startsAt: '2030-10-17T16:00:00.000Z', endsAt: '2030-10-18T08:00:00.000Z', room: 'NIGHTEAM1234' },
];
export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'router-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { maxAgeSeconds: 900, stateDirectory: directory, shifts: structuredClone(shifts) };
}
