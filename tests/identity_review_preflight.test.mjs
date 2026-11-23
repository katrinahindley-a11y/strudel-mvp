import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCurrentReviewEvent, runReviewedScanPreflight } from '../scripts/lib/identity_review_preflight.mjs';
const now = Date.parse('2026-11-23T15:00:00Z');
const proposalId = 'synthetic-proposal'; const proposalHash = 'a'.repeat(64);
const event = { proposalId, proposalHash, actorDatabaseLogin: 'synthetic_individual_login', reviewerEnabled: true,
  decision: 'approve', reviewedAt: '2026-11-23T14:00:00Z', expiresAt: '2026-11-24T14:00:00Z' };
function fixture(eventOverride = {}) {
  let scans = 0, sourceReads = 0, identityChecks = 0;
  const stored = { proposal: { synthetic: true }, event: { ...event, ...eventOverride },
    scanAuthorization: { approved: true, proposalId, proposalHash } };
  const options = { proposalId, proposalHash, now,
    trustedStore: { async loadLatestReview() { return stored; }, async loadCurrentSource() { sourceReads++; return { titleNumber: 'SYNTH1' }; } },
    async verifyIdentity() { identityChecks++; return { identityReviewSatisfied: true }; },
    async runControlledScan() { scans++; return { syntheticOnly: true }; } };
  return { stored, options, counts: () => ({ scans, sourceReads, identityChecks }) };
}
for (const decision of ['pending', 'hold', 'reject', 'revoke']) test(decision + ' blocks all scan calls', async () => {
  const f = fixture({ decision }); await assert.rejects(runReviewedScanPreflight(f.options), /IDENTITY_REVIEW_NOT_APPROVED/);
  assert.deepEqual(f.counts(), { scans: 0, sourceReads: 0, identityChecks: 0 });
});
for (const change of [
  { expiresAt: '2026-11-23T14:30:00Z' }, { expiresAt: 'invalid' },
  { reviewedAt: '2026-11-24T14:00:00Z' }, { expiresAt: '2026-12-24T14:00:00Z' }
]) test('expired, invalid, future or overlong approval blocked: ' + JSON.stringify(change), async () => {
  const f = fixture(change); await assert.rejects(runReviewedScanPreflight(f.options), /IDENTITY_REVIEW_EXPIRED/); assert.equal(f.counts().scans, 0);
});
for (const change of [{ reviewerEnabled: false }, { actorDatabaseLogin: '' }]) test('disabled or absent reviewer blocked: ' + JSON.stringify(change), async () => {
  const f = fixture(change); await assert.rejects(runReviewedScanPreflight(f.options), /IDENTITY_REVIEWER_DISABLED/); assert.equal(f.counts().scans, 0);
});
for (const change of [{ proposalId: 'other' }, { proposalHash: 'b'.repeat(64) }]) test('approval binding enforced: ' + JSON.stringify(change), async () => {
  const f = fixture(change); await assert.rejects(runReviewedScanPreflight(f.options), /IDENTITY_REVIEW_REQUIRED/); assert.equal(f.counts().scans, 0);
});
test('source mismatch is blocked before scan callback', async () => {
  const f = fixture(); f.options.verifyIdentity = async () => ({ identityReviewSatisfied: false });
  await assert.rejects(runReviewedScanPreflight(f.options), /IDENTITY_SOURCE_OR_EVIDENCE_REQUIRES_REVIEW/); assert.equal(f.counts().scans, 0);
});
test('source-read failure cannot proceed to scanning', async () => {
  const f = fixture(); f.options.trustedStore.loadCurrentSource = async () => { throw Error('synthetic source failure'); };
  await assert.rejects(runReviewedScanPreflight(f.options)); assert.equal(f.counts().scans, 0);
});
test('no stored review prevents scanning', async () => {
  const f = fixture(); f.options.trustedStore.loadLatestReview = async () => null;
  await assert.rejects(runReviewedScanPreflight(f.options), /IDENTITY_REVIEW_REQUIRED/); assert.equal(f.counts().scans, 0);
});
for (const authorization of [null, { approved: false }, { approved: true, proposalId, proposalHash: 'b'.repeat(64) }]) test('separate scan authorization required: ' + JSON.stringify(authorization), async () => {
  const f = fixture(); f.stored.scanAuthorization = authorization;
  await assert.rejects(runReviewedScanPreflight(f.options), /SEPARATE_SCAN_AUTHORIZATION_REQUIRED/); assert.equal(f.counts().scans, 0);
});
test('synthetic approved path invokes callback only after source and policy checks', async () => {
  const f = fixture(); assert.deepEqual(await runReviewedScanPreflight(f.options), { syntheticOnly: true });
  assert.deepEqual(f.counts(), { scans: 1, sourceReads: 1, identityChecks: 1 });
});
test('clock must be explicit', () => {
  assert.throws(() => assertCurrentReviewEvent({ event, proposalId, proposalHash }), /IDENTITY_REVIEW_CLOCK_REQUIRED/);
});
