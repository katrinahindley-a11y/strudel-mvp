import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
test('profile qualification reads real scope but writes no approvals',{skip:process.env.RUN_PROFILE_QUALIFICATION_POSTGRES!=='1'},async t=>{
  if(process.env.GITHUB_ACTIONS!=='true')throw Error('GITHUB_ACTIONS_ONLY');const u=new URL(process.env.CHARGE_CI_DATABASE_URL||'');
  if(u.protocol!=='postgresql:'||u.hostname!=='localhost'||u.port!=='5432'||u.pathname!=='/neondb'||u.username!=='charge_ci'||u.search||u.hash)throw Error('DISPOSABLE_DATABASE_REQUIRED');
  globalThis.fetch=async()=>{throw Error('LIVE_NETWORK_DISABLED');};const {default:pg}=await import('pg'),pool=new pg.Pool({connectionString:u.toString(),max:2,statement_timeout:10000});const dir=await mkdtemp(join(tmpdir(),'profile-shadow-pg-'));
  try{
    // Previous planner suite intentionally leaves the review schema absent.
    assert.equal((await pool.query("SELECT to_regclass('ccod_import.identity_review_events') AS events")).rows[0].events,null);
    await pool.query("UPDATE public.companies SET raw_data=raw_data||'{\"company_status\":\"active\"}'::jsonb,last_fetched_at=clock_timestamp() WHERE company_number='10000010'");
    await mkdir(join(dir,'lib'));
    for(const f of ['profile_discovery.mjs','automatic_identity_review.mjs','read_scoped_charge_snapshot.mjs']){
      let s=await readFile('scripts/lib/'+f,'utf8');if(f==='read_scoped_charge_snapshot.mjs'){const g="const HOST='ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech';";assert.equal(s.split(g).length,2);s=s.replace(g,"const HOST='localhost';");}await writeFile(join(dir,'lib',f),s);
    }
    await writeFile(join(dir,'run_company_charge_import.mjs'),await readFile('scripts/run_company_charge_import.mjs','utf8'));
    const {readScopedChargeSnapshot:read}=await import(pathToFileURL(join(dir,'lib/read_scoped_charge_snapshot.mjs'))),{planProfileDiscovery:plan,runProfileDiscovery:discover}=await import(pathToFileURL(join(dir,'lib/profile_discovery.mjs'))),{reviewDiscoveredProfiles:review}=await import(pathToFileURL(join(dir,'lib/automatic_identity_review.mjs')));
    const opts=()=>({maxCompanies:2,maxRequests:2,maxRunMs:10000,expiresAt:new Date(Date.now()+60000).toISOString()});
    const state=async()=>(await pool.query("SELECT (SELECT jsonb_agg(to_jsonb(c) ORDER BY company_number) FROM public.companies c) AS profiles,(SELECT count(*)::int FROM ccod_import.company_charge_scans) AS scans,to_regclass('ccod_import.identity_review_events') AS events,to_regclass('ccod_import.identity_review_proposals') AS proposals")).rows[0];
    await t.test('profile-only HTTP evidence is requalified against a fresh read-only source',async()=>{
      const before=await state(),s=await read(pool),p=plan(s,opts()),calls=[];
      const d=await discover(p,{apply:true,approvedManifestHash:p.manifestHash,apiKey:'synthetic'},{fetchFn:async raw=>{const u=new URL(raw),n=u.pathname.split('/')[2];assert.equal(u.pathname,'/company/'+n);assert.equal(u.search,'');calls.push(u.pathname);const r=s.sources.find(r=>r.source.candidateNumber===n);return {ok:true,json:async()=>({company_number:n,company_name:r.source.proprietorName,type:'ltd',company_status:'active'})};}});
      const current=await read(pool),r=review(p,d,current,{asOf:new Date().toISOString()});assert.equal(calls.length,2);assert.equal(r.approvalsWritten,0);assert.equal(r.scansScheduled,0);assert.ok(r.rows.every(x=>x.reason==='RAW_REGISTRATION_NOT_CANONICAL'));assert.deepEqual(await state(),before);
    });
    await t.test('canonical cached match qualifies without HTTP, credentials or approval writes',async()=>{
      const s=await read(pool),p=plan(s,{...opts(),afterCompany:'00001235'}),before=await state();assert.equal(p.entries.length,1);assert.equal(p.entries[0].mode,'cached');
      const d=await discover(p,{apply:true,approvedManifestHash:p.manifestHash},{fetchFn:async()=>{throw Error('UNEXPECTED_API');}}),current=await read(pool),r=review(p,d,current,{asOf:new Date().toISOString()});assert.equal(d.requestsUsed,0);assert.equal(r.summary.eligibleCompanies,1);assert.equal(r.rows[0].approved,false);assert.deepEqual(await state(),before);
    });
    await t.test('source changed after discovery is held, not automatically approved',async()=>{
      const s=await read(pool),p=plan(s,{...opts(),afterCompany:'00001235'}),d=await discover(p,{apply:true,approvedManifestHash:p.manifestHash});
      await pool.query("UPDATE public.property_proprietors SET proprietor_name='CHANGED SYNTHETIC OWNER' WHERE title_number='SYNTH10'");
      try{const current=await read(pool),r=review(p,d,current,{asOf:new Date().toISOString()});assert.equal(r.rows[0].reason,'SOURCE_CHANGED_OR_LEFT_SCOPE');assert.equal(r.approvalsWritten,0);}finally{await pool.query("UPDATE public.property_proprietors SET proprietor_name='SYNTHETIC TEN LIMITED' WHERE title_number='SYNTH10'");}
    });
  }finally{await pool.end();await rm(dir,{recursive:true,force:true});}
});
