import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const idValid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(value);
export const notificationId = value => typeof value === 'string' && /^(?!00000000-0000-0000-0000-000000000000$)[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function object(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error('Unexpected or missing fields.');
}
export function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('Use a real UTC timestamp with milliseconds and Z.');
  return Date.parse(value);
}
export function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error(`Text must be nonblank, without control characters, and at most ${max} UTF-16 units.`);
  return value;
}
export function validateIncident(value) {
  object(value, ['id', 'occurredAt', 'title', 'message', 'url'], ['id', 'occurredAt', 'title', 'message']);
  if (!idValid(value.id)) throw new Error('Incident ID must use 1–80 letters, digits, dots, underscores, colons, or hyphens, starting with a letter or digit.');
  timestamp(value.occurredAt);
  const result = { id: value.id, occurredAt: value.occurredAt, title: text(value.title, 40), message: text(value.message, 120) };
  if (value.url !== undefined) {
    if (typeof value.url !== 'string' || value.url.length > 2048 || value.url !== value.url.trim()) throw new Error('Invalid incident URL.');
    let url; try { url = new URL(value.url); } catch { throw new Error('Invalid incident URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\s\u0000-\u001f\u007f]/u.test(value.url)) throw new Error('Use an absolute HTTP(S) URL without credentials or whitespace.');
    result.url = value.url;
  }
  return result;
}
export function validateShift(value) {
  object(value, ['id', 'startsAt', 'endsAt', 'room']);
  if (!idValid(value.id) || timestamp(value.startsAt) >= timestamp(value.endsAt)) throw new Error('Each shift needs a valid ID and a positive UTC interval.');
  if (typeof value.room !== 'string' || !/^[A-Z0-9]{4,32}$/.test(value.room)) throw new Error('Room codes must be 4–32 uppercase letters or digits.');
  return { id: value.id, startsAt: value.startsAt, endsAt: value.endsAt, room: value.room };
}
export function validatePolicy(value) {
  object(value, ['maxAgeSeconds', 'stateDirectory', 'shifts']);
  if (!Number.isInteger(value.maxAgeSeconds) || value.maxAgeSeconds < 1 || value.maxAgeSeconds > 3600) throw new Error('maxAgeSeconds must be an integer from 1 through 3600.');
  if (typeof value.stateDirectory !== 'string' || !value.stateDirectory.trim() || /[\u0000-\u001f]/u.test(value.stateDirectory)) throw new Error('A stateDirectory is required.');
  if (!Array.isArray(value.shifts) || !value.shifts.length || value.shifts.length > 256) throw new Error('Supply 1–256 explicit UTC shifts.');
  const shifts = value.shifts.map(validateShift).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const ids = new Set();
  for (let i = 0; i < shifts.length; i++) {
    if (ids.has(shifts[i].id)) throw new Error('Shift IDs must be unique.');
    ids.add(shifts[i].id);
    if (i && shifts[i].startsAt < shifts[i - 1].endsAt) throw new Error('Shifts overlap; choose exactly one destination at any instant.');
  }
  return { maxAgeSeconds: value.maxAgeSeconds, stateDirectory: value.stateDirectory, shifts };
}
export const policyHash = policy => hash(JSON.stringify({ maxAgeSeconds: policy.maxAgeSeconds, shifts: policy.shifts }));
export function selectShift(policy, incident, now) {
  if (!Number.isSafeInteger(now)) throw new Error('Clock must provide epoch milliseconds.');
  const age = now - timestamp(incident.occurredAt);
  if (age < 0 || age > policy.maxAgeSeconds * 1000) throw new Error('Incident is future-dated or stale; nothing was sent.');
  const shift = policy.shifts.find(item => timestamp(item.startsAt) <= now && now < timestamp(item.endsAt));
  if (!shift) throw new Error('No shift covers the current time; nothing was sent.');
  return shift;
}
export function parseJson(buffer) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
  // JSON syntax errors can contain fragments of the incident body.
  catch { throw new Error('Input must be valid UTF-8 JSON.'); }
}
