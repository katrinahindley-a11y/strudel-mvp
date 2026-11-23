import { createHash } from 'node:crypto';

const numberPattern = /^(?:[0-9]{8}|[A-Z]{2}[0-9]{6})$/;
const reasons = new Set(['prefix_missing', 'digits_conflict', 'historical_name', 'other_register', 'unresolved']);
const normalize = value => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
const fail = code => { throw Error(code); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function sourceSnapshot(source) {
  const keys = ['dataset', 'release', 'titleNumber', 'proprietorPosition', 'proprietorName', 'registrationRaw', 'candidateNumber'];
  if (!source || keys.some(key => !text(source[key]))) fail('SOURCE_IDENTITY_REQUIRED');
  if (source.dataset !== 'CCOD' || !numberPattern.test(source.candidateNumber)) fail('SOURCE_IDENTITY_INVALID');
  return Object.fromEntries(keys.map(key => [key, source[key]]));
}
function evidenceSnapshot(evidence) {
  if (!Array.isArray(evidence) || !evidence.length) fail('IDENTITY_EVIDENCE_REQUIRED');
  return evidence.map(item => {
    if (!item || !['register_identity', 'property_entity_link', 'previous_name'].includes(item.kind) || !text(item.note)) fail('IDENTITY_EVIDENCE_INVALID');
    let url;
    try { url = new URL(item.url); } catch { fail('IDENTITY_EVIDENCE_INVALID'); }
    if (url.protocol !== 'https:' || url.username || url.password || !Number.isFinite(Date.parse(item.observedAt))) fail('IDENTITY_EVIDENCE_INVALID');
    return { kind: item.kind, url: url.toString(), observedAt: item.observedAt, note: item.note };
  });
}
function proposalSnapshot(proposal) {
  if (!proposal || proposal.version !== 1 || !reasons.has(proposal.reason)) fail('IDENTITY_PROPOSAL_INVALID');
  const source = sourceSnapshot(proposal.source);
  const target = proposal.target;
  if (!target || !['companies_house', 'fca_mutuals', 'unresolved'].includes(target.registry)) fail('IDENTITY_TARGET_INVALID');
  if (target.registry === 'companies_house' && (!text(target.identifier) || !numberPattern.test(target.identifier))) fail('IDENTITY_TARGET_INVALID');
  if (target.registry === 'fca_mutuals' && !text(target.identifier)) fail('IDENTITY_TARGET_INVALID');
  if (target.registry === 'unresolved' && target.identifier !== null) fail('IDENTITY_TARGET_INVALID');
  if (!text(target.legalName)) fail('IDENTITY_TARGET_INVALID');
  return { version: 1, source, reason: proposal.reason,
    target: { registry: target.registry, identifier: target.identifier, legalName: target.legalName },
    evidence: evidenceSnapshot(proposal.evidence) };
}
export function createIdentityProposal(input) {
  const proposal = proposalSnapshot({ ...input, version: 1 });
  return freeze({ ...proposal, proposalHash: hash(proposal), reviewStatus: 'pending' });
}
function validateProposal(input) {
  const proposal = proposalSnapshot(input);
  if (hash(proposal) !== input.proposalHash || input.reviewStatus !== 'pending') fail('IDENTITY_PROPOSAL_CHANGED');
  return proposal;
}
export function recordIdentityDecision(proposal, { decision, reviewerId, reviewedAt, rationale } = {}) {
  validateProposal(proposal);
  if (!['approve', 'reject', 'hold'].includes(decision) || !text(reviewerId) || !text(rationale) || !Number.isFinite(Date.parse(reviewedAt))) fail('IDENTITY_REVIEW_INVALID');
  return freeze({ proposalHash: proposal.proposalHash, decision, reviewerId, reviewedAt, rationale });
}
export function evaluateIdentityReview({ proposal, decision, currentSource, companyProfile, profileNotFound = false } = {}) {
  const p = validateProposal(proposal);
  const result = (status, satisfied = false) => freeze({ status, identityReviewSatisfied: satisfied, scanAuthorized: false });
  if (hash(sourceSnapshot(currentSource)) !== hash(p.source)) return result('source_changed');
  if (profileNotFound) return result('company_profile_not_found');
  if (!decision) return result('review_required');
  if (decision.proposalHash !== proposal.proposalHash) return result('review_does_not_match_proposal');
  recordIdentityDecision(proposal, decision);
  if (decision.decision !== 'approve') return result(decision.decision === 'reject' ? 'review_rejected' : 'review_on_hold');
  if (p.target.registry !== 'companies_house') return result('separate_register_required');
  if (!companyProfile || companyProfile.company_number !== p.target.identifier || typeof companyProfile.company_name !== 'string' || normalize(companyProfile.company_name) !== normalize(p.target.legalName)) return result('company_identity_mismatch');
  if (!['ltd', 'plc'].includes(companyProfile.type)) return result('legal_form_requires_review');
  const registerEvidence = p.evidence.some(item => {
    const url = new URL(item.url);
    return item.kind === 'register_identity' && url.origin === 'https://find-and-update.company-information.service.gov.uk'
      && url.pathname === '/company/' + p.target.identifier;
  });
  if (!registerEvidence || !p.evidence.some(item => item.kind === 'property_entity_link')) return result('identity_evidence_incomplete');
  const sourceName = normalize(p.source.proprietorName);
  if (sourceName !== normalize(companyProfile.company_name)) {
    const previous = companyProfile.previous_company_names;
    if (p.reason !== 'historical_name' || !p.evidence.some(item => item.kind === 'previous_name') || !Array.isArray(previous)
        || !previous.some(item => typeof item.name === 'string' && normalize(item.name) === sourceName)) return result('proprietor_name_requires_review');
  }
  return result('identity_review_satisfied_scan_still_requires_authorization', true);
}
