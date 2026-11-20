# Manual single-company charge pilot

This is a manual pilot runner, not the 7,564-company batch queue or recurring refresh system. No live run is authorized by committing it.

## Safe default

`node scripts/run_company_charge_import.mjs --company 15372161`

Without `--apply`, this only validates arguments and prints a plan. It does not connect, call Companies House or inspect live scope. This offline plan is not a database preflight.

## Separately approved staging run

Use `--apply` only after the exact company, request budget and database writes are approved. The runner uses only the existing `CCOD_TEST_DATABASE_URL` and `COMPANIES_HOUSE_API_KEY` environment variables. It never reads DATABASE_URL and never prints either secret. It does not automatically load a .env file or request credentials.

The only permitted database host is the existing guarded england-wales-property-test endpoint. The isolated validation branch is NOT allowed by these modules; approving a separate endpoint and scoped integration harness is required to execute the full JavaScript pipeline there. SQL path tests are not an end-to-end worker test.

Tracking migrations must be tested and separately approved for the intended target before applying a live run. They are currently only applied on the isolated validation branch, not the app's test database.

Stage at most one explicitly selected company, defaulting to 10 charge pages, 100 records per page and 12 total HTTP requests including the company profile. A page/request budget is a per-run safeguard, not a permanent coverage cap. An incomplete company must be retried from the beginning with an approved sufficient budget.

Requests are serialized and paced at least 1.1 seconds apart within this process. All HTTP/authentication/rate-limit failures stop further requests. There are no automatic retries. Respect Retry-After and coordinate with other consumers of the same API key before manually retrying; this local budget is not a shared account-wide limiter.

## Separately approved publication

`--publish-scan <actual-staged-scan-UUID> --apply` is a separate operation requiring review of that exact snapshot. Staging never publishes automatically. Publication does not make API requests. It refuses ambiguous identifiers or missing historical charges, and does not delete records.

A full batch orchestrator, shared-key request limiter, retry queue, alerts, UI freshness indicators and scheduled activation remain to be implemented. Monthly automation stays disabled.
