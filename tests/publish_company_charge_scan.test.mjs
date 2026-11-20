import test from 'node:test';
import assert from 'node:assert/strict';
import { planChargePublication, publishCompanyChargeScan } from '../scripts/lib/publish_company_charge_scan.mjs';
const charge = { charge_number: 1, charge_code: '153721610001', status: 'outstanding' };
const scanId = '11111111-1111-4111-8111-111111111111';

test('preserves legacy external IDs and produces an idempotent plan', () => {
  const stored = [{ external_charge_id: 'legacy-id', raw_data: charge }];
  const plan = planChargePublication([charge], stored);
  assert.equal(plan[0].externalId, 'legacy-id');
  assert.equal(planChargePublication([charge], stored)[0].externalId, 'legacy-id');
  assert.equal(planChargePublication([charge], [])[0].externalId, '1');
});
test('rejects duplicate, missing and ambiguous identifiers', () => {
  assert.throws(() => planChargePublication([charge, charge], []), /DUPLICATE_INCOMING_CHARGE/);
  assert.throws(() => planChargePublication([{}], []), /MISSING_CHARGE_IDENTIFIER/);
  assert.throws(() => planChargePublication([charge], [{ external_charge_id: '1' }, { external_charge_id: '153721610001' }]), /AMBIGUOUS_STORED_CHARGE/);
});
test('never silently removes previously stored charges', () => {
  assert.throws(() => planChargePublication([], [{ external_charge_id: '1' }]), /MISSING_FROM_SNAPSHOT/);
  assert.deepEqual(planChargePublication([], []), []);
});
function fixture(options = {}) {
  const queries = [];
  const client = {
    connectionParameters: { host: options.wrongHost ? 'wrong' : 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech', database: 'neondb' },
    release(destroy) { this.released = true; },
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('SELECT target_name')) return { rows: [{ target_name: 'england-wales-property-test' }] };
      if (sql.includes('SELECT s.*')) return { rows: options.stale ? [] : [{ company_profile: { company_number: '15372161', company_name: 'NAUTILINA LIMITED' }, charges: options.zero ? [] : [charge], records_seen: options.zero ? 0 : 1, completed_at: '2026-11-20T11:00:00Z' }] };
      if (sql.includes('SELECT DISTINCT p.proprietor_name')) return { rows: [{ proprietor_name: 'Nautilina Limited' }] };
      if (sql.includes('INSERT INTO public.companies')) return { rows: [{ id: 'company-id' }] };
      if (sql.includes('SELECT external_charge_id')) return { rows: options.missing ? [{ external_charge_id: '99' }] : [] };
      if (sql.includes('INSERT INTO public.charges') && options.failCharge) throw Error('Private DB error');
      return { rows: [], rowCount: 1 };
    }
  };
  return { client, queries, pool: { connect: async () => client } };
}
const input = f => ({ companyNumber: '15372161', scanId, pool: f.pool, apply: true });
test('dry run does not require a database connection', async () => {
  const result = await publishCompanyChargeScan({ companyNumber: '15372161', scanId });
  assert.equal(result.executed, false);
});
test('successful publication commits charges and marker using the scan timestamp', async () => {
  const f = fixture(); const result = await publishCompanyChargeScan(input(f));
  assert.equal(result.charges, 1); assert.equal(result.identityStatus, 'name_consistent_unverified');
  assert.ok(f.queries.some(q => q.sql === 'COMMIT'));
  const write = f.queries.find(q => q.sql.includes('INSERT INTO public.charges'));
  assert.equal(write.values[9], '2026-11-20T11:00:00Z');
  assert.equal(f.queries.some(q => /DELETE FROM/.test(q.sql)), false);
});
test('zero-charge publication records success without inventing a charge', async () => {
  const f = fixture({ zero: true }); const result = await publishCompanyChargeScan(input(f));
  assert.equal(result.charges, 0);
  assert.equal(f.queries.some(q => q.sql.includes('INSERT INTO public.charges')), false);
  assert.ok(f.queries.some(q => q.sql.includes('SET last_published_scan_id')));
});
test('missing stored records or a failed write rolls the whole publication back', async () => {
  for (const options of [{ missing: true }, { failCharge: true }]) {
    const f = fixture(options); await assert.rejects(publishCompanyChargeScan(input(f)));
    assert.ok(f.queries.some(q => q.sql === 'ROLLBACK'));
    assert.equal(f.queries.some(q => q.sql === 'COMMIT'), false);
    assert.equal(f.client.released, true);
  }
});
test('wrong host and non-current scans are rejected before public writes', async () => {
  for (const options of [{ wrongHost: true }, { stale: true }]) {
    const f = fixture(options); await assert.rejects(publishCompanyChargeScan(input(f)));
    assert.equal(f.queries.some(q => q.sql.includes('INSERT INTO public.')), false);
  }
});
