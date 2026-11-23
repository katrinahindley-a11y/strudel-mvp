import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBudgetedClient, parseArgs, runManualImport } from '../scripts/run_company_charge_import.mjs';
import { safeChargeScanDiagnostic } from '../scripts/lib/charge_scan_diagnostics.mjs';

for (const [path, status, expected] of [
  ['/company/00000598', 404, 'COMPANY_PROFILE_NOT_FOUND'],
  ['/company/00000598/charges?items_per_page=100&start_index=0', 404, 'COMPANIES_HOUSE_HTTP_FAILURE'],
  ['/company/00000598', 500, 'COMPANIES_HOUSE_HTTP_FAILURE'],
  ['/company/00000598', 401, 'COMPANIES_HOUSE_AUTHENTICATION_FAILED'],
  ['/company/00000598', 403, 'COMPANIES_HOUSE_AUTHENTICATION_FAILED'],
  ['/company/00000598', 429, 'COMPANIES_HOUSE_RATE_LIMITED_STOP']
]) {
  test(`${path} HTTP ${status} yields ${expected}`, async () => {
    let calls = 0;
    const client = createBudgetedClient({ apiKey: 'test-only', companyNumber: '00000598', fetchFn: async () => {
      calls++;
      return { ok: false, status, json() { throw Error('DO_NOT_READ_ERROR_BODY'); } };
    }});
    await assert.rejects(client.request(path), error => error.message === expected);
    assert.equal(safeChargeScanDiagnostic(Error(expected)), expected);
    await assert.rejects(client.request(path), /REQUEST_CLIENT_HALTED/);
    assert.equal(calls, 1);
    assert.equal(client.requestsUsed(), 1);
  });
}
test('suffixes and unknown error text are still sanitised', () => {
  assert.equal(safeChargeScanDiagnostic(Error('COMPANY_PROFILE_NOT_FOUND: secret')), 'CHARGE_SCAN_FAILED');
});
test('numeric candidates and explicit prefixes remain unchanged', () => {
  for (const number of ['00000598', 'SG000598', 'SC000598']) {
    assert.equal(parseArgs(['--company', number]).companyNumber, number);
  }
});
test('dry-run remains side-effect free and preserves candidate', async () => {
  const result = await runManualImport(['--company', '00000598'], {}, {
    makePool() { throw Error('DATABASE_MUST_NOT_BE_OPENED'); }
  });
  assert.equal(result.companyNumber, '00000598');
  assert.equal(result.executed, false);
});
test('workflow exposes review outcome, safe HTTP fields and runs this regression suite', () => {
  const workflow = readFileSync(new URL('../.github/workflows/mayfair-charge-staging-batch.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes("'COMPANY_PROFILE_NOT_FOUND',"));
  assert.ok(workflow.includes("const identityReviewRequired = diagnostic === 'COMPANY_PROFILE_NOT_FOUND';"));
  assert.ok(workflow.includes('diagnostic, identityReviewRequired, ...httpDetails'));
  assert.ok(workflow.includes('tests/company_profile_not_found.test.mjs'));
  assert.ok(workflow.includes("'--max-pages', '10'"));
  assert.ok(workflow.includes("'--max-requests', '12'"));
});
