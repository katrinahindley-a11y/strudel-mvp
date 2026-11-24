import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityProposal, recordIdentityDecision, evaluateIdentityReview } from '../scripts/lib/company_identity_review.mjs';
const source = { dataset: 'CCOD', release: 'synthetic-release', titleNumber: 'SYNTH1', proprietorPosition: '1', proprietorName: 'SYNTHETIC COMPANY LIMITED', registrationRaw: '001234', candidateNumber: '00001234' };
const evidence = [
  { kind: 'register_identity', url: 'https://find-and-update.company-information.service.gov.uk/company/SC001234', observedAt: '2026-11-23T12:00:00Z', note: 'Synthetic evidence only; no network lookup.' },
  { kind: 'property_entity_link', url: 'https://example.invalid/synthetic-title', observedAt: '2026-11-23T12:00:00Z', note: 'Synthetic property-to-entity review.' }
];
function fixture(overrides = {}) {
  const proposal = createIdentityProposal({ source, reason: 'prefix_missing', target: { registry: 'companies_house', identifier: 'SC001234', legalName: 'SYNTHETIC COMPANY LIMITED' }, evidence, ...overrides });
  const decision = recordIdentityDecision(proposal, { decision: 'approve', reviewerId: 'synthetic-reviewer', reviewedAt: '2026-11-23T13:00:00Z', rationale: 'Synthetic review only.' });
  return { proposal, decision, currentSource: source, companyProfile: { company_number: 'SC001234', company_name: 'SYNTHETIC COMPANY LIMITED', type: 'ltd' } };
}
test('preserves raw source strings and does not mutate input', () => {
  const before = JSON.stringify(source); const { proposal } = fixture();
  assert.equal(proposal.source.registrationRaw, '001234'); assert.equal(proposal.source.candidateNumber, '00001234');
  assert.equal(JSON.stringify(source), before); assert.ok(Object.isFrozen(proposal.source));
});
test('proposal alone cannot satisfy identity review or authorize scanning', () => {
  const f = fixture(); delete f.decision; const r = evaluateIdentityReview(f);
  assert.equal(r.status, 'review_required'); assert.equal(r.identityReviewSatisfied, false); assert.equal(r.scanAuthorized, false);
});
test('approved synthetic identity satisfies review but never grants scan authorization', () => {
  const r = evaluateIdentityReview(fixture()); assert.equal(r.identityReviewSatisfied, true); assert.equal(r.scanAuthorized, false);
});
for (const key of Object.keys(source)) test('changed source binding: ' + key, () => {
  const f = fixture(); f.currentSource = { ...source, [key]: key === 'candidateNumber' ? '00001235' : key === 'dataset' ? 'CCOD' : source[key] + 'X' };
  if (key === 'dataset') assert.throws(() => evaluateIdentityReview({ ...f, currentSource: { ...source, dataset: 'OTHER' } }), /SOURCE_IDENTITY_INVALID/);
  else assert.equal(evaluateIdentityReview(f).status, 'source_changed');
});
test('mutating a serialized proposal invalidates its bound hash', () => {
  const f = fixture(); f.proposal = structuredClone(f.proposal); f.proposal.target.identifier = 'SC001235';
  assert.throws(() => evaluateIdentityReview(f), /IDENTITY_PROPOSAL_CHANGED/);
});
test('approval for another proposal is rejected', () => {
  const f = fixture(); f.decision = { ...f.decision, proposalHash: 'another-proposal' };
  assert.equal(evaluateIdentityReview(f).status, 'review_does_not_match_proposal');
});
for (const decision of ['hold', 'reject']) test(decision + ' blocks identity review', () => {
  const f = fixture(); f.decision = recordIdentityDecision(f.proposal, { ...f.decision, decision });
  assert.equal(evaluateIdentityReview(f).identityReviewSatisfied, false);
});
test('reviewer identity and rationale are mandatory', () => {
  const f = fixture(); assert.throws(() => recordIdentityDecision(f.proposal, { ...f.decision, reviewerId: '' }), /IDENTITY_REVIEW_INVALID/);
});
test('digit discrepancies remain pending unless separately reviewed', () => {
  const f = fixture({ reason: 'digits_conflict' }); delete f.decision;
  assert.equal(evaluateIdentityReview(f).status, 'review_required');
});
test('a society identifier does not become a Companies House scan target', () => {
  const f = fixture({ reason: 'other_register', target: { registry: 'fca_mutuals', identifier: '1234', legalName: 'SYNTHETIC SOCIETY' } });
  assert.equal(evaluateIdentityReview(f).status, 'separate_register_required');
});
test('unsupported partnership legal form remains on hold', () => {
  const f = fixture(); f.companyProfile.type = 'limited-partnership';
  assert.equal(evaluateIdentityReview(f).status, 'legal_form_requires_review');
});
test('profile 404 is distinct from a zero-charge success', () => {
  const r = evaluateIdentityReview({ ...fixture(), profileNotFound: true });
  assert.equal(r.status, 'company_profile_not_found'); assert.equal(r.identityReviewSatisfied, false); assert.equal('charges' in r, false);
});
test('profile number mismatch is blocked', () => {
  const f = fixture(); f.companyProfile.company_number = 'SC001235'; assert.equal(evaluateIdentityReview(f).status, 'company_identity_mismatch');
});
test('register evidence is bound to the exact proposed identifier', () => {
  const f = fixture({ evidence: evidence.map(e => e.kind === 'register_identity' ? { ...e, url: 'https://find-and-update.company-information.service.gov.uk/company/SC999999' } : e) });
  assert.equal(evaluateIdentityReview(f).status, 'identity_evidence_incomplete');
});
test('register evidence alone is not proof of property ownership', () => {
  const f = fixture({ evidence: [evidence[0]] }); assert.equal(evaluateIdentityReview(f).status, 'identity_evidence_incomplete');
});
test('historical names require both explicit evidence and exact previous-name match', () => {
  const f = fixture({ reason: 'historical_name', target: { registry: 'companies_house', identifier: 'SC001234', legalName: 'SYNTHETIC NEW NAME LIMITED' }, evidence: [...evidence, { ...evidence[0], kind: 'previous_name', note: 'Synthetic previous-name record.' }] });
  f.companyProfile.company_name = 'SYNTHETIC NEW NAME LIMITED';
  assert.equal(evaluateIdentityReview(f).status, 'proprietor_name_requires_review');
  f.companyProfile.previous_company_names = [{ name: source.proprietorName }];
  assert.equal(evaluateIdentityReview(f).identityReviewSatisfied, true);
});
test('unresolved proposals remain separate from scan eligibility', () => {
  const f = fixture({ reason: 'unresolved', target: { registry: 'unresolved', identifier: null, legalName: 'UNRESOLVED SYNTHETIC ENTITY' } });
  assert.equal(evaluateIdentityReview(f).scanAuthorized, false);
});
test('bare numeric registration cannot be inferred into a proposed target', () => {
  assert.throws(() => fixture({ target: { registry: 'companies_house', identifier: '1234', legalName: 'SYNTHETIC COMPANY LIMITED' } }), /IDENTITY_TARGET_INVALID/);
});
