# Reviewed staging integration - feature branch only

This change replaces the actual stageCompanyChargeScan entry point with database-backed identity and separate scan-permission checks. Every apply requires identityReview with a proposal ID and hash. The original source title, proprietor position, release, candidate and raw registration remain separate from the approved target number.

The dedicated run_reviewed_company_charge_import.mjs CLI accepts --identity-proposal and --identity-hash and reuses the existing guarded connection and budgeted HTTP client. It cannot publish. Legacy staging calls without a review reference fail closed; existing batch workflows are not given references or dispatched.

The migration replaces an UNAPPLIED draft. It is not an upgrade script for a deployed review schema. No production grants, reviewer enrollment or real corrections are supplied. SECURITY DEFINER lock helpers avoid granting scanner UPDATE on source or reviewer tables. Owners/superusers remain trusted administrators.

The scan holds a proposal lock across requests; authenticated decision writers take the same lock. Revocation requests during a running scan wait rather than cancelling an in-flight HTTP request. Reviewer/source rows are shared-locked and expiry is rechecked before snapshot commit. Separate scan events are single-use for successful snapshots. Failed attempts roll back; prior pointers are preserved, but no durable failed-attempt log is written after rollback.

Validation: the preceding local implementation passed 29 Node 20 tests against simulated SQL responses. This commit packages a dedicated reviewed CLI and combined regression file; GitHub must validate the exact committed files. Real PostgreSQL tests and Node 22 checks have not yet passed. The new push workflow runs them on disposable Postgres 16 with synthetic APIs and individually authenticated test roles. No live API credentials are supplied.

Before merge: resolve CI failures, add/run competing-transaction and expiry-during-request tests, migrate legacy staging/CLI/diagnostic fixtures and the old Postgres harness to the required approval contract, and run the full repository regression suite. Old tests assuming apply without review must not be reported as passing. Publication of identity_review_approved snapshots is not implemented or authorised.

No Neon migration, live retry, remapping, publication, scheduling, main merge or modification of PR #14 is authorised. Do not retry 00000598 or the full failed batch.
