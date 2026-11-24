import test from 'node:test';
import assert from 'node:assert/strict';
import {loadReviewedIdentity} from '../scripts/lib/company_identity_store.mjs';
for(const [lock,purpose] of [['principal','identity'],['source','identity'],['source','scan']])test(lock+' wait expires '+purpose+' before API access',async()=>{
  const base=Date.parse('2026-11-24T12:00:00Z'),hash='a'.repeat(64);let clock=base,apiCalls=0;
  const source={titleNumber:'SYNTH1',proprietorPosition:'1'};
  const c={async query(sql,args=[]){
    if(sql.includes('SELECT target_name'))return {rows:[{target_name:'england-wales-property-test'}]};
    if(sql.includes('lock_identity_review_proposal'))return {rows:[{held:true}]};
    if(sql.includes('SELECT proposal_hash,payload'))return {rows:[{proposal_hash:hash,payload:{proposalHash:hash,target:{identifier:'SC001234'},source,evidence:[]},profile_evidence:{},profile_observed_at:new Date(base-60000)}]};
    if(sql.includes('FROM ccod_import.identity_review_events'))return {rows:[{event_sequence:args[2]==='identity'?1:2,decision:'approve',actor_database_login:'fixture',rationale:'Fixture',enabled:true,can_authorize_scan:true,reviewed_at:new Date(base-60000),expires_at:new Date(base+(args[2]===purpose?2000:3600000)),checked_at:new Date(clock)}]};
    if(sql.includes('lock_identity_review_principal')){if(lock==='principal')clock=base+3000;return {rows:[{enabled:true}]};}
    if(sql.includes('lock_identity_review_source')){if(lock==='source')clock=base+3000;return {rows:[source]};}
    throw Error('UNEXPECTED_SQL');
  }};
  await assert.rejects((async()=>{await loadReviewedIdentity(c,{proposalId:'10000000-0000-4000-8000-000000000001',proposalHash:hash},'SC001234');apiCalls++;})(),/IDENTITY_REVIEW_EXPIRED/);
  assert.equal(apiCalls,0);
});
