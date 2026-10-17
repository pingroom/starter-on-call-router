import { loadConfig, loadConnection, loadEnvironment } from '../src/config.mjs';
import { sendIncident } from '../src/cli.mjs';
import { listReceipts, planRoute, resolveReceipt, routeIncident } from '../src/router.mjs';
import { parseJson } from '../src/values.mjs';
import { readBounded } from '../src/storage.mjs';
try {
  const [command, input, outcome, ...extra] = process.argv.slice(2);
  if (extra.length || !['route', 'plan', 'status', 'resolve'].includes(command) ||
      (['route', 'plan'].includes(command) && (!input || outcome)) || (command === 'status' && input) || (command === 'resolve' && (!input || !outcome))) throw new Error('Usage: npm start -- incident.json | npm run plan -- incident.json | npm run status | npm run resolve -- ID confirmed|abandoned');
  loadEnvironment();
  const config = await loadConfig();
  let result;
  if (['route', 'plan'].includes(command)) {
    const incident = parseJson((await readBounded(input, 8192)).buffer);
    result = command === 'plan' ? planRoute(incident, config) : await routeIncident(incident, config, await loadConnection(), sendIncident);
  } else if (command === 'status') result = await listReceipts(config, await loadConnection());
  else result = await resolveReceipt(input, outcome, config, await loadConnection());
  console.log(JSON.stringify(result, null, 2));
  if ((Array.isArray(result) ? result : [result]).some(item => ['unknown', 'blocked'].includes(item.status))) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
