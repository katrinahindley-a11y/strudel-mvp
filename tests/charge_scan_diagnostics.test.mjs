import test from 'node:test';
import assert from 'node:assert/strict';
import { safeChargeScanDiagnostic } from '../scripts/lib/charge_scan_diagnostics.mjs';
import { stageCompanyChargeScan } from '../scripts/lib/stage_company_charge_scan.mjs';

const cases = [
  ['Invalid charges page', 'CHARGE_PAGE_INVALID'],
  ['Unexpected charge pagination', 'CHARGE_PAGINATION_INVALID'],
  ['Charge total availability changed during scan', 'CHARGE_TOTAL_AVAILABILITY_CHANGED'],
  ['Invalid charge total', 'CHARGE_TOTAL_INVALID'],
  ['Charge total changed during scan; retry from the beginning', 'CHARGE_TOTAL_CHANGED'],
  ['Invalid charge record', 'CHARGE_RECORD_INVALID'],
  ['Charge has no stable identifier', 'CHARGE_IDENTIFIER_MISSING'],
  ['Duplicate charge encountered across scan; retry from the beginning', 'CHARGE_DUPLICATE_RECORD'],
  ['Charge count exceeds reported total', 'CHARGE_COUNT_EXCEEDS_TOTAL'],
  ['Charges ended before the reported total', 'CHARGE_PAGE_ENDED_EARLY'],
  ['Charge page budget exhausted; scan is incomplete', 'CHARGE_PAGE_BUDGET_EXHAUSTED']
];
for (const [message, code] of cases) {
  test(`maps collector error to ${code}`, () => assert.equal(safeChargeScanDiagnostic(Error(message)), code));
}
for (const code of [
  'TARGET_GUARD_FAILED', 'COMPANY_OUTSIDE_APPROVED_SCOPE', 'COMPANY_SCAN_ALREADY_RUNNING',
  'UNAPPROVED_DATABASE_ENDPOINT', 'COMPANY_IDENTITY_MISMATCH', 'PROPRIETOR_NAME_REQUIRES_REVIEW',
  'INCOMPLETE_CHARGE_SCAN', 'SCAN_OWNERSHIP_LOST', 'REQUEST_BUDGET_EXHAUSTED',
  'COMPANIES_HOUSE_RATE_LIMITED_STOP', 'COMPANIES_HOUSE_AUTHENTICATION_FAILED',
  'COMPANIES_HOUSE_HTTP_FAILURE', 'COMPANIES_HOUSE_REQUEST_FAILED',
  'COMPANIES_HOUSE_INVALID_JSON', 'UNAPPROVED_API_ENDPOINT', 'INVALID_API_PARAMETERS'
]) {
  test(`preserves ${code}`, () => assert.equal(safeChargeScanDiagnostic(Error(code)), code));
}
test('unknown errors and sensitive suffixes remain sanitised', () => {
  for (const error of [null, undefined, 'secret', {}, { message: 42 }, Error('postgres://user:password@host/db'),
    Error('COMPANIES_HOUSE_HTTP_FAILURE: secret'), Error('Invalid charges page: raw body')]) {
    assert.equal(safeChargeScanDiagnostic(error), 'CHARGE_SCAN_FAILED');
  }
});

function mockPool() {
  const queries = [];
  const client = {
    connectionParameters: { host: 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech', database: 'neondb' },
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('SELECT target_name')) return { rows: [{ target_name: 'england-wales-property-test' }] };
      if (sql.includes('SELECT DISTINCT p.proprietor_name')) return { rows: [{ proprietor_name: 'Example Limited' }] };
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  return { queries, connect: async () => client };
}
for (const [message, expected] of [
  ['COMPANIES_HOUSE_RATE_LIMITED_STOP', 'COMPANIES_HOUSE_RATE_LIMITED_STOP'],
  ['private error containing credentials', 'CHARGE_SCAN_FAILED']
]) {
  test(`stage persists and rethrows only ${expected}`, async () => {
    const pool = mockPool();
    await assert.rejects(stageCompanyChargeScan({ companyNumber: '00000598', pool, apply: true,
      request: async () => { throw Error(message); } }), error => error.message === expected);
    const failed = pool.queries.find(q => q.sql.includes("SET status = 'failed'"));
    assert.equal(failed.params[2], expected);
    assert.equal(pool.queries.some(q => q.sql.includes('INSERT INTO ccod_import.company_charge_scans')), false);
  });
}
test('collector validation survives the staging catch without accepting a snapshot', async () => {
  const pool = mockPool();
  await assert.rejects(stageCompanyChargeScan({ companyNumber: '00000598', pool, apply: true,
    request: async path => path.includes('/charges?') ? { items: [{}], total_count: 1 } :
      { company_number: '00000598', company_name: 'Example Limited' }
  }), error => error.message === 'CHARGE_IDENTIFIER_MISSING');
  const failed = pool.queries.find(q => q.sql.includes("SET status = 'failed'"));
  assert.equal(failed.params[2], 'CHARGE_IDENTIFIER_MISSING');
  assert.equal(pool.queries.some(q => q.sql.includes('INSERT INTO ccod_import.company_charge_scans')), false);
});
test('dry run still performs no database or API work', async () => {
  const result = await stageCompanyChargeScan({ companyNumber: '00000598' });
  assert.equal(result.executed, false);
});
