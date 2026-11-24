# Identity-review policy

Current status and remaining gates are recorded in [merge readiness](merge-readiness.md). This supersedes the earlier preparatory-draft status in this document.

The reviewed staging adapter, hash-bound source checks and separate identity/scan approvals are implemented. Baseline b200315 passed configured Node 22 and disposable-Postgres CI. New post-lock expiry hardening must pass its own CI before merge readiness is asserted. SQL remains unapplied to Neon; live grants, scans, remapping and publication are not authorised.

Failed scans roll back and preserve prior pointers; durable failed-attempt logging is not implemented. The standalone preflight coordinator is preparatory/server-internal, not a replacement for transactional staging enforcement. See the readiness document for legacy workflow holds and PR #14/#15 ordering.
