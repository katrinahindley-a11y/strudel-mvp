# Secured-party enrichment: batch integration build

Base: feature head 16a5b9c. This patch is not a live release or merge approval.

## What changed
Batch orchestration now uses a private staging-transaction dispatch callback. After HTTP-client pacing and the batch's own pacing, and before each synthetic/live fetch dispatch, the callback re-reads trusted review/source state using the same staging transaction. Both review event sequences must remain bound to the original authorization. The callback is cleared at staging and company completion. Missing registration fails closed. This closes the batch transport-wait approval gap; it does not change the legacy standalone CLI's pacing behavior.

The actual HTTP client sanitizes fetch exceptions. Batch orchestration now separately retains pre-dispatch budget/authorization failures for safe diagnostic reporting instead of losing them as generic transport failures. Raw errors remain sanitised. Global request counts increment only for dispatched fetches, not rejected approvals or budget checks. Timeout signals are checked again before dispatch.

## Verification scope
The component tests use the actual createBudgetedClient function with synthetic fetch responses and simulated SQL/staging. They retain the original 18 assertions/scenarios and add authentication, rate-limit, network-error, post-pacing expiry, missing-hook and unlock-warning cases (25 tests). Local execution is Node 20.20.2; local supporting copies include the unchanged HTTP-client function and parser plus a diagnostic fixture limited to exercised codes. Exact repository Node 22 CI remains authoritative.

A new PostgreSQL suite runs after reviewed_charge_postgres.test.mjs in the same disposable database, reusing its restricted reviewer/scanner roles and source fixture. It loads actual batch/staging/client source into temporary copies; only the exact expected host literals are changed to localhost in those copies. It tests two companies, stored approvals, batch-lock competition/release, second-company snapshot failure with first-company preservation, the global HTTP budget, 429/401/403 stopping, and identity/scan expiry during a controlled pacing delay. APIs remain synthetic; no live credentials are supplied. Real PostgreSQL execution has not yet been performed for this patch. Existing standalone staging regression suites also run unchanged in PR CI.

## Still held and still incomplete
No public endpoint, lender query, identifier mapping, Neon schema, credential, schedule, publication policy or main branch is changed by this patch. Staged snapshots do not enter lender search or public.charges. The four legacy workflow holds and 00000598/full-batch holds remain. An approved live manifest and exact budgets are required separately. Per-process pacing and cooperating-runner locking are not an API-account-wide limiter. A persistent queue, crash-resume audit, reviewed search indexing/publication and UI coverage/freshness remain later work. Recorded price paid above GBP 5 million is not current valuation; company associations are not verified title security.
