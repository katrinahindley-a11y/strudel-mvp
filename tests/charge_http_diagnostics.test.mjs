import test from 'node:test';
import assert from 'node:assert/strict';
import { createChargeHttpDiagnostics } from '../scripts/lib/charge_http_diagnostics.mjs';

for (const [path, requestCategory] of [
  ['/company/00000598', 'company_profile'],
  ['/company/00000598/charges?items_per_page=100&start_index=0', 'charges']
]) {
  for (const status of [400, 401, 403, 404, 429, 500, 503, 599]) {
    test(`captures only safe fields for ${requestCategory} ${status}`, async () => {
      const response = { ok: false, status, json() { throw Error('BODY_MUST_NOT_BE_READ'); } };
      const init = { headers: { Authorization: 'secret' } };
      const client = createChargeHttpDiagnostics('00000598', async (url, options) => {
        assert.equal(url, 'https://api.company-information.service.gov.uk' + path);
        assert.equal(options, init);
        return response;
      });
      assert.equal(await client.fetchFn('https://api.company-information.service.gov.uk' + path, init), response);
      assert.deepEqual(client.failureDetails(), { httpStatus: status, requestCategory });
      const copy = client.failureDetails(); copy.httpStatus = 'secret';
      assert.equal(client.failureDetails().httpStatus, status);
    });
  }
}
test('rejects untrusted endpoints and invalid statuses from diagnostic output', async () => {
  for (const url of ['https://example.com/company/00000598', 'https://api.company-information.service.gov.uk/company/00000001', 'https://api.company-information.service.gov.uk/company/00000598/other', 'https://secret@api.company-information.service.gov.uk/company/00000598']) {
    const client = createChargeHttpDiagnostics('00000598', async () => ({ ok: false, status: 404 }));
    await client.fetchFn(url);
    assert.deepEqual(client.failureDetails(), {});
  }
  for (const status of [null, '404', 399, 600, 404.5]) {
    const client = createChargeHttpDiagnostics('00000598', async () => ({ ok: false, status }));
    await client.fetchFn('https://api.company-information.service.gov.uk/company/00000598');
    assert.deepEqual(client.failureDetails(), {});
  }
});
test('network exceptions remain unchanged and clear stale HTTP metadata', async () => {
  const error = Error('private transport failure'); let calls = 0;
  const client = createChargeHttpDiagnostics('00000598', async () => {
    if (calls++) throw error;
    return { ok: false, status: 503 };
  });
  await client.fetchFn('https://api.company-information.service.gov.uk/company/00000598');
  await assert.rejects(client.fetchFn('https://api.company-information.service.gov.uk/company/00000598'), value => value === error);
  assert.deepEqual(client.failureDetails(), {});
});
test('successful responses clear metadata without consuming the body', async () => {
  let calls = 0;
  const client = createChargeHttpDiagnostics('00000598', async () => ({ ok: calls++ > 0, status: calls === 1 ? 503 : 200 }));
  await client.fetchFn('https://api.company-information.service.gov.uk/company/00000598');
  await client.fetchFn('https://api.company-information.service.gov.uk/company/00000598');
  assert.deepEqual(client.failureDetails(), {});
});
