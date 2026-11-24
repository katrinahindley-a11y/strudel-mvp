import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createBudgetedClient,parseArgs,runManualImport} from '../scripts/run_company_charge_import.mjs';
import {safeChargeScanDiagnostic} from '../scripts/lib/charge_scan_diagnostics.mjs';
for(const [path,status,expected] of [['/company/00000598',404,'COMPANY_PROFILE_NOT_FOUND'],['/company/00000598/charges?items_per_page=100&start_index=0',404,'COMPANIES_HOUSE_HTTP_FAILURE'],['/company/00000598',500,'COMPANIES_HOUSE_HTTP_FAILURE'],['/company/00000598',401,'COMPANIES_HOUSE_AUTHENTICATION_FAILED'],['/company/00000598',403,'COMPANIES_HOUSE_AUTHENTICATION_FAILED'],['/company/00000598',429,'COMPANIES_HOUSE_RATE_LIMITED_STOP']])test(path+' HTTP '+status+' yields '+expected,async()=>{
  let calls=0;const c=createBudgetedClient({apiKey:'test-only',companyNumber:'00000598',fetchFn:async()=>{calls++;return {ok:false,status,json(){throw Error('DO_NOT_READ_ERROR_BODY');}};}});
  await assert.rejects(c.request(path),e=>e.message===expected);assert.equal(safeChargeScanDiagnostic(Error(expected)),expected);await assert.rejects(c.request(path),/REQUEST_CLIENT_HALTED/);assert.equal(calls,1);assert.equal(c.requestsUsed(),1);
});
test('suffixes remain sanitised',()=>assert.equal(safeChargeScanDiagnostic(Error('COMPANY_PROFILE_NOT_FOUND: secret')),'CHARGE_SCAN_FAILED'));
test('numeric candidates and explicit prefixes remain unchanged',()=>{for(const n of ['00000598','SG000598','SC000598'])assert.equal(parseArgs(['--company',n]).companyNumber,n);});
test('dry-run remains offline and preserves candidate',async()=>{const r=await runManualImport(['--company','00000598'],{},{makePool(){throw Error('DATABASE_MUST_NOT_BE_OPENED');}});assert.equal(r.companyNumber,'00000598');assert.equal(r.executed,false);});
for(const [file,name] of [['mayfair-charge-staging-batch.yml','Mayfair charge staging batch'],['mayfair-charge-publish-batch.yml','Mayfair charge publication batch'],['nautilina-charge-staging-pilot.yml','Nautilina charge staging pilot'],['nautilina-charge-publication.yml','Nautilina reviewed snapshot publication']])test(file+' contains only the explicit hold job',()=>{
  const expected=`name: ${name} (ON HOLD)
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  hold:
    runs-on: ubuntu-latest
    steps:
      - name: Refuse live staging or publication
        run: |
          echo 'CHARGE_OPERATIONS_ON_HOLD: separate rollout approval is required.'
          exit 1
`;
  assert.equal(readFileSync(new URL('../.github/workflows/'+file,import.meta.url),'utf8'),expected);
});
