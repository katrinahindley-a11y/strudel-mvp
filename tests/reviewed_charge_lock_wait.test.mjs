import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createIdentityProposal} from '../scripts/lib/company_identity_review.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('Postgres approval expiry while waiting for principal or source locks',{skip:process.env.RUN_REVIEWED_POSTGRES!=='1'},async t=>{
  if(process.env.GITHUB_ACTIONS!=='true')throw Error('GITHUB_ACTIONS_ONLY');
  const u=new URL(process.env.CHARGE_CI_DATABASE_URL||'');
  if(u.protocol!=='postgresql:'||u.hostname!=='localhost'||u.port!=='5432'||u.pathname!=='/neondb'||u.username!=='charge_ci'||u.search||u.hash)throw Error('DISPOSABLE_DATABASE_REQUIRED');
  globalThis.fetch=async()=>{throw Error('NETWORK_REQUESTS_DISABLED');};
  const {default:pg}=await import('pg');const pools=[];
  const pool=(user,password)=>{const x=new URL(u);if(user){x.username=user;x.password=password;}const p=new pg.Pool({connectionString:x.toString(),max:3,statement_timeout:10000,connectionTimeoutMillis:5000});pools.push(p);return p;};
  const owner=pool(),reviewer=pool('identity_ci_reviewer','disposable_reviewer_only'),scanner=pool('identity_ci_scanner','disposable_scanner_only');
  const temp=await mkdtemp(join(tmpdir(),'identity-wait-ci-'));
  try{
    // The immediately preceding reviewed_charge_postgres suite creates these restricted roles and fixtures.
    assert.equal((await owner.query("SELECT enabled FROM ccod_import.identity_review_principals WHERE database_login='identity_ci_reviewer'")).rows[0]?.enabled,true);
    await mkdir(join(temp,'lib'));
    for(const file of ['stage_company_charge_scan.mjs','company_identity_store.mjs','company_identity_review.mjs','collect_company_charges.mjs','charge_scan_diagnostics.mjs']){
      let s=await readFile('scripts/lib/'+file,'utf8');if(file==='stage_company_charge_scan.mjs'){const g="const HOST = 'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech';";assert.equal(s.split(g).length,2);s=s.replace(g,"const HOST = 'localhost';");}await writeFile(join(temp,'lib',file),s);
    }
    const {stageCompanyChargeScan:stage}=await import(pathToFileURL(join(temp,'lib/stage_company_charge_scan.mjs')));
    const number='SC001234',profile={company_number:number,company_name:'SYNTHETIC LIMITED',type:'ltd'};
    for(const [lock,purpose] of [['principal','identity'],['source','identity'],['source','scan']])await t.test(lock+' wait expires '+purpose+' with zero API calls',async()=>{
      const observedAt=new Date().toISOString(),id=randomUUID();
      const source={dataset:'CCOD',release:'2026-11-01',titleNumber:'SYNTH1',proprietorPosition:'1',proprietorName:profile.company_name,registrationRaw:'001234',candidateNumber:'00001234'};
      const p=createIdentityProposal({source,reason:'prefix_missing',target:{registry:'companies_house',identifier:number,legalName:profile.company_name},evidence:[{kind:'register_identity',url:'https://find-and-update.company-information.service.gov.uk/company/'+number,observedAt,note:'Synthetic only'},{kind:'property_entity_link',url:'https://example.invalid/title',observedAt,note:'Synthetic only'}]});
      await owner.query('INSERT INTO ccod_import.identity_review_proposals(id,proposal_hash,payload,profile_evidence,profile_observed_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5)',[id,p.proposalHash,JSON.stringify(p),JSON.stringify(profile),observedAt]);
      const expiry=(await owner.query("SELECT clock_timestamp()+interval '3500 milliseconds' AS expiry")).rows[0].expiry;
      for(const kind of ['identity','scan'])await reviewer.query("SELECT ccod_import.append_identity_review_event($1,$2,$3,'approve','Synthetic lock wait',$4)",[id,p.proposalHash,kind,kind===purpose?expiry:new Date(+expiry+3600000)]);
      const state=async()=>(await owner.query('SELECT status,last_successful_scan_id,last_published_scan_id FROM ccod_import.company_charge_scan_state WHERE company_number=$1',[number])).rows;
      const before=await state(),countBefore=(await owner.query('SELECT count(*)::int AS n FROM ccod_import.company_charge_scans')).rows[0].n;
      const blocker=await owner.connect();let running,outcome,calls=0;
      try{
        await blocker.query('BEGIN');
        await blocker.query(lock==='principal'?"SELECT 1 FROM ccod_import.identity_review_principals WHERE database_login='identity_ci_reviewer' FOR UPDATE":"SELECT 1 FROM public.property_proprietors WHERE title_number='SYNTH1' AND proprietor_position=1 FOR UPDATE");
        running=stage({companyNumber:number,pool:scanner,identityReview:{proposalId:id,proposalHash:p.proposalHash},apply:true,request:async path=>{calls++;return path.includes('/charges?')?{items:[],total_count:0,start_index:0}:profile;}}).then(value=>({value}),error=>({error}));
        let waiting=false;const fn=lock==='principal'?'lock_identity_review_principal':'lock_identity_review_source';
        for(let i=0;i<80;i++){const r=await owner.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='identity_ci_scanner' AND wait_event_type='Lock' AND query LIKE $1) AS waiting",['%'+fn+'%']);if(r.rows[0].waiting){waiting=true;break;}await pause(25);}
        assert.equal(waiting,true,'Expected real PostgreSQL lock wait');assert.equal(calls,0);
        const remaining=(await owner.query('SELECT GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000)::float8 AS ms',[expiry])).rows[0].ms;
        await pause(Math.ceil(remaining)+150);
      }finally{try{await blocker.query('ROLLBACK');}finally{blocker.release();}if(running)outcome=await running;}
      assert.equal(outcome?.error?.message,'IDENTITY_REVIEW_EXPIRED');assert.equal(calls,0);assert.deepEqual(await state(),before);assert.equal((await owner.query('SELECT count(*)::int AS n FROM ccod_import.company_charge_scans')).rows[0].n,countBefore);
    });
  }finally{await Promise.all(pools.map(p=>p.end()));await rm(temp,{recursive:true,force:true});}
});
