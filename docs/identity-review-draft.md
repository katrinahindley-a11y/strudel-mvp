# Identity review - offline draft, not deployed

Prepared against diagnostic head ce75750faa635265ab2038265eddc8b94b322fd1.

## Included
- Pure JavaScript proposal/decision evaluation, with no database or network dependencies.
- Unchanged source registration strings, separately proposed identifiers, evidence, reviewer decision, and SHA-256 binding to source and proposal content.
- Source binding includes CCOD release, title, proprietor position, name, raw registration and original candidate.
- Synthetic regression tests only; no real identity corrections, mappings or approvals are bundled.

## Important limits
This is a preparatory component, NOT a deployed scanner gate. Existing runtime behaviour is unchanged. All results set scanAuthorized=false, even when identity review is satisfied. Review decisions in this module are data, not authenticated approvals: production code must load decisions from an access-controlled, append-only review store, derive reviewer identity from authentication, and reject client-supplied approval objects. Hashes detect changes; they are not signatures or proof of authority.

Evidence URLs and notes are review records, not automatically verified ownership evidence. Reviewers must establish the property-to-entity link. The draft supports only ltd/plc profile types; every other type stays held pending an explicit capability decision. Source data changes invalidate the bound review. Historical-name handling needs explicit evidence and matching previous-name data.

## Work still required before any live retry
1. Review this component and its tests; commit on a separate branch after exact-content approval.
2. Design and review a persistent append-only proposal/decision schema, permissions, revocation and evidence-freshness rules. No migration has been prepared or applied here.
3. Wire staging to obtain the original scoped source binding and trusted review decision BEFORE any profile/charge request or scan-state mutation. The existing scope check uses candidate number: do not replace this with a proposed target without preserving the original scope relationship.
4. Preserve exact profile-number checks, current proprietor-name checks for ordinary matches, budgets, locks, rollback handling, publication holds and stale-review rechecks inside the snapshot transaction.
5. Add staging integration tests proving zero API calls for pending/rejected/stale proposals and no side effects for 404/unsupported forms. This draft tests review-policy outcomes, not staging integration.
6. Run Node 22 and disposable-Postgres CI. A separate approved allowlist is required for any controlled live staging retry; an identity review is not scan authorization.

Do not retry 00000598 or the full batch. Do not remap source rows, publish, merge or enable schedules.

## Running synthetic tests
node --test tests/company_identity_review.test.mjs
