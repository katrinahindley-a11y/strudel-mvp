import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, guardedConnection, createBudgetedClient, runManualImport } from '../scripts/run_company_charge_import.mjs';
const number = '15372161';
const db = 'postgresql://user:private@ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech/neondb?sslmode=require';
const ok = { ok: true, json: async () => ({ items: [], total_count: 0 }) };

test('default dry run is offline and rejects unknown or duplicate flags', async () => {
  const result = await runManualImport(['--company', number], {}, { makePool: () => { throw Error('must not connect'); } });
  assert.equal(result.executed, false); assert.equal(result.phase, 'stage');
  assert.throws(() => parseArgs(['--company', number, '--apply', '--apply']));
  assert.throws(() => parseArgs(['--company', number, '--schedule']));
});
test('guards endpoint and never falls back to DATABASE_URL', async () => {
  assert.equal(new URL(guardedConnection(db)).searchParams.has('sslmode'), false);
  assert.throws(() => guardedConnection(db.replace('ep-divine-mud-za5xlaae', 'wrong-host')));
  assert.throws(() => guardedConnection(db + '&host=wrong'));
  await assert.rejects(runManualImport(['--company', number, '--apply'], { DATABASE_URL: db }), /TEST_DATABASE_URL_REQUIRED/);
});
test('request budget is enforced and calls are paced serially', async () => {
  let now = 0, calls = 0; const waits = [];
  const client = createBudgetedClient({ apiKey: 'mock', companyNumber: number, maxRequests: 2,
    clock: () => now, sleep: async ms => { waits.push(ms); now += ms; },
    fetchFn: async () => { calls++; return ok; } });
  await Promise.all([client.request('/company/' + number), client.request('/company/' + number + '/charges')]);
  await assert.rejects(client.request('/company/' + number), /BUDGET_EXHAUSTED/);
  assert.equal(calls, 2); assert.deepEqual(waits, [1100]);
});
test('API endpoint is restricted to the explicitly selected company', async () => {
  let calls = 0;
  const client = createBudgetedClient({ apiKey: 'mock', companyNumber: number, fetchFn: async () => { calls++; return ok; } });
  await assert.rejects(client.request('/company/00000000'), /UNAPPROVED_API_ENDPOINT/);
  assert.equal(calls, 0);
});
test('rate limiting and authentication failures halt subsequent requests', async () => {
  for (const status of [429, 401, 403]) {
    let calls = 0;
    const client = createBudgetedClient({ apiKey: 'mock', companyNumber: number, fetchFn: async () => { calls++; return { ok: false, status }; } });
    await assert.rejects(client.request('/company/' + number));
    await assert.rejects(client.request('/company/' + number), /HALTED/);
    assert.equal(calls, 1);
  }
});
test('request exceptions are sanitized', async () => {
  const client = createBudgetedClient({ apiKey: 'mock', companyNumber: number, fetchFn: async () => { throw Error('private secret'); } });
  await assert.rejects(client.request('/company/' + number), error => error.message === 'COMPANIES_HOUSE_REQUEST_FAILED');
});
test('stage calls only the staging worker and closes its pool', async () => {
  let ended = false, published = false;
  const result = await runManualImport(['--company', number, '--apply'], { CCOD_TEST_DATABASE_URL: db, COMPANIES_HOUSE_API_KEY: 'mock' }, {
    makePool: async () => ({ end: async () => { ended = true; } }),
    stage: async ({ request, maxPages }) => { assert.equal(maxPages, 10); await request('/company/' + number); return { mode: 'staged', publishedToSearch: false }; },
    publish: async () => { published = true; }, transport: { fetchFn: async () => ok }
  });
  assert.equal(result.mode, 'staged'); assert.equal(result.requestsUsed, 1); assert.equal(published, false); assert.equal(ended, true);
});
test('publish requires an explicit scan ID, makes no API request, and closes pool on failure', async () => {
  let ended = false;
  await assert.rejects(runManualImport(['--company', number, '--publish-scan', '11111111-1111-4111-8111-111111111111', '--apply'], { CCOD_TEST_DATABASE_URL: db }, {
    makePool: async () => ({ end: async () => { ended = true; } }),
    publish: async () => { throw Error('publication rejected'); },
    stage: async () => { throw Error('must not stage'); }
  }), /publication rejected/);
  assert.equal(ended, true);
});
