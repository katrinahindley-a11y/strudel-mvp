import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createIdentityProposal} from '../scripts/lib/company_identity_review.mjs';
import {buildScopedChargePlan} from '../scripts/lib/scoped_charge_plan.mjs';
test('scope qualification uses actual read-only PostgreSQL snapshots',{skip:process.env.RUN_SCOPE_PLANNER_POSTGRES!=='1'},async t=>{
  if(process.env.GITHUB_ACTIONS!=='true')throw Error('GITHUB_ACTIONS_ONLY');
  const u=new URL(process.env.CHARGE_CI_DATABASE_URL||'');if(u.protocol!=='postgresql:'||u.hostname!=='localhost'||u.port!=='5432'||u.pathname!=='/neondb'||u.username!=='charge_ci'||u.search||u.hash)throw Error('DISPOSABLE_DATABASE_REQUIRED');
  globalThis.fetch=async()=>{throw Error('LIVE_NETWORK_DISABLED');};
  const {default:pg}=await import('pg'),owner=new pg.Pool({connectionString:u.toString(),max:2,statement_timeout:10000});
  const r=new URL(u);r.username='identity_ci_reviewer';r.password='disposable_reviewer_only';const reviewer=new pg.Pool({connectionString:r.toString(),max:1});
  const dir=await mkdtemp(join(tmpdir(),'scope-plan-pg-'));
  try{
    let code=await readFile('scripts/lib/read_scoped_charge_snapshot.mjs','utf8');const marker="const HOST='ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech';";assert.equal(code.split(marker).length,2);code=code.replace(marker,"const HOST='localhost';");await writeFile(join(dir,'reader.mjs'),code);const {readScopedChargeSnapshot:read}=await import(pathToFileURL(join(dir,'reader.mjs')));
    await owner.query(`CREATE TABLE public.companies(company_number text PRIMARY KEY,raw_data jsonb,last_fetched_at timestamptz);
      INSERT INTO public.companies VALUES('10000010','{"company_number":"10000010","company_name":"SYNTHETIC TEN LIMITED","type":"ltd"}',clock_timestamp());
      INSERT INTO public.property_titles VALUES('SYNTH3','CCOD','2026-11-01',6000000),('SYNTH4','CCOD','2026-11-01',6000000),('SYNTH5','CCOD','2026-11-01',6000000),('SYNTH6','CCOD','2026-11-01',6000000),('SYNTH7','OTHER','2026-11-01',6000000),('SYNTH8','CCOD','2026-11-01',5000000),('SYNTH10','CCOD','2026-11-01',6000000);
      INSERT INTO public.property_proprietors VALUES('SYNTH1',2,'SYNTHETIC LIMITED','001234','00001234'),('SYNTH3',1,'MISSING NUMBER',NULL,NULL),('SYNTH10',1,'SYNTHETIC TEN LIMITED','10000010','10000010');
      INSERT INTO ccod_import.refresh_membership VALUES('SYNTH3',true,true,'2026-11-01'),('SYNTH4',true,true,'2026-11-01'),('SYNTH5',true,false,'2026-11-01'),('SYNTH6',false,true,'2026-11-01'),('SYNTH7',true,true,'2026-11-01'),('SYNTH8',true,true,'2026-11-01'),('SYNTH10',true,true,'2026-11-01');`);
    for(const [title,n,raw,candidate,name] of [['SYNTH1','SC001234','001234','00001234','SYNTHETIC LIMITED'],['SYNTH2','SC001235','001235','00001235','SECOND SYNTHETIC LIMITED']]){
      const observedAt=new Date().toISOString(),profile={company_number:n,company_name:name,type:'ltd'},source={dataset:'CCOD',release:'2026-11-01',titleNumber:title,proprietorPosition:'1',proprietorName:name,registrationRaw:raw,candidateNumber:candidate};
      const p=createIdentityProposal({source,reason:'prefix_missing',target:{registry:'companies_house',identifier:n,legalName:name},evidence:[{kind:'register_identity',url:'https://find-and-update.company-information.service.gov.uk/company/'+n,observedAt,note:'Synthetic'},{kind:'property_entity_link',url:'https://example.invalid/'+title,observedAt,note:'Synthetic'}]}),id=randomUUID();
      await owner.query('INSERT INTO ccod_import.identity_review_proposals(id,proposal_hash,payload,profile_evidence,profile_observed_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)',[id,p.proposalHash,JSON.stringify(p),JSON.stringify(profile),observedAt]);for(const purpose of ['identity','scan'])await reviewer.query("SELECT ccod_import.append_identity_review_event($1,$2,$3,'approve','Synthetic planner',clock_timestamp()+interval '1 hour')",[id,p.proposalHash,purpose]);
    }
    const plan=async()=>buildScopedChargePlan(await read(owner,{pageSize:1}),{batchSize:1});
    await t.test('all scoped titles and proprietors survive page-size-one traversal',async()=>{const p=await plan();assert.equal(p.summary.titles,5);assert.equal(p.summary.sourceRows,6);assert.equal(p.summary.proprietorRecords,5);assert.equal(p.summary.readyCompanies,2);assert.equal(p.batches.length,2);assert.equal(p.summary.statuses.missing_candidate,1);assert.equal(p.summary.statuses.missing_proprietor,1);assert.equal(p.summary.statuses.review_required_profile_consistent,1);});
    await t.test('one proprietor approval is not transferred to another position',async()=>{const p=await plan();assert.equal(p.sources.find(s=>s.titleNumber==='SYNTH1'&&s.proprietorPosition==='2').status,'review_required');});
    await t.test('planning does not create snapshots or scan bindings',async()=>{const counts=async()=>(await owner.query('SELECT (SELECT count(*)::int FROM ccod_import.company_charge_scans) AS scans,(SELECT count(*)::int FROM ccod_import.identity_review_scan_bindings) AS bindings')).rows[0];const before=await counts();await plan();assert.deepEqual(await counts(),before);});
    await t.test('latest revocations remove every old approval for a source',async()=>{const rows=(await owner.query("SELECT id,proposal_hash FROM ccod_import.identity_review_proposals WHERE payload #>> '{source,titleNumber}'='SYNTH1' AND payload #>> '{source,proprietorPosition}'='1'")).rows;for(const p of rows)await reviewer.query("SELECT ccod_import.append_identity_review_event($1,$2,'identity','revoke','Synthetic planner revoke',NULL)",[p.id,p.proposal_hash]);const p=await plan();assert.equal(p.batches.flat().some(e=>e.companyNumber==='SC001234'),false);});
    await t.test('read-only transaction rejects an injected write',async()=>{let injected=false;const bad={async connect(){const c=await owner.connect();return {connectionParameters:c.connectionParameters,release:d=>c.release(d),query:(q,args)=>{if(!injected&&q.includes('FROM public.property_titles')){injected=true;return c.query("INSERT INTO public.property_titles VALUES('MUST_NOT_WRITE','CCOD','2026-11-01',6000000)");}return c.query(q,args);}};}};await assert.rejects(read(bad),e=>e.code==='25006');assert.equal((await owner.query("SELECT count(*)::int AS n FROM public.property_titles WHERE title_number='MUST_NOT_WRITE'")).rows[0].n,0);});
    await t.test('partially absent review schema fails closed',async()=>{await owner.query('DROP TABLE ccod_import.identity_review_scan_bindings');await assert.rejects(read(owner),/REVIEW_SCHEMA_INCOMPLETE/);});
    await t.test('wholly absent review schema still reports the full inventory without approvals',async()=>{await owner.query('DROP TABLE ccod_import.identity_review_events,ccod_import.identity_review_proposals,ccod_import.identity_review_principals CASCADE');const p=await plan();assert.equal(p.approvalStoreAvailable,false);assert.equal(p.summary.titles,5);assert.equal(p.summary.sourceRows,6);assert.equal(p.summary.readyCompanies,0);assert.equal(p.batches.length,0);});
  }finally{await owner.end();await reviewer.end();await rm(dir,{recursive:true,force:true});}
});
