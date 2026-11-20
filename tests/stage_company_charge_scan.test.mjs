import test from 'node:test';
import assert from 'node:assert/strict';
import { stageCompanyChargeScan } from '../scripts/lib/stage_company_charge_scan.mjs';

function fixture(options = {}) {
  const queries = [];
  const client = {
    connectionParameters: { host: options.host || 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech', database: 'neondb' },
    release(destroy) { this.released = true; this.destroyed = destroy; },
    async query(sql, values) {
      queries.push({ sql, values });
      if (options.failSnapshot && sql.includes('INSERT INTO ccod_import.company_charge_scans')) throw Error('DB failure containing private detail');
      if (sql.includes('SELECT target_name')) return { rows: [{ target_name: options.badGuard ? 'wrong-target' : 'england-wales-property-test' }] };
      if (sql.includes('SELECT DISTINCT p.proprietor_name')) return { rows: options.outside ? [] : [{ proprietor_name: 'NAUTILINA LIMITED' }] };
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: !options.busy }] };
      return { rows: [], rowCount: 1 };
    }
  };
  let requests = 0;
  const request = async path => {
    requests++;
    if (!path.includes('/charges?')) return { company_number: '15372161', company_name: options.mismatch ? 'OTHER LIMITED' : 'Nautilina Limited' };
    if (options.requestFailure) throw Error('API request failed with secret details');
    return { items: options.partial ? [{ charge_number: 1, charge_code: '153721610001' }] : [], total_count: options.partial ? 2 : 0, start_index: 0 };
  };
  return { client, queries, request, pool: { connect: async () => client }, requestCount: () => requests };
}
const input = f => ({ companyNumber: '15372161', pool: f.pool, request: f.request, apply: true });

test('dry run performs no API calls or database connections', async () => {
  const result = await stageCompanyChargeScan({ companyNumber: '15372161' });
  assert.equal(result.executed, false); assert.equal(result.mode, 'dry_run');
});
test('complete zero-charge scan is staged and committed atomically', async () => {
  const f = fixture(); const result = await stageCompanyChargeScan(input(f));
  assert.equal(result.charges, 0); assert.equal(result.publishedToSearch, false);
  assert.equal(result.identityStatus, 'name_consistent_unverified');
  assert.ok(f.queries.some(q => q.sql === 'BEGIN')); assert.ok(f.queries.some(q => q.sql === 'COMMIT'));
  assert.equal(f.queries.some(q => /INSERT INTO public\.(charges|companies)/.test(q.sql)), false);
  assert.equal(f.client.released, true);
});
test('incomplete scan never writes a snapshot or successful state', async () => {
  const f = fixture({ partial: true });
  await assert.rejects(stageCompanyChargeScan({ ...input(f), maxPages: 1 }), /CHARGE_SCAN_FAILED/);
  assert.equal(f.queries.some(q => q.sql.includes('INSERT INTO ccod_import.company_charge_scans')), false);
  assert.ok(f.queries.some(q => q.sql.includes("SET status = 'failed'")));
});
test('snapshot write failure rolls back before failure status and preserves success pointer', async () => {
  const f = fixture({ failSnapshot: true });
  await assert.rejects(stageCompanyChargeScan(input(f)), /CHARGE_SCAN_FAILED/);
  const rollback = f.queries.findIndex(q => q.sql === 'ROLLBACK');
  const failure = f.queries.findIndex(q => q.sql.includes("SET status = 'failed'"));
  assert.ok(rollback >= 0 && failure > rollback);
  assert.equal(f.queries[failure].sql.includes('last_successful_scan_id'), false);
  assert.equal(f.queries.some(q => q.sql === 'COMMIT'), false);
});
test('wrong endpoint, guard, scope or busy company prevents network calls', async () => {
  for (const options of [{ host: 'wrong-host' }, { badGuard: true }, { outside: true }, { busy: true }]) {
    const f = fixture(options); await assert.rejects(stageCompanyChargeScan(input(f)));
    assert.equal(f.requestCount(), 0); assert.equal(f.client.released, true);
  }
});
test('company-name mismatch is blocked for review without fetching charges', async () => {
  const f = fixture({ mismatch: true });
  await assert.rejects(stageCompanyChargeScan(input(f)), /PROPRIETOR_NAME_REQUIRES_REVIEW/);
  assert.equal(f.requestCount(), 1);
});
test('request errors are sanitized and do not produce successful scans', async () => {
  const f = fixture({ requestFailure: true });
  await assert.rejects(stageCompanyChargeScan(input(f)), error => error.message === 'CHARGE_SCAN_FAILED');
  assert.equal(f.queries.some(q => q.sql.includes('INSERT INTO ccod_import.company_charge_scans')), false);
});
