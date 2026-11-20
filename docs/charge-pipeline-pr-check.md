# Charge pipeline PR check

The workflow `Charge pipeline integration (disposable database)` runs on pull requests to main when its tracked paths change. In PR #11, open Checks and select this job. The job is not a live import and needs no repository database secret or Companies House API key.

It starts a disposable Postgres 16 service, builds a minimal synthetic schema compatible with the tested SQL, applies both draft tracking migrations to that disposable database, runs component tests and exercises the collector/staging/publishing pipeline with synthetic API responses. It does not connect to Neon.

For integration only, the harness copies the collector and workers into a temporary directory, changing exactly the workers' fixed host constant from the approved Neon host to localhost. It rejects unexpected source templates. The repository's source guards are untouched. This is real Postgres integration with explicitly host-adapted worker copies, NOT an exact-source Neon integration test or a full browser/lender-search test. The CLI runner has component mock tests but is not used by the Postgres harness.

The synthetic tests check repeat-run identifier stability, timestamps, actual SQL rollback after an injected publication failure, status updates, failed scan preservation, zero-charge scans, and cleanup. On failure, the disposable service is discarded when the job ends. There is no schedule, deployment or live import trigger.

The optional workflow_dispatch trigger only appears as a Run workflow button after the workflow exists on the default branch. Before that, use PR Checks. Do not merge PR #11 just to get a button.

The isolated Neon validation branch remains separate. Exact-source Neon integration, validation of the complete lender-search endpoint, any target migration, a bounded live pilot, and the batch/refresh system still require further work and approvals.
