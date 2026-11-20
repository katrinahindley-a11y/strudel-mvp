import test from 'node:test';
import assert from 'node:assert/strict';
import { titleMentioned, securedPartyNames, parseLenderSearch } from '../netlify/lib/security_lender_matching.mjs';

test('matches explicit title numbers without matching longer identifiers', () => {
  assert.equal(titleMentioned('1 Hanover Square, title number LN48675.', 'LN48675'), true);
  assert.equal(titleMentioned('Title ln48675 and other land', 'LN48675'), true);
  assert.equal(titleMentioned('LN486750', 'LN48675'), false);
  assert.equal(titleMentioned('XLN48675', 'LN48675'), false);
  assert.equal(titleMentioned('LN48675X', 'LN48675'), false);
  assert.equal(titleMentioned('All land owned by the company', 'LN48675'), false);
  assert.equal(titleMentioned(null, 'LN48675'), false);
  assert.equal(titleMentioned('LN48675', '.*'), false);
});

test('normalizes Companies House secured parties', () => {
  assert.deepEqual(securedPartyNames([{ name: 'HSBC Private Bank (Suisse) SA' }, 'Other bank', { description: 'Security trustee' }, null]), ['HSBC Private Bank (Suisse) SA', 'Other bank', 'Security trustee']);
  assert.deepEqual(securedPartyNames(null), []);
});

test('defaults to outstanding charges and validates search parameters', () => {
  assert.deepEqual(parseLenderSearch(new URLSearchParams({ lender: ' HSBC ' })), { lender: 'HSBC', status: 'outstanding', page: 1, pageSize: 20, tenure: '' });
  assert.equal(parseLenderSearch(new URLSearchParams({ lender: 'HSBC', status: 'all', page: '2', tenure: 'Freehold' })).page, 2);
  for (const values of [{ lender: '' }, { lender: 'H' }, { lender: 'HSBC', status: 'invalid' }, { lender: 'HSBC', page: '0' }, { lender: 'HSBC', page: '1.5' }, { lender: 'HSBC', tenure: 'invalid' }]) {
    assert.throws(() => parseLenderSearch(new URLSearchParams(values)));
  }
});
