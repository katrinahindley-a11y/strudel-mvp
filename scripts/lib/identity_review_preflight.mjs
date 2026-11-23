const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const hashPattern = /^[a-f0-9]{64}$/;
export function assertCurrentReviewEvent({ event, proposalId, proposalHash, now }) {
  if (!Number.isFinite(now)) throw Error('IDENTITY_REVIEW_CLOCK_REQUIRED');
  if (!event || event.proposalId !== proposalId || event.proposalHash !== proposalHash
      || !hashPattern.test(proposalHash || '')) throw Error('IDENTITY_REVIEW_REQUIRED');
  if (event.reviewerEnabled !== true || typeof event.actorDatabaseLogin !== 'string'
      || !event.actorDatabaseLogin.trim()) throw Error('IDENTITY_REVIEWER_DISABLED');
  if (event.decision !== 'approve') throw Error('IDENTITY_REVIEW_NOT_APPROVED');
  if (!validTime(event.reviewedAt) || !validTime(event.expiresAt)
      || Date.parse(event.reviewedAt) > now || Date.parse(event.expiresAt) <= now
      || Date.parse(event.expiresAt) <= Date.parse(event.reviewedAt)
      || Date.parse(event.expiresAt) - Date.parse(event.reviewedAt) > 7 * 86400000) throw Error('IDENTITY_REVIEW_EXPIRED');
  return event;
}

// Server-internal coordinator only. Never construct trustedStore from request data.
// It is not wired to the current staging entry point by this draft.
export async function runReviewedScanPreflight({ proposalId, proposalHash, trustedStore,
  verifyIdentity, runControlledScan, now }) {
  if (!trustedStore || typeof trustedStore.loadLatestReview !== 'function'
      || typeof trustedStore.loadCurrentSource !== 'function'
      || typeof verifyIdentity !== 'function' || typeof runControlledScan !== 'function') throw Error('IDENTITY_PREFLIGHT_DEPENDENCY_REQUIRED');
  const stored = await trustedStore.loadLatestReview(proposalId);
  assertCurrentReviewEvent({ event: stored?.event, proposalId, proposalHash, now });
  const source = await trustedStore.loadCurrentSource(proposalId);
  const outcome = await verifyIdentity({ proposal: stored.proposal, event: stored.event, currentSource: source });
  if (outcome?.identityReviewSatisfied !== true) throw Error('IDENTITY_SOURCE_OR_EVIDENCE_REQUIRES_REVIEW');
  // No scan capability is passed to verifyIdentity. Approval alone is insufficient.
  if (stored.scanAuthorization?.approved !== true
      || stored.scanAuthorization.proposalHash !== proposalHash
      || stored.scanAuthorization.proposalId !== proposalId) throw Error('SEPARATE_SCAN_AUTHORIZATION_REQUIRED');
  return runControlledScan({ proposalId, proposalHash, source, storedReview: stored });
}
