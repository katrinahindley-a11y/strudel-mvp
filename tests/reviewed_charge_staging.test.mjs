import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdentityProposal} from '../scripts/lib/company_identity_review.mjs';
import {stageCompanyChargeScan} from '../scripts/lib/stage_company_charge_scan.mjs';
import {parseReviewedArgs,runReviewedImport} from '../scripts/run_reviewed_company_charge_import.mjs';
const id='10000000-0000-4000-8000-000000000001';
function fixture(o={}) {
  const now=new Date(),before=new Date(now-60000).toISOString();
  const source={dataset:'CCOD',release:'2026-11-01',titleNumber:'SYNTH1',proprietorPosition:'1',proprietorName:'SYNTHETIC LIMITED',registrationRaw:'001234',candidateNumber:'00001234'};
  const number='SC001234',profile={company_number:number,company_name:source.proprietorName,type:'ltd'};
  const proposal=createIdentityProposal({source,reason:'prefix_missing',target:{registry:'companies_house',identifier:number,legalName:profile.company_name},evidence:[{kind:'register_identity',url:'https://find-and-update.company-information.service.gov.uk/company/'+number,observedAt:before,note:'Synthetic only'},{kind:'property_entity_link',url:'https://example.invalid/title',observedAt:before,note:'Synthetic only'}]});
  let calls=0,loads=0; const queries=[];
  const client={connectionParameters:{host:o.badHost?'wrong':'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech',database:'neondb'},release(){},async query(sql,args=[]) {
    queries.push({sql,args});
    if(sql.includes('SELECT target_name')) return {rows:[{target_name:o.badGuard?'wrong':'england-wales-property-test'}]};
    if(sql.includes('pg_try_advisory_xact_lock')) return {rows:[{acquired:!o.busy}]};
    if(sql.includes('lock_identity_review_proposal')) return {rows:[{held:!o.missing}]};
    if(sql.includes('lock_identity_review_principal')) return {rows:[{enabled:!o.disabled}]};
    if(sql.includes('SELECT proposal_hash,payload')) {loads++;return {rows:[{proposal_hash:proposal.proposalHash,payload:proposal,profile_evidence:profile,profile_observed_at:before}]};}
    if(sql.includes('FROM ccod_import.identity_review_events')) return {rows:o.noEvent?[]:[{event_sequence:args[2]==='identity'?1:(o.changedPermit&&loads>2?3:2),decision:o.decision||'approve',actor_database_login:'synthetic_reviewer',rationale:'Synthetic',enabled:!o.disabled,can_authorize_scan:!o.noScanPermission,reviewed_at:before,expires_at:o.expired?before:new Date(+now+3600000).toISOString(),checked_at:now.toISOString()}]};
    if(sql.includes('lock_identity_review_source')) return {rows:o.outside?[]:[{...source,registrationRaw:o.sourceChanged?'changed':source.registrationRaw}]};
    if(sql.includes('SELECT scan_id')) return {rows:o.used?[{scan_id:'existing'}]:[]};
    if(sql.includes('INSERT INTO ccod_import.identity_review_scan_bindings')&&o.writeFailure) throw Error('Synthetic write failure');
    return {rows:[],rowCount:1};
  }};
  const input={companyNumber:number,pool:{connect:async()=>client},identityReview:{proposalId:id,proposalHash:proposal.proposalHash},apply:true,request:async path=>{calls++;if(!path.includes('/charges?')) {if(o.profile404)throw Error('COMPANY_PROFILE_NOT_FOUND');return {...profile,company_number:o.profileMismatch?'SC009999':number,type:o.unsupported?'limited-partnership':'ltd'};}return {items:[],total_count:o.incomplete?1:0,start_index:0};}};
  return {input,queries,calls:()=>calls};
}
test('dry-run has no dependencies',async()=>assert.equal((await stageCompanyChargeScan({companyNumber:'SC001234'})).executed,false));
test('missing reference stops before database access',async()=>{const f=fixture();delete f.input.identityReview;await assert.rejects(stageCompanyChargeScan(f.input),/IDENTITY_REVIEW_REQUIRED/);assert.equal(f.queries.length,0);});
for(const decision of ['pending','hold','reject','revoke']) test(decision+' prevents API calls',async()=>{const f=fixture({decision});await assert.rejects(stageCompanyChargeScan(f.input),/IDENTITY_REVIEW_NOT_APPROVED/);assert.equal(f.calls(),0);});
for(const [name,o,code] of [['expired',{expired:true},'IDENTITY_REVIEW_EXPIRED'],['disabled',{disabled:true},'IDENTITY_REVIEW_NOT_APPROVED'],['no scan permission',{noScanPermission:true},'IDENTITY_REVIEW_NOT_APPROVED'],['missing review',{missing:true},'IDENTITY_REVIEW_REQUIRED'],['no event',{noEvent:true},'IDENTITY_REVIEW_NOT_APPROVED'],['changed source',{sourceChanged:true},'IDENTITY_SOURCE_OR_PROFILE_MISMATCH'],['outside scope',{outside:true},'IDENTITY_SOURCE_CHANGED'],['used permit',{used:true},'IDENTITY_SCAN_ALREADY_USED'],['wrong host',{badHost:true},'UNAPPROVED_DATABASE_ENDPOINT'],['wrong guard',{badGuard:true},'TARGET_GUARD_FAILED'],['busy',{busy:true},'COMPANY_SCAN_ALREADY_RUNNING']]) test(name+' blocks before API access',async()=>{const f=fixture(o);await assert.rejects(stageCompanyChargeScan(f.input),new RegExp(code));assert.equal(f.calls(),0);assert.equal(f.queries.some(q=>q.sql.includes('INSERT INTO ccod_import.company_charge_scans')),false);});
test('approved target stages and retains original registration',async()=>{const f=fixture();const r=await stageCompanyChargeScan(f.input);assert.equal(r.companyNumber,'SC001234');assert.equal(r.publishedToSearch,false);assert.equal(f.calls(),2);const b=f.queries.find(q=>q.sql.includes('INSERT INTO ccod_import.identity_review_scan_bindings'));assert.equal(JSON.parse(b.args[5]).registrationRaw,'001234');assert.equal(JSON.parse(b.args[5]).candidateNumber,'00001234');assert.ok(f.queries.some(q=>q.sql==='COMMIT'));});
for(const [name,o,code] of [['profile 404',{profile404:true},'COMPANY_PROFILE_NOT_FOUND'],['wrong profile',{profileMismatch:true},'COMPANY_IDENTITY_MISMATCH'],['unsupported form',{unsupported:true},'IDENTITY_SOURCE_OR_PROFILE_MISMATCH'],['incomplete',{incomplete:true},'CHARGE_PAGE_ENDED_EARLY'],['permit changed',{changedPermit:true},'IDENTITY_AUTHORIZATION_CHANGED'],['write failure',{writeFailure:true},'CHARGE_SCAN_FAILED']]) test(name+' rolls back',async()=>{const f=fixture(o);await assert.rejects(stageCompanyChargeScan(f.input),new RegExp(code));assert.ok(f.queries.some(q=>q.sql==='ROLLBACK'));assert.equal(f.queries.some(q=>q.sql==='COMMIT'),false);assert.equal(f.queries.some(q=>/(?:UPDATE|INSERT INTO|DELETE FROM) public\./i.test(q.sql)),false);});
const ref=['--identity-proposal',id,'--identity-hash','a'.repeat(64)];
test('CLI passes review reference',()=>assert.deepEqual(parseReviewedArgs(['--company','SC001234',...ref]).identityReview,{proposalId:id,proposalHash:'a'.repeat(64)}));
test('CLI rejects apply without review before database access',async()=>{await assert.rejects(runReviewedImport(['--company','SC001234','--apply'],{}),/IDENTITY_REVIEW_REQUIRED/);});
test('CLI rejects partial reference',()=>assert.throws(()=>parseReviewedArgs(['--company','SC001234','--identity-proposal',id]),/IDENTITY_REVIEW_REQUIRED/));
test('reviewed CLI cannot publish',()=>assert.throws(()=>parseReviewedArgs(['--company','SC001234','--publish-scan',id,...ref]),/REVIEWED_STAGING_ONLY/));
test('reviewed CLI dry-run is inert',async()=>assert.equal((await runReviewedImport(['--company','SC001234'],{})).executed,false));
