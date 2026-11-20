# Security lender charge import: implementation and release gates

Status: collector component only. No worker, import, migration, scheduler or live API request is enabled by these files.

## Scope

The approved read-only audit found 15,716 eligible active managed CCOD titles and 7,564 distinct syntactically valid company-number candidates in the test database. Another 1,530 eligible titles lacked a candidate in the accepted format. These are audit-time counts, not hard-coded import limits or verified proprietor identities. Recalculate scope before each import.

## Collector

Run unit tests with `node --test tests/collect_company_charges.test.mjs`. Tests use injected mock requests, never live credentials. The collector follows company charge pages within a bounded request budget and only returns a successful snapshot after completion. It rejects inconsistent totals, duplicate IDs, missing identifiers, bad offsets and early termination. Progress callbacks are telemetry, not a safe cross-run page checkpoint: after interruption, restart that company scan from offset zero because upstream pages can change. Equal totals do not guarantee an atomic upstream snapshot.

## Worker still to implement

- Manual-only entry point outside public Netlify Functions, defaulting to dry run.
- Exact approved test host, database and target-marker checks; never fall back to DATABASE_URL.
- Bounded per-run company and request budgets, shared API-key rate budget, timeout, Retry-After handling, backoff and stop-on-authentication-failure behaviour.
- Durable per-company queue claims, leases and retry eligibility, isolated from unrelated existing ingestion jobs. Inspect existing queue consumers before deciding whether reuse is safe.
- Match retrieved company identity to proprietor candidates conservatively; a successful company-number lookup is not ownership verification.
- Collect outside the write transaction. Publish company charges and successful scan state together only after a complete scan; preserve the previous successful snapshot on failure.
- Preserve existing charge IDs. The existing writer prefers charge_number over charge_code; reconcile historical identifiers before introducing a new ID policy.
- Track successful zero-charge scans separately from unprocessed, failed and incomplete scans. Store last attempt and last successful completion independently.
- Preserve charge-change history, handle records absent from later complete scans conservatively, and do not silently label missing records satisfied or delete them.
- Keep explicit title-number matches separate from company-only property associations; expose scan coverage and freshness in the UI.

## Approval gates

1. Commit and run collector tests; this is not approval for live requests or writes.
2. Review and approve any tracking-schema changes separately, first testing migrations on an isolated branch.
3. Approve the exact first-batch companies, API-request budget and database writes. Include Nautilina Limited (15372161), title LN48675, as an acceptance case after rechecking scope and identity.
4. Verify HSBC lender search, idempotent reruns, zero-charge handling, rollback and retry behaviour.
5. Approve remaining batches to cover the entire agreed dataset; validation batches are not permanent coverage caps.
6. Measure throughput and agree freshness targets before enabling recurring runs. Monthly CCOD automation remains disabled. No schedule or credential changes are authorized by this document.
