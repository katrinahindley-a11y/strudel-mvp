import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const HOST = 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech';

export function parseArgs(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--company', '--publish-scan', '--max-pages', '--max-requests', '--apply'].includes(key) || values.has(key)) throw Error('INVALID_ARGUMENTS');
    if (key === '--apply') { values.set(key, true); continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw Error('INVALID_ARGUMENTS');
    values.set(key, value);
  }
  const companyNumber = values.get('--company'); const scanId = values.get('--publish-scan');
  if (!/^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$/.test(companyNumber || '')) throw Error('INVALID_COMPANY_NUMBER');
  if (scanId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scanId)) throw Error('INVALID_SCAN_ID');
  const pages = values.get('--max-pages') || '10'; const requests = values.get('--max-requests') || '12';
  if (!/^[1-9][0-9]*$/.test(pages) || Number(pages) > 100 || !/^[1-9][0-9]*$/.test(requests) || Number(requests) > 102) throw Error('INVALID_REQUEST_BUDGET');
  return { companyNumber, scanId, phase: scanId ? 'publish' : 'stage', apply: values.has('--apply'), maxPages: Number(pages), maxRequests: Number(requests) };
}

export function guardedConnection(value) {
  if (!value) throw Error('TEST_DATABASE_URL_REQUIRED');
  let url; try { url = new URL(value); } catch { throw Error('INVALID_TEST_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== HOST || decodeURIComponent(url.pathname) !== '/neondb' || url.hash || (url.port && url.port !== '5432')) throw Error('UNAPPROVED_DATABASE_ENDPOINT');
  for (const key of ['host', 'hostaddr', 'service', 'dbname', 'database', 'port', 'user', 'password', 'options']) {
    if (url.searchParams.has(key)) throw Error('DATABASE_OVERRIDE_REJECTED');
  }
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl', 'uselibpqcompat']) url.searchParams.delete(key);
  return url.toString();
}

export function createBudgetedClient({ apiKey, companyNumber, maxRequests = 12, fetchFn = fetch, sleep = delay, clock = Date.now }) {
  if (!apiKey) throw Error('COMPANIES_HOUSE_KEY_REQUIRED');
  if (!/^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$/.test(companyNumber || '') || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 102) throw Error('INVALID_REQUEST_BUDGET');
  let used = 0, lastStart = null, halted = false, tail = Promise.resolve();
  async function execute(path) {
    if (halted) throw Error('REQUEST_CLIENT_HALTED');
    const url = new URL(path, 'https://api.company-information.service.gov.uk');
    const base = '/company/' + companyNumber;
    if (url.origin !== 'https://api.company-information.service.gov.uk' || url.username || url.password || url.hash || ![base, base + '/charges'].includes(url.pathname)) throw Error('UNAPPROVED_API_ENDPOINT');
    for (const [key, value] of url.searchParams) {
      if (!['items_per_page', 'start_index'].includes(key) || !/^[0-9]+$/.test(value)) throw Error('INVALID_API_PARAMETERS');
    }
    if (used >= maxRequests) throw Error('REQUEST_BUDGET_EXHAUSTED');
    if (lastStart !== null) await sleep(Math.max(0, 1100 - (clock() - lastStart)));
    lastStart = clock(); used++;
    let response;
    try {
      response = await fetchFn(url.toString(), { headers: { Authorization: 'Basic ' + Buffer.from(apiKey + ':').toString('base64'), Accept: 'application/json' }, signal: AbortSignal.timeout(7000), redirect: 'error' });
    } catch { throw Error('COMPANIES_HOUSE_REQUEST_FAILED'); }
    if (!response.ok) {
      if (response.status === 429) throw Error('COMPANIES_HOUSE_RATE_LIMITED_STOP');
      if ([401, 403].includes(response.status)) throw Error('COMPANIES_HOUSE_AUTHENTICATION_FAILED');
      if (response.status === 404 && url.pathname === base) throw Error('COMPANY_PROFILE_NOT_FOUND');
      throw Error('COMPANIES_HOUSE_HTTP_FAILURE');
    }
    try {
      const data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('INVALID_JSON');
      return data;
    } catch { throw Error('COMPANIES_HOUSE_INVALID_JSON'); }
  }
  return {
    request(path) {
      const task = tail.then(() => execute(path));
      tail = task.catch(() => { halted = true; });
      return task;
    },
    requestsUsed: () => used
  };
}

export async function runManualImport(args, env = process.env, dependencies = {}) {
  const options = parseArgs(args);
  if (!options.apply) return { mode: 'dry_run', executed: false, ...options, apply: false };
  const connectionString = guardedConnection(env.CCOD_TEST_DATABASE_URL);
  if (options.phase === 'stage' && !env.COMPANIES_HOUSE_API_KEY) throw Error('COMPANIES_HOUSE_KEY_REQUIRED');
  const makePool = dependencies.makePool || (async config => { const { default: pg } = await import('pg'); return new pg.Pool(config); });
  const pool = await makePool({ connectionString, ssl: { rejectUnauthorized: true }, max: 1, connectionTimeoutMillis: 10000, idleTimeoutMillis: 5000, statement_timeout: 15000 });
  try {
    if (options.phase === 'publish') {
      const publish = dependencies.publish || (await import('./lib/publish_company_charge_scan.mjs')).publishCompanyChargeScan;
      return await publish({ companyNumber: options.companyNumber, scanId: options.scanId, pool, apply: true });
    }
    const client = createBudgetedClient({ apiKey: env.COMPANIES_HOUSE_API_KEY, companyNumber: options.companyNumber, maxRequests: options.maxRequests, ...dependencies.transport });
    const stage = dependencies.stage || (await import('./lib/stage_company_charge_scan.mjs')).stageCompanyChargeScan;
    const result = await stage({ companyNumber: options.companyNumber, pool, request: client.request, apply: true, maxPages: options.maxPages });
    return { ...result, requestsUsed: client.requestsUsed() };
  } finally { await pool.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runManualImport(process.argv.slice(2)).then(result => console.log(JSON.stringify(result)))
    .catch(() => { console.error(JSON.stringify({ error: 'MANUAL_CHARGE_IMPORT_FAILED', note: 'No credentials or raw exception details are logged. Inspect tracking state before retrying.' })); process.exitCode = 1; });
}
