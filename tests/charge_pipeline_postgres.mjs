import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createIdentityProposal} from '../scripts/lib/company_identity_review.mjs';
let phase='disposable-guard';
async function main(){
  if(process.env.GITHUB_ACTIONS!=='true')throw Error('GITHUB_ACTIONS_ONLY');
  const url=new URL(process.env.CHARGE_CI_DATABASE_URL||'');
  if(url.protocol!=='postgresql:'||url.hostname!=='localhost'||url.port!=='5432'||url.pathname!=='/neondb'||url.username!=='charge_ci'||url.search||url.hash)throw Error('DISPOSABLE_DATABASE_REQUIRED');
  globalThis.fetch=async()=>{throw Error('NETWORK_REQUESTS_DISABLED');};
  const pool=new pg.Pool({connectionString:url.toString(),max:2,connectionTimeoutMillis:10000,statement_timeout:10000});
  const temp=await mkdtemp(join(tmpdir(),'charge-pipeline-ci-'));
  const title=n=>n==='00000001'?'SYNTH2':'SYNTH1';
  const profile=n=>({company_number:n,company_name:n==='00000001'?'SYNTHETIC ZERO ONLY':'SYNTHETIC TEST ONLY',type:'ltd'});
  const charges=(kind='normal')=>[{charge_number:1,charge_code:'SYNTHETIC-CHARGE-1',status:kind==='changed'?'satisfied':'outstanding',persons_entitled:[{name:'SYNTHETIC TEST LENDER'}],particulars:{description:'Synthetic title SYNTH1'}}];
  try{
    phase='schema-and-migrations';
    assert.equal((await pool.query("SELECT to_regclass('public.companies') AS companies,to_regclass('ccod_import.target_guard') AS guard")).rows[0].companies,null);
    assert.equal((await pool.query("SELECT to_regclass('ccod_import.target_guard') AS guard")).rows[0].guard,null);
    await pool.query(`CREATE SCHEMA ccod_import;CREATE TABLE ccod_import.target_guard(id integer PRIMARY KEY,target_name text NOT NULL);INSERT INTO ccod_import.target_guard VALUES(1,'england-wales-property-test');
      CREATE TABLE public.property_titles(title_number text PRIMARY KEY,source_dataset text,source_snapshot_month date,price_paid numeric);
      CREATE TABLE public.property_proprietors(title_number text REFERENCES public.property_titles,proprietor_position smallint,proprietor_name text,registration_number_raw text,company_number_candidate text,PRIMARY KEY(title_number,proprietor_position));
      CREATE TABLE ccod_import.refresh_membership(title_number text PRIMARY KEY REFERENCES public.property_titles,managed_high_value boolean,active boolean,last_checked_month date);
      CREATE TABLE public.companies(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_number text UNIQUE NOT NULL,name text NOT NULL,normalized_name text NOT NULL,company_status text,company_type text,incorporation_date date,dissolution_date date,sic_codes text[],registered_address jsonb,postcode text,last_fetched_at timestamptz,raw_data jsonb,updated_at timestamptz DEFAULT now());
      CREATE TABLE public.charges(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid REFERENCES public.companies(id),external_charge_id text NOT NULL,created_on date,delivered_on date,status text,satisfied_on date,description text,persons_entitled_raw jsonb,raw_data jsonb,last_fetched_at timestamptz,updated_at timestamptz DEFAULT now(),UNIQUE(company_id,external_charge_id));
      INSERT INTO public.property_titles VALUES('SYNTH1','CCOD','2026-11-01',6000000),('SYNTH2','CCOD','2026-11-01',7000000);
      INSERT INTO public.property_proprietors VALUES('SYNTH1',1,'SYNTHETIC TEST ONLY','00000000','00000000'),('SYNTH2',1,'SYNTHETIC ZERO ONLY','00000001','00000001');
      INSERT INTO ccod_import.refresh_membership VALUES('SYNTH1',true,true,'2026-11-01'),('SYNTH2',true,true,'2026-11-01');`);
    for(const file of ['draft_company_charge_scan_tracking.sql','draft_company_charge_publication_tracking.sql','draft_company_identity_review.sql'])await pool.query(await readFile('migrations/'+file,'utf8'));
    await pool.query('INSERT INTO ccod_import.identity_review_principals(database_login,enabled,can_authorize_scan) VALUES(session_user,true,true)');
    await mkdir(join(temp,'lib'));
    const guard="const HOST = 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech';";
    for(const file of ['collect_company_charges.mjs','charge_scan_diagnostics.mjs','company_identity_review.mjs','company_identity_store.mjs','stage_company_charge_scan.mjs','publish_company_charge_scan.mjs']){
      let s=await readFile('scripts/lib/'+file,'utf8');
      if(['stage_company_charge_scan.mjs','publish_company_charge_scan.mjs'].includes(file)){assert.equal(s.split(guard).length,2);s=s.replace(guard,"const HOST = 'localhost';");}
      await writeFile(join(temp,'lib',file),s);
    }
    const {stageCompanyChargeScan:stage}=await import(pathToFileURL(join(temp,'lib/stage_company_charge_scan.mjs')));
    const {publishCompanyChargeScan:publish}=await import(pathToFileURL(join(temp,'lib/publish_company_charge_scan.mjs')));
    async function review(n){
      const observedAt=new Date().toISOString(),p=profile(n);
      const source={dataset:'CCOD',release:'2026-11-01',titleNumber:title(n),proprietorPosition:'1',proprietorName:p.company_name,registrationRaw:n,candidateNumber:n};
      const proposal=createIdentityProposal({source,reason:'unresolved',target:{registry:'companies_house',identifier:n,legalName:p.company_name},evidence:[{kind:'register_identity',url:'https://find-and-update.company-information.service.gov.uk/company/'+n,observedAt,note:'Synthetic CI only'},{kind:'property_entity_link',url:'https://example.invalid/'+title(n),observedAt,note:'Synthetic CI only'}]});
      const id=randomUUID();await pool.query('INSERT INTO ccod_import.identity_review_proposals(id,proposal_hash,payload,profile_evidence,profile_observed_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)',[id,proposal.proposalHash,JSON.stringify(proposal),JSON.stringify(p),observedAt]);
      for(const purpose of ['identity','scan'])await pool.query("SELECT ccod_import.append_identity_review_event($1,$2,$3,'approve','Synthetic CI only',clock_timestamp()+interval '1 hour')",[id,proposal.proposalHash,purpose]);
      return {proposalId:id,proposalHash:proposal.proposalHash};
    }
    const response=(n,kind='normal')=>async path=>{const u=new URL(path,'https://synthetic.invalid');if(u.pathname==='/company/'+n)return profile(n);assert.equal(u.pathname,'/company/'+n+'/charges');const start=Number(u.searchParams.get('start_index'));return {items:n==='00000001'||start>0?[]:charges(kind),total_count:n==='00000001'?0:kind==='incomplete'?2:1,start_index:start};};
    const staged=async(n,kind='normal')=>stage({companyNumber:n,pool,request:response(n,kind),identityReview:await review(n),apply:true});
    const pointers=async()=>(await pool.query("SELECT status,last_successful_scan_id,last_published_scan_id,last_error_code FROM ccod_import.company_charge_scan_state WHERE company_number='00000000'")).rows[0];
    const publicCounts=async()=>(await pool.query('SELECT (SELECT count(*)::int FROM public.companies) AS companies,(SELECT count(*)::int FROM public.charges) AS charges')).rows[0];
    // Legacy publication fixtures are independently seeded, never downgraded reviewed snapshots.
    async function legacySnapshot(n,kind='normal'){
      const id=randomUUID(),items=n==='00000001'?[]:charges(kind);
      const c=await pool.connect();try{await c.query('BEGIN');await c.query("INSERT INTO ccod_import.company_charge_scans(id,company_number,company_profile,charges,records_seen,pages_fetched,identity_status) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,1,'name_consistent_unverified')",[id,n,JSON.stringify(profile(n)),JSON.stringify(items),items.length]);await c.query("INSERT INTO ccod_import.company_charge_scan_state(company_number,status,last_successful_scan_id,last_successful_at,last_successful_charge_count) VALUES($1,'complete',$2,clock_timestamp(),$3) ON CONFLICT(company_number) DO UPDATE SET status='complete',last_successful_scan_id=$2,last_successful_at=EXCLUDED.last_successful_at,last_successful_charge_count=$3",[n,id,items.length]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}return id;
    }
    phase='review-gate-and-publication-boundary';
    let deniedCalls=0;await assert.rejects(stage({companyNumber:'00000000',pool,apply:true,request:async()=>{deniedCalls++;throw Error('UNEXPECTED_API');}}),/IDENTITY_REVIEW_REQUIRED/);assert.equal(deniedCalls,0);
    const reviewed=await staged('00000000');assert.equal(reviewed.identityStatus,'identity_review_approved');assert.equal(reviewed.publishedToSearch,false);
    await assert.rejects(publish({companyNumber:'00000000',scanId:reviewed.scanId,pool,apply:true}),/SCAN_NOT_CURRENT_COMPLETE_OR_FRESH/);assert.deepEqual(await publicCounts(),{companies:0,charges:0});
    const binding=(await pool.query('SELECT original_source FROM ccod_import.identity_review_scan_bindings WHERE scan_id=$1',[reviewed.scanId])).rows[0].original_source;assert.equal(binding.registrationRaw,'00000000');
    phase='legacy-publication-idempotency';
    const first=await legacySnapshot('00000000');await publish({companyNumber:'00000000',scanId:first,pool,apply:true});
    const initial=(await pool.query('SELECT id,status,last_fetched_at FROM public.charges')).rows[0];assert.equal(initial.status,'outstanding');
    await publish({companyNumber:'00000000',scanId:first,pool,apply:true});const repeated=await pool.query('SELECT id,last_fetched_at FROM public.charges');assert.equal(repeated.rowCount,1);assert.equal(repeated.rows[0].id,initial.id);assert.equal(+repeated.rows[0].last_fetched_at,+initial.last_fetched_at);
    phase='legacy-publication-rollback';
    const second=await legacySnapshot('00000000','changed');
    const failingPool={async connect(){const c=await pool.connect();return {connectionParameters:c.connectionParameters,release:d=>c.release(d),query:(sql,args)=>{if(sql.includes('SET last_published_scan_id'))throw Error('INJECTED_PUBLICATION_FAILURE');return c.query(sql,args);}};}};
    await assert.rejects(publish({companyNumber:'00000000',scanId:second,pool:failingPool,apply:true}),/CHARGE_PUBLICATION_FAILED/);assert.equal((await pool.query('SELECT status FROM public.charges')).rows[0].status,'outstanding');assert.equal((await pointers()).last_published_scan_id,first);
    await publish({companyNumber:'00000000',scanId:second,pool,apply:true});assert.equal((await pool.query('SELECT status FROM public.charges')).rows[0].status,'satisfied');
    phase='reviewed-failure-preserves-prior-state';
    const before=await pointers(),countBefore=(await pool.query('SELECT count(*)::int AS n FROM ccod_import.company_charge_scans')).rows[0].n;
    await assert.rejects(staged('00000000','incomplete'),/CHARGE_PAGE_ENDED_EARLY/);assert.deepEqual(await pointers(),before);assert.equal((await pool.query('SELECT count(*)::int AS n FROM ccod_import.company_charge_scans')).rows[0].n,countBefore);
    phase='zero-charge-boundary-and-legacy-publication';
    const zero=await staged('00000001');assert.equal(zero.charges,0);assert.equal(zero.publishedToSearch,false);const countsBefore=await publicCounts();await assert.rejects(publish({companyNumber:'00000001',scanId:zero.scanId,pool,apply:true}),/SCAN_NOT_CURRENT_COMPLETE_OR_FRESH/);assert.deepEqual(await publicCounts(),countsBefore);
    const legacyZero=await legacySnapshot('00000001');await publish({companyNumber:'00000001',scanId:legacyZero,pool,apply:true});assert.equal((await pool.query("SELECT count(*)::int AS n FROM public.charges ch JOIN public.companies c ON c.id=ch.company_id WHERE c.company_number='00000001'")).rows[0].n,0);
    phase='immutable-review-fixture-cleanup';
    await pool.query('DROP SCHEMA ccod_import CASCADE;DROP TABLE public.charges,public.companies,public.property_proprietors,public.property_titles;');
    const cleanup=(await pool.query("SELECT to_regclass('public.charges') AS charges,to_regclass('public.companies') AS companies,to_regclass('ccod_import.company_charge_scans') AS scans")).rows[0];assert.deepEqual(cleanup,{charges:null,companies:null,scans:null});
    console.log(JSON.stringify({passed:true,database:'disposable_postgres',api:'synthetic_only',checks:['review_required','reviewed_staging','reviewed_publication_blocked','source_binding','independent_legacy_publication','repeat_id_stability','source_timestamp','real_transaction_rollback','status_update','incomplete_scan_preservation','zero_charges','fixture_cleanup']}));
  }finally{await pool.end();await rm(temp,{recursive:true,force:true});}
}
main().catch(()=>{console.error(JSON.stringify({passed:false,error:'CHARGE_PIPELINE_INTEGRATION_FAILED',phase}));process.exitCode=1;});
