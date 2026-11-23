# Identity-review storage and preflight: UNDEPLOYED DRAFT

## Included
- Draft append-only proposal/event schema and database-login-authenticated review function.
- Deny-by-default reviewer allowlist, expiry (maximum seven days), revocation through newer events, immutable review history.
- Preflight coordinator and synthetic negative tests checking that scan callbacks are not invoked for unapproved/expired/disabled/mismatched reviews.

## Exact scope of testing
The JavaScript coordinator is tested using an in-memory trusted-store fixture, synthetic identity policy and synthetic scan callback. These are NOT tests of the actual staging module, authenticated PostgreSQL sessions, SQL permissions or live APIs. The draft SQL has not been executed, syntax-tested against PostgreSQL, or applied to any database. Node 22 CI remains outstanding for these new files.

## Integration still required
1. Implement the server-only store adapter. It must load the newest event by event_sequence DESC, join current reviewer-enabled status, and lock the proposal row FOR UPDATE in the SAME transaction used to authorise and commit the scan. Do not accept reviewer identity or scanAuthorization objects from HTTP/CLI callers.
2. Connect verifyIdentity to company_identity_review.mjs with a current, scoped source record and trusted profile evidence. A source row must match the original CCOD release/title/proprietor binding; require active managed membership and price-paid scope independently.
3. Recheck reviewer status, newest event, expiry, source and scan authorization immediately before fetching and again before snapshot commit. The coordinator in this draft is only a preflight, NOT the transactional final check; no claim of race-free staging enforcement is made.
4. Add an authenticated, expiring and revocable scan-authorization store. The current fixture object is only a test interface, not a production authority.
5. Use individually authenticated database reviewer logins, not the shared backend/CI connection. Deployment must separately verify role grants and that broad existing roles do not retain INSERT/UPDATE/DELETE privileges. Owners/superusers remain trusted administrators and can bypass trigger protections. No users/roles are created or enrolled by this draft.
6. Grant reviewers EXECUTE only on append_identity_review_event plus schema USAGE, never direct event INSERT. Give the proposed scan-reader role only required SELECT privileges. Grants and credentials need separate review. Keep proposal creation restricted to a trusted server process that validates canonical proposal hashes; JSONB serialization must NOT be substituted for the JavaScript canonical hash format.
7. Run tests against disposable Postgres with real reviewer and denied logins, verifying spoofed actor rejection, immutable history, sequence ordering, revoke/expiry and concurrency. Do not apply this draft just to run these tests.
8. Wire the existing staging entry point only after these checks. Existing application staging, publication, API budgets, endpoint guards and source records are unchanged by this draft.

No live retries, remapping, publication, scheduling, production merge or database migration are authorised. Do not retry 00000598 or the full failed batch.
