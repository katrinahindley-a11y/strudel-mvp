import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCompanyCharges } from '../scripts/lib/collect_company_charges.mjs';

const charge = number => ({ charge_number: number, charge_code: 'code-' + number, status: 'outstanding' });

test('collects all pages with explicit offsets and completion metadata', async () => {
  const paths = []; const progress = [];
  const pages = [{ items: [charge(1), charge(2)], start_index: 0, total_count: 3 }, { items: [charge(3)], start_index: 2, total_count: 3 }];
  const result = await collectCompanyCharges('15372161', async path => { paths.push(path); return pages.shift(); }, { itemsPerPage: 2, onPage: async value => progress.push(value) });
  assert.equal(result.charges.length, 3); assert.equal(result.scanComplete, true); assert.equal(result.pagesFetched, 2);
  assert.match(paths[1], /start_index=2/); assert.equal(progress[0].complete, false); assert.equal(progress[1].complete, true);
});

test('records a genuine zero-charge scan as complete', async () => {
  const result = await collectCompanyCharges('15372161', async () => ({ items: [], start_index: 0, total_count: 0 }));
  assert.equal(result.scanComplete, true); assert.deepEqual(result.charges, []);
});

test('without a total, requires an empty terminal page', async () => {
  let calls = 0;
  const result = await collectCompanyCharges('15372161', async () => ++calls === 1 ? { items: [charge(1)] } : { items: [] });
  assert.equal(calls, 2); assert.equal(result.charges.length, 1);
});

test('does not return partial data when the page budget is exhausted', async () => {
  await assert.rejects(collectCompanyCharges('15372161', async () => ({ items: [charge(1)], total_count: 2 }), { maxPages: 1 }), /incomplete/);
});

test('rejects duplicate charges, inconsistent totals and incorrect offsets', async () => {
  for (const second of [
    { items: [charge(1)], total_count: 2, start_index: 1 },
    { items: [charge(2)], total_count: 3, start_index: 1 },
    { items: [charge(2)], total_count: 2, start_index: 0 }
  ]) {
    const pages = [{ items: [charge(1)], total_count: 2, start_index: 0 }, second];
    await assert.rejects(collectCompanyCharges('15372161', async () => pages.shift()));
  }
});

test('rejects an empty page before the reported total and missing stable IDs', async () => {
  await assert.rejects(collectCompanyCharges('15372161', async () => ({ items: [], total_count: 1 })), /before the reported total/);
  await assert.rejects(collectCompanyCharges('15372161', async () => ({ items: [{}], total_count: 1 })), /stable identifier/);
});

test('propagates request failures without returning a completed snapshot', async () => {
  await assert.rejects(collectCompanyCharges('15372161', async () => { throw Error('HTTP 429'); }), /HTTP 429/);
});

test('validates inputs before issuing requests', async () => {
  let calls = 0; const request = async () => { calls++; return { items: [], total_count: 0 }; };
  await assert.rejects(collectCompanyCharges('../invalid', request));
  await assert.rejects(collectCompanyCharges('15372161', request, { maxPages: 0 }));
  await assert.rejects(collectCompanyCharges('15372161', request, { itemsPerPage: 101 }));
  assert.equal(calls, 0);
});
