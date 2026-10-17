import { loadEnvFile } from 'node:process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBounded } from './storage.mjs';
import { hash, parseJson, validatePolicy } from './values.mjs';
export const projectRoot = fileURLToPath(new URL('..', import.meta.url));
export const connectionHome = (env = process.env) => env.PINGROOM_HOME || join(projectRoot, '.pingroom');
export function loadEnvironment() {
  try { loadEnvFile(join(projectRoot, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load .env.'); }
}
export async function loadConfig() {
  let data;
  try { data = parseJson((await readBounded(join(projectRoot, 'config.json'), 65536)).buffer); }
  catch { throw new Error('Copy config.example.json to config.json and set your current roster.'); }
  const config = validatePolicy(data);
  return { ...config, stateDirectory: resolve(projectRoot, config.stateDirectory) };
}
export async function loadConnection(env = process.env) {
  let token;
  if (Object.hasOwn(env, 'PINGROOM_TOKEN') || env.CI) {
    token = env.PINGROOM_TOKEN;
  } else {
    let saved;
    try { saved = parseJson((await readBounded(join(connectionHome(env), 'credentials.json'), 65536)).buffer); }
    catch { throw new Error('Run npm run connect, or set PINGROOM_TOKEN.'); }
    if (saved?.api_url && saved.api_url !== 'https://api.pingroom.io') throw new Error('This starter requires a production PingRoom connection.');
    token = saved?.token;
  }
  if (typeof token !== 'string' || !token || token.length > 8192 || /\s/u.test(token)) throw new Error('PINGROOM_TOKEN or saved token must be nonblank and contain no whitespace.');
  return { token, apiUrl: 'https://api.pingroom.io' };
}
export function binding(connection) {
  return hash(JSON.stringify({ api: connection.apiUrl, tokenHash: hash(connection.token) }));
}
