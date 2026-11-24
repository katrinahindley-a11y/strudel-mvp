# Identity-review merge readiness and holds

Scope: mergeable reviewed-staging code, not a live-data rollout. No Neon migration, live scan, identifier remapping, charge publication or merge is authorised by this document.

## Verified baseline
At b200315, GitHub reported 10 successful checks, 0 failed and 3 neutral. This included the real disposable-Postgres charge pipeline, reviewed-staging push/PR jobs, identity policy, import/refresh integrations and both release-check contexts. Counts are jobs, not individual tests. The hardening changes in this commit require fresh Node 22 and PostgreSQL verification; do not carry baseline results forward as proof for new code.

## Hardening in this change
The adapter re-reads identity and scan events with fresh database timestamps after acquiring principal and source locks, revalidates approvals and requires unchanged event sequences. Three deterministic clock-model tests and three real lock-wait cases cover expiry before API access. The latter run after the existing reviewed-Postgres suite in the same disposable database and use its restricted reviewer/scanner roles. Existing concurrency tests remain unchanged.

Four historical manual staging/publication workflows are now hold-only jobs: no checkout, secrets, dependency installation or live code. Their names remain for discoverability; dispatching one fails explicitly. This becomes effective for the workflow revisions containing this commit, not historical refs or other branches. Review repository permissions separately before any live rollout. HTTP diagnostic behaviour retains its transport tests; workflow regression tests assert the entire hold-only definitions.

## Before merge
Verify this exact head passes CI. PR #15 contains diagnostic commits through ce75750 from PR #14: these are stacked histories, not independent changes. Recommended order is separately approved review/merge of #14, then refresh and revalidate #15 against the new main. Do not merge either automatically. Confirm main's external deployment configuration before approval; a merge may trigger Netlify production deployment even though SQL and charge publication are not run by CI. PR description/status metadata should be synchronised after exact-head CI; older PR text is historical, not the verification record.

## Not a live release
The SQL remains an unapplied draft. Production role grants, individual reviewer enrollment and the live deployment/migration plan require separate approval. Legacy CLI calls without references fail closed; the dedicated reviewed CLI stages only. Reviewed snapshots remain blocked by the unchanged legacy publisher. Failed staging transactions preserve prior state; durable failed-attempt logging is an unresolved operational design decision. Keep 00000598, the full failed batch and charge publication on hold.
