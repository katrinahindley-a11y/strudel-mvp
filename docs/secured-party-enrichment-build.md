# Secured-party enrichment: bounded batch collector, stage 1

Goal: broaden lender search by collecting charges for approved companies associated with the scoped CCOD property dataset. Companies House's documented charge-list endpoint is company-scoped; this is not a reverse lender portfolio API.

This component executes the existing reviewed staging worker sequentially using an explicit manifest of companyNumber, proposalId and proposalHash. References are not approvals: the existing worker loads approval events and source bindings from its trusted store before API access and rechecks before saving. No real company manifest, approvals, migrations or credentials are included.

All budgets are mandatory: maximum companies, HTTP requests across the run, charge pages per company and elapsed milliseconds. The initial component accepts at most 100 companies per run, not a 100-company dataset cap. Default is dry-run. Results identify staged, failed and pending companies without raw payloads or errors. Any company failure stops the batch; there are no automatic retries. Successful earlier company transactions remain staged. A failed company's rollback is enforced by the existing staging worker, not by this orchestrator's unit tests.

A database session advisory lock serializes cooperating batch runners on the guarded target. HTTP calls are serialized and paced at least 1.1 seconds apart across this process, with a total request and elapsed-time cap. This is NOT an account-wide limiter: live execution still requires coordination with all other API-key consumers. Review expiry may occur during throttling; live rollout must assess the existing staging recheck boundaries, not treat transport pacing as authorization.

Usage structure (placeholder manifest only): node scripts/run_reviewed_charge_batch.mjs --manifest <approved-manifest.json> --max-companies <approved-count> --max-requests <approved-count> --max-pages <approved-count> --max-run-ms <approved-ms>. --apply is not authorised by this build. Legacy held workflows remain unchanged.

Unit tests inject synthetic staging/HTTP/database dependencies. They test orchestration only, not real SQL lock ownership, authentication, transport errors, database rollback or end-to-end API execution. A disposable-Postgres batch test and Node 22 CI are required before any live pilot. A persistent queue/lease store and crash-resume audit are not implemented in this component.

Search/publication boundary: staged snapshots DO NOT enter public.charges or lender search. This component intentionally keeps publishedToSearch=false. Next stages must design and test reviewed-snapshot indexing/publication and coverage/freshness reporting before claiming a broader user-visible lender search. Do not change the existing lender query to treat company-only associations as confirmed title matches. No match does not mean uncharged. Price paid above GBP 5 million is not current valuation.

No migration, live API call, bulk retry, public endpoint, credential change, schedule, publication or main merge is authorised. Keep 00000598 and the failed batch held. Base: main merge 44fb0b2e9d2f246f4c71dcb4b6d21bde43172aa5.
