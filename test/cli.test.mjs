import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { sendIncident } from '../src/cli.mjs';
import { incident, shifts, notification } from '../fixtures/helpers.mjs';
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
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, notification_id: notification.notificationId }));
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
