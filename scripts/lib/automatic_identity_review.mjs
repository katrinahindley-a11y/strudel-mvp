import {PROFILE_POLICY_VERSION,sourceKey,sourceDigest,digest} from './profile_discovery.mjs';
const number=/^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$/;
const name=s=>typeof s==='string'?s.toUpperCase().replace(/[.,'’"()-]/g,'').replace(/\s+/g,' ').trim():'';
const stamp=v=>v==null?NaN:new Date(v).getTime();
export function reviewDiscoveredProfiles(plan,discovery,currentSnapshot,{asOf}={}){
  const now=stamp(asOf);if(!Number.isFinite(now)||!Number.isFinite(stamp(currentSnapshot?.asOf))||stamp(currentSnapshot.asOf)>now||now-stamp(currentSnapshot.asOf)>60000||plan.policyVersion!==PROFILE_POLICY_VERSION||discovery.manifestHash!==plan.manifestHash)throw Error('FRESH_REVIEW_SNAPSHOT_REQUIRED');
  const {manifestHash,...content}=plan;if(digest(content)!==manifestHash)throw Error('INVALID_PROFILE_MANIFEST_HASH');
  const current=new Map(),observations=new Map();for(const r of currentSnapshot.sources){const k=sourceKey(r);if(current.has(k))throw Error('DUPLICATE_REVIEW_SOURCE');current.set(k,r);}for(const o of discovery.observations){if(observations.has(o.companyNumber))throw Error('DUPLICATE_PROFILE_OBSERVATION');observations.set(o.companyNumber,o);}
  const rows=[],counts={};
  for(const e of plan.entries)for(const binding of e.sources){
    const r=current.get(binding.key),o=observations.get(e.companyNumber),s=r?.source,p=o?.profile;let reason;
    if(!r||sourceDigest(r)!==binding.hash)reason='SOURCE_CHANGED_OR_LEFT_SCOPE';
    else if(typeof s.release!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s.release)||!Number.isFinite(stamp(s.release))||stamp(s.release)>now)reason='SOURCE_RELEASE_REQUIRES_REVIEW';
    else if(!o||o.status!=='profile_observed')reason=o?.diagnostic||'PROFILE_NOT_OBSERVED';
    else if(!Number.isFinite(stamp(o.observedAt))||stamp(o.observedAt)>now||now-stamp(o.observedAt)>604800000)reason='PROFILE_EVIDENCE_STALE';
    else if(!number.test(s.candidateNumber||'')||typeof s.registrationRaw!=='string'||s.registrationRaw.trim()!==s.candidateNumber)reason='RAW_REGISTRATION_NOT_CANONICAL';
    else if(p.company_number!==s.candidateNumber)reason='PROFILE_NUMBER_MISMATCH';
    else if(!['ltd','plc'].includes(p.type))reason='UNSUPPORTED_LEGAL_FORM';
    else if(p.company_status!=='active')reason='COMPANY_STATUS_REQUIRES_REVIEW';
    else if(!name(s.proprietorName)||name(s.proprietorName)!==name(p.company_name))reason='LEGAL_NAME_REQUIRES_REVIEW';
    else reason='STRICT_POLICY_MATCH';
    const row={sourceKey:binding.key,sourceHash:binding.hash,companyNumber:e.companyNumber,decision:reason==='STRICT_POLICY_MATCH'?'eligible_for_automatic_review':'hold',reason,policyVersion:PROFILE_POLICY_VERSION,approved:false,scanAuthorized:false,propertySecurityVerified:false};rows.push(row);counts[reason]=(counts[reason]||0)+1;
  }
  return {mode:'automatic_review_shadow',asOf:new Date(now).toISOString(),manifestHash:plan.manifestHash,rows,summary:{selectedSourceRows:rows.length,eligibleSourceRows:rows.filter(r=>r.reason==='STRICT_POLICY_MATCH').length,eligibleCompanies:new Set(rows.filter(r=>r.reason==='STRICT_POLICY_MATCH').map(r=>r.companyNumber)).size,reasons:counts},approvalsWritten:0,scansScheduled:0,publishedToSearch:false};
}
