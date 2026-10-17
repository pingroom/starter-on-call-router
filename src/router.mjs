import { readState, writeState, withLock } from './storage.mjs';
import { binding } from './config.mjs';
import { hash, notificationId, object, policyHash, selectShift, timestamp, validateIncident, validatePolicy, validateShift } from './values.mjs';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function validateState(state, expected) {
  object(state, ['version', 'binding', 'records']);
  if (state.version !== 1 || state.binding !== expected || !Array.isArray(state.records) || state.records.length > 10000) throw new Error('State is invalid or belongs to a different token. Preserve it; do not reset it to retry.');
  const ids = new Set();
  for (const record of state.records) {
    object(record, ['incident', 'incidentHash', 'policyHash', 'shift', 'selectedAt', 'status', 'notificationId'], ['incident', 'incidentHash', 'policyHash', 'shift', 'selectedAt', 'status']);
    const incident = validateIncident(record.incident);
    const shift = validateShift(record.shift);
    const selectedAt = timestamp(record.selectedAt);
    if (ids.has(incident.id) || record.incidentHash !== hash(JSON.stringify(incident)) || !digest(record.policyHash) ||
        selectedAt < timestamp(shift.startsAt) || selectedAt >= timestamp(shift.endsAt) || selectedAt < timestamp(incident.occurredAt) ||
        !['sending', 'unknown', 'sent', 'blocked', 'confirmed', 'abandoned'].includes(record.status)) throw new Error('Invalid routing receipt; restore a trusted backup.');
    if (record.status === 'sent' ? !notificationId(record.notificationId) : record.notificationId !== undefined) throw new Error('Invalid receipt notification ID.');
    ids.add(incident.id);
  }
  return state;
}
function view(record) {
  return { id: record.incident.id, status: record.status === 'sending' ? 'unknown' : record.status, room: record.shift.room,
    shift: record.shift.id, selectedAt: record.selectedAt, ...(record.notificationId ? { notificationId: record.notificationId } : {}) };
}
async function load(policy, connection) {
  const expected = binding(connection);
  return validateState(await readState(policy.stateDirectory) ?? { version: 1, binding: expected, records: [] }, expected);
}
export function planRoute(input, config, now = Date.now()) {
  const incident = validateIncident(input), policy = validatePolicy(config);
  const shift = selectShift(policy, incident, now);
  return { incident, shift, policyHash: policyHash(policy), selectedAt: new Date(now).toISOString() };
}
export async function routeIncident(input, config, connection, send, clock = Date.now) {
  const incident = validateIncident(input), policy = validatePolicy(config);
  return withLock(policy.stateDirectory, async () => {
    const state = await load(policy, connection);
    const incidentHash = hash(JSON.stringify(incident));
    const existing = state.records.find(record => record.incident.id === incident.id);
    if (existing) {
      if (existing.incidentHash !== incidentHash) throw new Error('Incident ID already exists with different content; nothing was sent.');
      return view(existing);
    }
    if (state.records.length >= 10000) throw new Error('Routing store is full. Plan archival without losing replay protection.');
    const plan = planRoute(incident, policy, clock());
    const record = { ...plan, incidentHash, status: 'sending' };
    state.records.push(record);
    await writeState(policy.stateDirectory, state);
    // Recheck immediately after the durable reservation. A clock/shift boundary
    // can invalidate the recipient; keep the receipt but do not reroute this ID.
    try {
      const current = selectShift(policy, incident, clock());
      if (JSON.stringify(current) !== JSON.stringify(record.shift)) throw new Error('Shift changed.');
    } catch {
      record.status = 'blocked';
      await writeState(policy.stateDirectory, state);
      return view(record);
    }
    try {
      const result = await send(incident, record.shift, connection);
      if (!notificationId(result?.notificationId)) throw new Error('Delivery was not confirmed.');
      record.notificationId = result.notificationId;
      record.status = 'sent';
    } catch { record.status = 'unknown'; }
    await writeState(policy.stateDirectory, state);
    return view(record);
  });
}
export async function listReceipts(config, connection) {
  const policy = validatePolicy(config);
  return withLock(policy.stateDirectory, async () => (await load(policy, connection)).records.map(view));
}
export async function resolveReceipt(id, outcome, config, connection) {
  if (!['confirmed', 'abandoned'].includes(outcome)) throw new Error('Resolution must be confirmed or abandoned.');
  const policy = validatePolicy(config);
  return withLock(policy.stateDirectory, async () => {
    const state = await load(policy, connection);
    const record = state.records.find(item => item.incident.id === id);
    if (!record) throw new Error('Unknown incident ID.');
    if (record.status === outcome) return view(record);
    if (!['sending', 'unknown'].includes(record.status)) throw new Error('Only uncertain delivery can be resolved.');
    record.status = outcome;
    await writeState(policy.stateDirectory, state);
    return view(record);
  });
}
