import { evaluateIdentityReview } from './company_identity_review.mjs';
export function assertReviewReference(r = {}) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(r.proposalId || '') || !/^[a-f0-9]{64}$/.test(r.proposalHash || '')) throw Error('IDENTITY_REVIEW_REQUIRED');
}
const eventSQL=`SELECT e.event_sequence,e.decision,e.actor_database_login,e.rationale,e.reviewed_at,e.expires_at,a.enabled,a.can_authorize_scan,clock_timestamp() AS checked_at FROM ccod_import.identity_review_events e JOIN ccod_import.identity_review_principals a ON a.database_login=e.actor_database_login WHERE e.proposal_id=$1 AND e.proposal_hash=$2 AND e.purpose=$3 ORDER BY e.event_sequence DESC LIMIT 1`;
function currentEvent(e,purpose) {
  if (!e || e.decision !== 'approve' || e.enabled !== true || (purpose === 'scan' && e.can_authorize_scan !== true)) throw Error('IDENTITY_REVIEW_NOT_APPROVED');
  const now=new Date(e.checked_at).getTime(),start=new Date(e.reviewed_at).getTime(),end=new Date(e.expires_at).getTime();
  if (![now,start,end].every(Number.isFinite) || start>now || end<=now || end<=start || end-start>604800000) throw Error('IDENTITY_REVIEW_EXPIRED');
  return e;
}
export async function loadReviewedIdentity(c, ref, number, profile) {
  assertReviewReference(ref);
  const guard=await c.query('SELECT target_name FROM ccod_import.target_guard WHERE id = 1');
  if (guard.rows.length!==1 || guard.rows[0].target_name!=='england-wales-property-test') throw Error('TARGET_GUARD_FAILED');
  const held=await c.query('SELECT ccod_import.lock_identity_review_proposal($1,$2) AS held',[ref.proposalId,ref.proposalHash]);
  if (held.rows[0]?.held!==true) throw Error('IDENTITY_REVIEW_REQUIRED');
  const found=await c.query('SELECT proposal_hash,payload,profile_evidence,profile_observed_at FROM ccod_import.identity_review_proposals WHERE id=$1 AND proposal_hash=$2',[ref.proposalId,ref.proposalHash]);
  if (found.rows.length!==1) throw Error('IDENTITY_REVIEW_REQUIRED');
  const row=found.rows[0],proposal=row.payload;
  if (proposal?.proposalHash!==row.proposal_hash || proposal?.target?.identifier!==number) throw Error('IDENTITY_TARGET_MISMATCH');
  const readEvent=async purpose=>currentEvent((await c.query(eventSQL,[ref.proposalId,ref.proposalHash,purpose])).rows[0],purpose);
  const events={};
  for (const purpose of ['identity','scan']) {
    const e=await readEvent(purpose);
    const principal=await c.query('SELECT ccod_import.lock_identity_review_principal($1,$2) AS enabled',[e.actor_database_login,purpose==='scan']);
    if (principal.rows[0]?.enabled!==true) throw Error('IDENTITY_REVIEW_NOT_APPROVED');
    events[purpose]=e;
  }
  const s=proposal.source;
  if (!/^[1-4]$/.test(s?.proprietorPosition || '')) throw Error('IDENTITY_SOURCE_CHANGED');
  const source=await c.query('SELECT * FROM ccod_import.lock_identity_review_source($1,$2)',[s.titleNumber,Number(s.proprietorPosition)]);
  if (source.rows.length!==1) throw Error('IDENTITY_SOURCE_CHANGED');
  // All potentially blocking locks are now held. Re-read with fresh database time.
  for (const purpose of ['identity','scan']) {
    const fresh=await readEvent(purpose);
    if (String(fresh.event_sequence)!==String(events[purpose].event_sequence)) throw Error('IDENTITY_AUTHORIZATION_CHANGED');
    events[purpose]=fresh;
  }
  const now=new Date(events.identity.checked_at).getTime();
  const dates=[row.profile_observed_at,...proposal.evidence.map(e=>e.observedAt)];
  if (dates.some(d=>{const n=new Date(d).getTime();return !Number.isFinite(n)||n>now||now-n>604800000;})) throw Error('IDENTITY_EVIDENCE_STALE');
  const e=events.identity;
  const result=evaluateIdentityReview({proposal,currentSource:source.rows[0],companyProfile:profile||row.profile_evidence,decision:{proposalHash:row.proposal_hash,decision:'approve',reviewerId:e.actor_database_login,reviewedAt:new Date(e.reviewed_at).toISOString(),rationale:e.rationale}});
  if (result.identityReviewSatisfied!==true) throw Error('IDENTITY_SOURCE_OR_PROFILE_MISMATCH');
  return {source:source.rows[0],identityEvent:events.identity.event_sequence,scanEvent:events.scan.event_sequence};
}
