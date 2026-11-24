import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createIdentityProposal} from '../scripts/lib/company_identity_review.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function latch(){let release;const promise=new Promise(r=>{release=r;});return {promise,release};}
async function within(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('BATCH_TEST_TIMEOUT')),5000);})]);}finally{clearTimeout(timer);}}
test('reviewed batches use actual PostgreSQL, staging and HTTP client',{skip:process.env.RUN_REVIEWED_BATCH_POSTGRES!=='1',timeout:120000},async t=>{
  if(process.env.GITHUB_ACTIONS!=='true')throw Error('GITHUB_ACTIONS_ONLY');
  const u=new URL(process.env.CHARGE_CI_DATABASE_URL||'');
  if(u.protocol!=='postgresql:'||u.hostname!=='localhost'||u.port!=='5432'||u.pathname!=='/neondb'||u.username!=='charge_ci'||u.search||u.hash)throw Error('DISPOSABLE_DATABASE_REQUIRED');
  globalThis.fetch=async()=>{throw Error('LIVE_NETWORK_DISABLED');};
  const {default:pg}=await import('pg'),pools=[];
  function pool(user,password){const x=new URL(u);if(user){x.username=user;x.password=password;}const p=new pg.Pool({connectionString:x.toString(),max:4,connectionTimeoutMillis:5000,statement_timeout:10000});pools.push(p);return p;}
  const owner=pool(),reviewer=pool('identity_ci_reviewer','disposable_reviewer_only'),scanner=pool('identity_ci_scanner','disposable_scanner_only');
  const dir=await mkdtemp(join(tmpdir(),'reviewed-batch-pg-'));
  const numbers=['SC001234','SC001235'];
  const profile=n=>({company_number:n,company_name:n===numbers[0]?'SYNTHETIC LIMITED':'SECOND SYNTHETIC LIMITED',type:'ltd'});
  try{
    assert.equal((await owner.query("SELECT enabled FROM ccod_import.identity_review_principals WHERE database_login='identity_ci_reviewer'")).rows[0]?.enabled,true,'Run reviewed_charge_postgres fixture suite first');
    await owner.query("INSERT INTO public.property_titles VALUES('SYNTH2','CCOD','2026-11-01',6000000);INSERT INTO public.property_proprietors VALUES('SYNTH2',1,'SECOND SYNTHETIC LIMITED','001235','00001235');INSERT INTO ccod_import.refresh_membership VALUES('SYNTH2',true,true,'2026-11-01');");
    await mkdir(join(dir,'lib'));
    for(const file of ['reviewed_charge_batch.mjs','stage_company_charge_scan.mjs','company_identity_store.mjs','company_identity_review.mjs','collect_company_charges.mjs','charge_scan_diagnostics.mjs']){
      let s=await readFile('scripts/lib/'+file,'utf8');
      if(file==='stage_company_charge_scan.mjs'){const marker="const HOST = 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech';";assert.equal(s.split(marker).length,2);s=s.replace(marker,"const HOST = 'localhost';");}
      if(file==='reviewed_charge_batch.mjs'){const marker="connectionParameters?.host!=='ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech'";assert.equal(s.split(marker).length,2);s=s.replace(marker,"connectionParameters?.host!=='localhost'");}
      await writeFile(join(dir,'lib',file),s);
    }
    await writeFile(join(dir,'run_company_charge_import.mjs'),await readFile('scripts/run_company_charge_import.mjs','utf8'));
    const {runReviewedChargeBatch:run}=await import(pathToFileURL(join(dir,'lib/reviewed_charge_batch.mjs')));
    async function entry(n,{approved=true,expiryPurpose=null}={}){
      const observedAt=new Date().toISOString(),i=n===numbers[0]?1:2;
      const source={dataset:'CCOD',release:'2026-11-01',titleNumber:'SYNTH'+i,proprietorPosition:'1',proprietorName:profile(n).company_name,registrationRaw:i===1?'001234':'001235',candidateNumber:i===1?'00001234':'00001235'};
      const proposal=createIdentityProposal({source,reason:'prefix_missing',target:{registry:'companies_house',identifier:n,legalName:profile(n).company_name},evidence:[{kind:'register_identity',url:'https://find-and-update.company-information.service.gov.uk/company/'+n,observedAt,note:'Synthetic only'},{kind:'property_entity_link',url:'https://example.invalid/'+source.titleNumber,observedAt,note:'Synthetic only'}]});
      const id=randomUUID();await owner.query('INSERT INTO ccod_import.identity_review_proposals(id,proposal_hash,payload,profile_evidence,profile_observed_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)',[id,proposal.proposalHash,JSON.stringify(proposal),JSON.stringify(profile(n)),observedAt]);
      if(approved)for(const purpose of ['identity','scan'])await reviewer.query("SELECT ccod_import.append_identity_review_event($1,$2,$3,'approve','Synthetic batch',clock_timestamp()+$4::interval)",[id,proposal.proposalHash,purpose,purpose===expiryPurpose?'1500 milliseconds':'1 hour']);
      return {companyNumber:n,proposalId:id,proposalHash:proposal.proposalHash};
    }
    const manifest=async()=>Promise.all(numbers.map(n=>entry(n)));
    const count=async()=>(await owner.query('SELECT count(*)::int AS n FROM ccod_import.company_charge_scans')).rows[0].n;
    const state=async n=>(await owner.query('SELECT status,last_successful_scan_id,last_published_scan_id FROM ccod_import.company_charge_scan_state WHERE company_number=$1',[n])).rows;
    function transport({status=200,enter=null,resume=null}={}){const calls=[];return {calls,fetchFn:async raw=>{
      const url=new URL(raw);assert.equal(url.origin,'https://api.company-information.service.gov.uk');const n=url.pathname.split('/')[2];assert.ok(numbers.includes(n));calls.push(url.pathname);
      if(enter){enter.release();await resume.promise;}
      const body=url.pathname.endsWith('/charges')?{items:[{charge_code:'SYNTH-'+n,charge_number:1,status:'outstanding',persons_entitled:[{name:'SYNTHETIC LENDER'}]}],total_count:1,start_index:0}:profile(n);
      return {ok:status===200,status,json:async()=>{assert.equal(status,200,'Error body must not be consumed');return body;}};
    }};}
    const options=entries=>({entries,maxCompanies:2,maxRequests:8,maxPages:1,maxRunMs:60000,apply:true,apiKey:'synthetic-only',pool:scanner});
    await t.test('two approved companies stage and bind without public writes',async()=>{
      const before=await count(),http=transport(),r=await run(options(await manifest()),{fetchFn:http.fetchFn});assert.equal(r.status,'complete');assert.equal(r.requestsUsed,4);assert.equal(http.calls.length,4);assert.equal(r.results.length,2);assert.equal(r.publishedToSearch,false);assert.equal(await count(),before+2);
      for(const x of r.results)assert.equal((await owner.query('SELECT count(*)::int AS n FROM ccod_import.identity_review_scan_bindings WHERE scan_id=$1',[x.scanId])).rows[0].n,1);
      assert.deepEqual((await owner.query("SELECT to_regclass('public.charges') AS charges,to_regclass('public.companies') AS companies")).rows[0],{charges:null,companies:null});
    });
    await t.test('unapproved manifest entry blocks actual staging before HTTP',async()=>{
      const entries=[await entry(numbers[0],{approved:false}),await entry(numbers[1])],http=transport(),before=await count(),r=await run(options(entries),{fetchFn:http.fetchFn});assert.equal(r.results[0].diagnostic,'IDENTITY_REVIEW_NOT_APPROVED');assert.equal(http.calls.length,0);assert.deepEqual(r.pending,[numbers[1]]);assert.equal(await count(),before);
    });
    await t.test('real batch lock rejects a competing runner and releases afterward',async()=>{
      const entries=await manifest(),entered=latch(),resume=latch(),http=transport({enter:entered,resume});
      const first=run(options(entries),{fetchFn:http.fetchFn}).then(value=>({value}),error=>({error}));let outcome;
      try{await within(Promise.race([entered.promise,first.then(r=>{throw r.error||Error('FIRST_BATCH_FINISHED');})]));const secondHttp=transport();await assert.rejects(run(options(await manifest()),{fetchFn:secondHttp.fetchFn}),/BATCH_ALREADY_RUNNING/);assert.equal(secondHttp.calls.length,0);}finally{resume.release();outcome=await first;}
      if(outcome.error)throw outcome.error;assert.equal(outcome.value.status,'complete');
      const c=await owner.connect();try{assert.equal((await c.query("SELECT pg_try_advisory_lock(hashtextextended('ccod-reviewed-charge-batch-api',0)) AS acquired")).rows[0].acquired,true);await c.query("SELECT pg_advisory_unlock(hashtextextended('ccod-reviewed-charge-batch-api',0))");}finally{c.release();}
    });
    await t.test('second-company snapshot failure rolls back only its own transaction',async()=>{
      const before=await count(),prior=await state(numbers[1]),http=transport();
      const broken={async connect(){const c=await scanner.connect();return {connectionParameters:c.connectionParameters,release:d=>c.release(d),query:(sql,args)=>{if(sql.includes('INSERT INTO ccod_import.company_charge_scans')&&args?.[1]===numbers[1])throw Error('INJECTED_PRIVATE_DATABASE_ERROR');return c.query(sql,args);}};}};
      const r=await run({...options(await manifest()),pool:broken},{fetchFn:http.fetchFn});assert.equal(r.results[0].status,'staged');assert.equal(r.results[1].diagnostic,'CHARGE_SCAN_FAILED');assert.equal(await count(),before+1);assert.deepEqual(await state(numbers[1]),prior);assert.equal(JSON.stringify(r).includes('PRIVATE'),false);
    });
    await t.test('global request budget survives actual transport and preserves prior company',async()=>{
      const before=await count(),prior=await state(numbers[1]),http=transport(),r=await run({...options(await manifest()),maxRequests:3},{fetchFn:http.fetchFn});assert.equal(r.results[0].status,'staged');assert.equal(r.results[1].diagnostic,'BATCH_REQUEST_BUDGET_EXHAUSTED');assert.equal(http.calls.length,3);assert.equal(r.requestsUsed,3);assert.equal(await count(),before+1);assert.deepEqual(await state(numbers[1]),prior);
    });
    for(const status of [429,401,403])await t.test('actual HTTP '+status+' stops before the next company',async()=>{
      const before=await count(),http=transport({status}),r=await run(options(await manifest()),{fetchFn:http.fetchFn});assert.equal(http.calls.length,1);assert.equal(r.results[0].diagnostic,status===429?'COMPANIES_HOUSE_RATE_LIMITED_STOP':'COMPANIES_HOUSE_AUTHENTICATION_FAILED');assert.deepEqual(r.pending,[numbers[1]]);assert.equal(await count(),before);
    });
    for(const purpose of ['identity','scan'])await t.test(purpose+' approval expiring during pacing prevents the charge request',async()=>{
      const before=await count(),prior=await state(numbers[0]),entries=[await entry(numbers[0],{expiryPurpose:purpose}),await entry(numbers[1])],http=transport();
      const r=await run(options(entries),{fetchFn:http.fetchFn,sleep:ms=>pause(Math.max(ms,700))});assert.equal(r.results[0].diagnostic,'IDENTITY_REVIEW_EXPIRED');assert.equal(http.calls.length,1);assert.equal(r.requestsUsed,1);assert.equal(await count(),before);assert.deepEqual(await state(numbers[0]),prior);
    });
  }finally{await Promise.all(pools.map(p=>p.end()));await rm(dir,{recursive:true,force:true});}
});
