import {evaluateIdentityReview} from './company_identity_review.mjs';
const number=/^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$/;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hash=/^[a-f0-9]{64}$/;
const norm=s=>typeof s==='string'?s.toUpperCase().replace(/[^A-Z0-9]/g,''):'';
const stamp=v=>v==null?NaN:new Date(v).getTime();
function fresh(v,now,age){const t=stamp(v);return Number.isFinite(t)&&t<=now&&now-t<=age;}
function current(e,purpose,now){const a=stamp(e?.reviewed_at),b=stamp(e?.expires_at);return !!e&&e.decision==='approve'&&e.enabled===true&&(purpose!=='scan'||e.can_authorize_scan===true)&&Number.isFinite(a)&&Number.isFinite(b)&&a<=now&&b>now&&b>a&&b-a<=604800000;}
// Advisory planning only. The staging worker must independently re-authorize every request.
export function buildScopedChargePlan(snapshot,{batchSize=100}={}){
  const now=stamp(snapshot?.asOf);if(!Number.isFinite(now)||!Number.isInteger(batchSize)||batchSize<1||batchSize>100)throw Error('INVALID_SCOPE_PLAN_OPTIONS');
  for(const k of ['sources','proposals','events','bindings'])if(!Array.isArray(snapshot[k]))throw Error('INCOMPLETE_SCOPE_SNAPSHOT');
  const bySource=new Map(),latest=new Map(),used=new Set(),seen=new Set(),companies=new Map(),statuses={},sources=[];
  const key=s=>JSON.stringify([s?.titleNumber,String(s?.proprietorPosition)]);
  for(const p of snapshot.proposals){const k=key(p.payload?.source);if(!bySource.has(k))bySource.set(k,[]);bySource.get(k).push(p);}
  for(const e of snapshot.events){if(!/^[1-9][0-9]*$/.test(String(e.event_sequence)))throw Error('INVALID_REVIEW_SEQUENCE');const k=e.proposal_id+':'+e.purpose;const old=latest.get(k);if(!old||BigInt(e.event_sequence)>BigInt(old.event_sequence))latest.set(k,e);}
  for(const b of snapshot.bindings)used.add(String(b.scan_event));
  for(const row of snapshot.sources){
    const s=row.source,k=key(s);if(!s?.titleNumber||seen.has(k))throw Error('DUPLICATE_OR_INVALID_SCOPE_SOURCE');seen.add(k);
    const item={titleNumber:s.titleNumber,proprietorPosition:s.proprietorPosition,candidateNumber:s.candidateNumber||null,status:'review_required'};
    if(row.hasProprietor!==true)item.status='missing_proprietor';
    else if(!/^[1-4]$/.test(String(s.proprietorPosition||'')))item.status='invalid_proprietor_position';
    else if(row.membershipCurrent!==true)item.status='source_release_requires_review';
    else if(!s.candidateNumber)item.status='missing_candidate';
    else if(!number.test(s.candidateNumber))item.status='invalid_candidate';
    else{
      const targets=new Map();
      for(const p of snapshot.approvalStoreAvailable===true?(bySource.get(k)||[]):[]){
        const i=latest.get(p.id+':identity'),a=latest.get(p.id+':scan');
        try{
          if(!uuid.test(p.id)||!hash.test(p.proposal_hash)||p.payload?.proposalHash!==p.proposal_hash||i?.proposal_hash!==p.proposal_hash||a?.proposal_hash!==p.proposal_hash||!current(i,'identity',now)||!current(a,'scan',now))continue;
          if(!fresh(p.profile_observed_at,now,604800000)||!p.payload.evidence.every(e=>fresh(e.observedAt,now,604800000)))continue;
          const result=evaluateIdentityReview({proposal:p.payload,currentSource:s,companyProfile:p.profile_evidence,decision:{proposalHash:p.proposal_hash,decision:'approve',reviewerId:i.actor_database_login,reviewedAt:new Date(i.reviewed_at).toISOString(),rationale:i.rationale}});
          if(result.identityReviewSatisfied!==true)continue;
          const n=p.payload.target.identifier;if(!targets.has(n))targets.set(n,[]);targets.get(n).push({used:used.has(String(a.event_sequence)),reference:{companyNumber:n,proposalId:p.id,proposalHash:p.proposal_hash}});
        }catch{/* Malformed proposals remain review-required, never scan-ready. */}
      }
      if(targets.size>1)item.status='conflicting_approved_targets';
      else if(targets.size===1){const list=[...targets.values()][0].filter(x=>!x.used).map(x=>x.reference).sort((a,b)=>a.proposalId<b.proposalId?-1:1);if(list.length){item.status='ready';item.companyNumber=list[0].companyNumber;item.reference=list[0];}else item.status='scan_permission_used';}

      else if(row.candidateProfile?.company_number===s.candidateNumber&&['ltd','plc'].includes(row.candidateProfile.type)&&norm(s.proprietorName)&&norm(s.proprietorName)===norm(row.candidateProfile.company_name)&&fresh(row.candidateProfileObservedAt,now,604800000))item.status='review_required_profile_consistent';
    }
    statuses[item.status]=(statuses[item.status]||0)+1;sources.push(item);
    if(item.status==='ready'){const old=companies.get(item.companyNumber);if(!old||item.reference.proposalId<old.proposalId)companies.set(item.companyNumber,item.reference);}
  }
  const entries=[...companies.values()].sort((a,b)=>a.companyNumber<b.companyNumber?-1:a.companyNumber>b.companyNumber?1:0),batches=[];
  for(let i=0;i<entries.length;i+=batchSize)batches.push(entries.slice(i,i+batchSize));
  return {mode:'qualification_plan',asOf:new Date(now).toISOString(),approvalStoreAvailable:snapshot.approvalStoreAvailable===true,summary:{titles:new Set(sources.map(s=>s.titleNumber)).size,sourceRows:sources.length,proprietorRecords:snapshot.sources.filter(r=>r.hasProprietor===true).length,candidateCompanies:new Set(snapshot.sources.map(r=>r.source.candidateNumber).filter(n=>number.test(n||''))).size,readyCompanies:entries.length,batches:batches.length,statuses},sources,batches,executed:false,publishedToSearch:false,warning:'Planning is not approval, scan coverage, ownership verification or publication. Re-authorize at execution.'};
}
