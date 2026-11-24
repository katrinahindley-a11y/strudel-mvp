import test from 'node:test';
import assert from 'node:assert/strict';
import {planReviewedBatch,runReviewedChargeBatch} from '../scripts/lib/reviewed_charge_batch.mjs';
import {parseBatchArgs} from '../scripts/run_reviewed_charge_batch.mjs';
const entry=n=>({companyNumber:n,proposalId:'10000000-0000-4000-8000-000000000001',proposalHash:'a'.repeat(64)});
const options=()=>({entries:[entry('SC001234'),entry('SC001235')],maxCompanies:2,maxRequests:4,maxPages:1,maxRunMs:60000});
function fixture(c={}){
  let now=0,fetches=0,stages=0,released=false,cleared=false;const starts=[],queries=[];
  const client={connectionParameters:{host:c.wrongHost?'wrong':'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech',database:'neondb'},release(){released=true;},async query(sql){queries.push(sql);if(sql.includes('SELECT target_name'))return {rows:[{target_name:c.badGuard?'wrong':'england-wales-property-test'}]};if(sql.includes('pg_try_advisory_lock'))return {rows:[{acquired:!c.busy}]};return {rows:[{released:!c.unlockFailure}]};}};
  const deps={clock:()=>now,sleep:async ms=>{now+=ms;},fetchFn:async()=>{starts.push(now);fetches++;if(c.networkError)throw Error('private network detail');return {ok:!c.httpStatus,status:c.httpStatus||200,json:async()=>({})};},stage:async({companyNumber,request,identityReview,maxPages,registerBeforeDispatch})=>{
    stages++;assert.equal(identityReview.proposalHash,'a'.repeat(64));assert.equal(maxPages,1);if(c.reviewDenied)throw Error('IDENTITY_REVIEW_EXPIRED');if(c.privateFailure)throw Error('private credential');
    if(!c.noHook)registerBeforeDispatch(async()=>{if(c.expireReview&&now>0)throw Error('IDENTITY_REVIEW_EXPIRED');});
    try{await request('/company/'+companyNumber);if(c.expire)now=70000;await request('/company/'+companyNumber+'/charges');return {scanId:'synthetic-'+stages,charges:0,pagesFetched:1};}finally{registerBeforeDispatch(null);cleared=true;}
  }};
  return {pool:{connect:async()=>client},deps,starts,queries,counts:()=>({fetches,stages,released,cleared})};
}
const run=(f,o={})=>runReviewedChargeBatch({...options(),...o,apply:true,apiKey:'synthetic',pool:f.pool},f.deps);
test('dry-run uses no credentials, database or API',async()=>{const r=await runReviewedChargeBatch(options());assert.equal(r.executed,false);assert.equal(r.publishedToSearch,false);});
for(const key of ['maxCompanies','maxRequests','maxPages','maxRunMs'])test('explicit budget required: '+key,()=>{const o=options();delete o[key];assert.throws(()=>planReviewedBatch(o),/INVALID_BATCH_BUDGET/);});
test('prefixed numbers preserved and duplicates rejected',()=>{const o=options();assert.equal(planReviewedBatch(o).entries[0].companyNumber,'SC001234');o.entries[1]=o.entries[0];assert.throws(()=>planReviewedBatch(o),/DUPLICATE_BATCH_COMPANY/);});
test('approval override fields rejected',()=>{const o=options();o.entries[0].approved=true;assert.throws(()=>planReviewedBatch(o),/UNEXPECTED_BATCH_FIELD/);});
test('malformed reference rejected',()=>{const o=options();o.entries[0].proposalHash='bad';assert.throws(()=>planReviewedBatch(o),/INVALID_BATCH_MANIFEST/);});
test('company budget enforced',()=>{const o=options();o.maxCompanies=1;assert.throws(()=>planReviewedBatch(o),/INVALID_BATCH_MANIFEST/);});
test('actual HTTP client preserves cross-company pacing and never publishes',async()=>{const f=fixture(),r=await run(f);assert.equal(r.status,'complete');assert.equal(r.requestsUsed,4);assert.equal(r.results.length,2);assert.equal(r.publishedToSearch,false);assert.deepEqual(f.starts,[0,1100,2200,3300]);assert.equal(f.counts().released,true);assert.equal(f.counts().cleared,true);assert.ok(f.queries.some(q=>q.includes('pg_advisory_unlock')));});
test('batch request diagnostic survives actual client exception sanitisation',async()=>{const f=fixture(),r=await run(f,{maxRequests:3});assert.equal(r.status,'stopped');assert.equal(r.requestsUsed,3);assert.equal(r.results[1].diagnostic,'BATCH_REQUEST_BUDGET_EXHAUSTED');assert.equal(f.counts().fetches,3);});
test('batch time diagnostic survives actual HTTP client',async()=>{const f=fixture({expire:true}),r=await run(f);assert.equal(r.results[0].diagnostic,'BATCH_TIME_BUDGET_EXHAUSTED');assert.equal(f.counts().fetches,1);assert.deepEqual(r.pending,['SC001235']);});
test('review denial makes no HTTP request',async()=>{const f=fixture({reviewDenied:true}),r=await run(f);assert.equal(r.results[0].diagnostic,'IDENTITY_REVIEW_EXPIRED');assert.equal(f.counts().fetches,0);assert.equal(f.counts().stages,1);assert.deepEqual(r.pending,['SC001235']);});
test('private errors stay sanitised',async()=>{const f=fixture({privateFailure:true}),r=await run(f);assert.equal(r.results[0].diagnostic,'CHARGE_SCAN_FAILED');assert.equal(JSON.stringify(r).includes('credential'),false);});
for(const c of [{wrongHost:true},{badGuard:true},{busy:true}])test('guard prevents staging '+JSON.stringify(c),async()=>{const f=fixture(c);await assert.rejects(run(f));assert.equal(f.counts().fetches,0);assert.equal(f.counts().stages,0);assert.equal(f.counts().released,true);});
test('CLI requires budgets and rejects unknown flags',()=>{const a=['--manifest','synthetic.json','--max-companies','2','--max-requests','4','--max-pages','1','--max-run-ms','60000'];assert.equal(parseBatchArgs(a).apply,false);assert.throws(()=>parseBatchArgs([...a,'--publish']),/INVALID_BATCH_ARGUMENTS/);assert.throws(()=>parseBatchArgs(['--manifest','synthetic.json']),/INVALID_BATCH_BUDGET/);});
for(const status of [429,401,403])test('actual HTTP '+status+' stops the batch',async()=>{const f=fixture({httpStatus:status}),r=await run(f);assert.equal(r.results[0].diagnostic,status===429?'COMPANIES_HOUSE_RATE_LIMITED_STOP':'COMPANIES_HOUSE_AUTHENTICATION_FAILED');assert.equal(f.counts().fetches,1);assert.deepEqual(r.pending,['SC001235']);});
test('actual client transport errors remain sanitised',async()=>{const f=fixture({networkError:true}),r=await run(f);assert.equal(r.results[0].diagnostic,'COMPANIES_HOUSE_REQUEST_FAILED');assert.equal(JSON.stringify(r).includes('private'),false);});
test('review expiry after pacing blocks dispatch and preserves its diagnostic',async()=>{const f=fixture({expireReview:true}),r=await run(f);assert.equal(f.counts().fetches,1);assert.equal(r.requestsUsed,1);assert.equal(r.results[0].diagnostic,'IDENTITY_REVIEW_EXPIRED');});
test('missing staging dispatch hook fails closed',async()=>{const f=fixture({noHook:true}),r=await run(f);assert.equal(f.counts().fetches,0);assert.equal(r.results[0].diagnostic,'BATCH_DISPATCH_AUTHORIZATION_REQUIRED');});
test('failed advisory unlock marks cleanup warning',async()=>{const f=fixture({unlockFailure:true,reviewDenied:true}),r=await run(f);assert.equal(r.cleanupWarning,true);assert.equal(f.counts().released,true);});
