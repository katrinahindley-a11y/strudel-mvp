import {createIdentityProposal} from '../scripts/lib/company_identity_review.mjs';
export function reviewedFixture(options={}) {
  const now=new Date(),observedAt=new Date(now-60000).toISOString();
  const source={dataset:'CCOD',release:'2026-11-01',titleNumber:'SYNTH1',proprietorPosition:'1',proprietorName:'SYNTHETIC LIMITED',registrationRaw:'001234',candidateNumber:'00001234'};
  const profile={company_number:'SC001234',company_name:source.proprietorName,type:'ltd'};
  const proposal=createIdentityProposal({source,reason:'prefix_missing',target:{registry:'companies_house',identifier:profile.company_number,legalName:profile.company_name},evidence:[{kind:'register_identity',url:'https://find-and-update.company-information.service.gov.uk/company/SC001234',observedAt,note:'Synthetic fixture only'},{kind:'property_entity_link',url:'https://example.invalid/title',observedAt,note:'Synthetic fixture only'}]});
  const identityReview={proposalId:'10000000-0000-4000-8000-000000000001',proposalHash:proposal.proposalHash};
  const queries=[];let requests=0,connections=0;
  const client={connectionParameters:{host:options.wrongHost?'wrong':'ep-divine-mud-za5xlaae.c-2.eu-west-2.aws.neon.tech',database:'neondb'},released:false,
    release(destroy){this.released=true;this.destroyed=destroy;},async query(sql,values=[]){
      queries.push({sql,values});
      if(sql.includes('SELECT target_name'))return {rows:[{target_name:options.badGuard?'wrong':'england-wales-property-test'}]};
      if(sql.includes('pg_try_advisory_xact_lock'))return {rows:[{acquired:!options.busy}]};
      if(sql.includes('lock_identity_review_proposal'))return {rows:[{held:true}]};
      if(sql.includes('lock_identity_review_principal'))return {rows:[{enabled:true}]};
      if(sql.includes('SELECT proposal_hash,payload'))return {rows:[{proposal_hash:proposal.proposalHash,payload:proposal,profile_evidence:profile,profile_observed_at:observedAt}]};
      if(sql.includes('FROM ccod_import.identity_review_events'))return {rows:[{event_sequence:values[2]==='identity'?1:2,decision:options.unapproved?'hold':'approve',actor_database_login:'synthetic_reviewer',rationale:'Synthetic approval',enabled:true,can_authorize_scan:true,reviewed_at:observedAt,expires_at:new Date(+now+3600000).toISOString(),checked_at:now.toISOString()}]};
      if(sql.includes('lock_identity_review_source'))return {rows:options.outside?[]:[source]};
      if(sql.includes('SELECT scan_id'))return {rows:[]};
      if(sql.includes('INSERT INTO ccod_import.company_charge_scans')&&options.failSnapshot)throw Error('Private database error');
      return {rows:[],rowCount:1};
    }};
  const request=async path=>{requests++;if(!path.includes('/charges?'))return {...profile,company_name:options.mismatch?'OTHER LIMITED':profile.company_name};if(options.requestFailure)throw Error('Private API error');return {items:options.partial?[{charge_number:1,charge_code:'SYNTHETIC-1'}]:[],total_count:options.partial?2:0,start_index:0};};
  const pool={connect:async()=>{connections++;return client;}};
  return {source,profile,proposal,client,queries,pool,request,input:{companyNumber:profile.company_number,pool,request,identityReview,apply:true},requestCount:()=>requests,connectionCount:()=>connections};
}
