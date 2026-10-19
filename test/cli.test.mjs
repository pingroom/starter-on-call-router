import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sendIncident } from '../src/cli.mjs';
import { incident, shifts, notification } from '../fixtures/helpers.mjs';
const exec = promisify(execFile);
async function server(t, handler) {
  const value = createServer(handler);
  await new Promise(resolve => value.listen(0, '127.0.0.1', resolve));
  t.after(() => { value.closeAllConnections(); value.close(); });
  return { token: 'local-test-token', apiUrl: `http://127.0.0.1:${value.address().port}` };
}
test('real pinned CLI sends only to the frozen room with explicit token and incident data', async t => {
  let body, path, auth, calls = 0;
  const connection = await server(t, async (req, res) => {
    calls++; path = req.url; auth = req.headers.authorization;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks));
    // The agent route answers 201 with the created notification row; its `id` is the notification ID.
    res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: notification.notificationId, type: 'sent' }));
  });
  const saved = { webhook: process.env.PINGROOM_WEBHOOK_URL, api: process.env.PINGROOM_API_URL, room: process.env.PINGROOM_ROOM };
  process.env.PINGROOM_WEBHOOK_URL = 'http://127.0.0.1:1/never'; process.env.PINGROOM_API_URL = 'http://127.0.0.1:1'; process.env.PINGROOM_ROOM = 'WRONGROOM';
  t.after(() => { for (const [key, val] of [['PINGROOM_WEBHOOK_URL', saved.webhook], ['PINGROOM_API_URL', saved.api], ['PINGROOM_ROOM', saved.room]]) val === undefined ? delete process.env[key] : process.env[key] = val; });
  assert.deepEqual(await sendIncident(incident, shifts[0], connection), notification);
  assert.equal(calls, 1); assert.equal(path, `/api/agent/rooms/${shifts[0].room}/notifications`); assert.equal(auth, `Bearer ${connection.token}`);
  assert.equal(body.data.incident_id, incident.id); assert.equal(body.data.shift_id, 'day'); assert.equal(body.data.url, incident.url);
  assert.equal(body.message, incident.message); assert.equal(body.is_urgent, undefined);
});
for (const [name, code, response] of [
  ['permission failure', 403, JSON.stringify({ message: 'PRIVATE TOKEN DETAIL' })],
  ['malformed output', 200, 'not-json'], ['no success ID', 200, '{}'], ['empty output', 200, ''],
  ['conflicting IDs', 200, JSON.stringify({ id: '22345678-1234-4123-8123-123456789012', notification_id: notification.notificationId })],
]) test(`real CLI rejects ${name} without leaking upstream details`, async t => {
  const connection = await server(t, (_req, res) => { res.statusCode = code; res.end(response); });
  await assert.rejects(sendIncident(incident, shifts[0], connection), error => error.message === 'CLI did not confirm delivery; the remote outcome may be unknown.');
});
test('real CLI timeout after observed request is an uncertain outcome', async t => {
  let seen = false;
  const connection = await server(t, (_req, _res) => { seen = true; });
  await assert.rejects(sendIncident(incident, shifts[0], connection, { timeoutMs: 3000 }), /unknown/);
  assert.equal(seen, true);
});

for (const command of ['route', 'plan']) test(`${command} rejects malformed incident JSON without exposing content or changing receipts`, async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'on-call-invalid-json-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(root, 'src'), join(directory, 'src'), { recursive: true });
  await mkdir(join(directory, 'scripts'));
  await copyFile(join(root, 'scripts/router.mjs'), join(directory, 'scripts/router.mjs'));
  await copyFile(join(root, 'config.example.json'), join(directory, 'config.json'));
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const stateDirectory = join(directory, '.routing');
  await mkdir(stateDirectory);
  const state = '{"version":1,"binding":"existing-receipts-marker","records":[]}\n';
  await writeFile(join(stateDirectory, 'state.json'), state);
  await writeFile(join(directory, 'incident.json'), '{"message":PRIVATE_INCIDENT_MARKER}');

  await assert.rejects(exec(process.execPath, ['scripts/router.mjs', command, 'incident.json'], {
    cwd: directory,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CI: 'true', PINGROOM_NO_UPDATE_CHECK: '1' },
  }), error => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.doesNotMatch(error.stderr, /PRIVATE|message/);
    assert.equal(error.stderr, 'Input must be valid UTF-8 JSON.\n');
    return true;
  });
  assert.equal(await readFile(join(stateDirectory, 'state.json'), 'utf8'), state);
  assert.deepEqual(await readdir(stateDirectory), ['state.json']);
});
