import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { notificationId, validateIncident, validateShift } from './values.mjs';
const exec = promisify(execFile);
export const cliPath = createRequire(import.meta.url).resolve('@pingroom/cli/bin/pingroom.js');
export async function sendIncident(input, selected, connection, { timeoutMs = 15000 } = {}) {
  const incident = validateIncident(input), shift = validateShift(selected);
  const home = await mkdtemp(join(tmpdir(), 'pingroom-router-'));
  try {
    const args = [cliPath, 'ping', '--json', '--title', incident.title, '--message', incident.message,
      '--data', JSON.stringify({ incident_id: incident.id, occurred_at: incident.occurredAt, shift_id: shift.id })];
    if (incident.url) args.push('--url', incident.url, '--button-label', 'Open incident');
    const { stdout } = await exec(process.execPath, args, {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CI: 'true', PINGROOM_NO_UPDATE_CHECK: '1',
        PINGROOM_HOME: home, PINGROOM_TOKEN: connection.token, PINGROOM_ROOM: shift.room, PINGROOM_API_URL: connection.apiUrl },
      timeout: timeoutMs, maxBuffer: 65536,
    });
    const response = JSON.parse(stdout);
    const id = response?.notification_id ?? response?.id;
    if (!notificationId(id) || (response.notification_id !== undefined && response.id !== undefined && response.notification_id !== response.id)) throw new Error('Invalid notification ID.');
    return { notificationId: id };
  } catch { throw new Error('CLI did not confirm delivery; the remote outcome may be unknown.'); }
  finally { await rm(home, { recursive: true, force: true }); }
}
