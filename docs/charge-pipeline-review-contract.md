# Charge pipeline regression repair

Test-only repair for PR #15, based on e0f4884. No application, migration, live workflow or publication-policy changes. Existing CI commands already run these component files and the disposable PostgreSQL harness.

Component fixtures now create hash-bound synthetic proposals, separately approved identity/scan events, fresh timestamps and original proprietor source records. Negative cases retain missing/held-review, scope, host, lock, profile, collector, transport and snapshot-failure assertions. No approval bypass is added.

The PostgreSQL harness supplies all source columns, applies all three draft migrations only to an empty localhost CI database, copies all staging dependencies, and exercises reviewed staging with stored approvals. It explicitly verifies that the unchanged publisher rejects current reviewed snapshots without public writes. Legacy publication is exercised with independently seeded legacy-status snapshots, never by changing a reviewed snapshot's status. Existing ID stability, timestamp, transaction rollback, status-update, incomplete-scan preservation, zero-charge and cleanup coverage remains. Cleanup drops exclusively created disposable fixtures because review history deliberately rejects DELETE/TRUNCATE.

Failure-state contract: the current reviewed staging transaction rolls back failed work, retaining prior successful and published pointers and tracking state. Tests assert this current behaviour rather than asserting the old post-rollback failed-state write. No durable failed-attempt record is implemented or promised. Whether to introduce separate append-only attempt logging is an outstanding operational design decision, not resolved by this test patch. Existing pure diagnostic mapping and sanitisation coverage is retained.

Local checks: changed component tests pass against local source copies on Node 20.20.2 with simulated SQL; some supporting source copies are formatting-normalised from retrieved source. Exact committed-file Node 22 and real PostgreSQL verification remain CI requirements. This patch has not yet passed PostgreSQL CI. No live scan, remapping, Neon SQL or merge is authorised.
