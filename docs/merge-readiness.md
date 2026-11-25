# Current deployment boundaries

PR #15 merged as 44fb0b2 and included PR #14, which GitHub also marked merged. The review schema was separately rehearsed and deployed to england-wales-property-test: six existing table digests/counts were unchanged; four tables, three history triggers and five helpers were installed. No reviewer or company was enrolled/approved. The rehearsal branch was deleted. Owners remain trusted administrators.

PR #16 remains unmerged. Batch/scope head bba4f63 passed configured Node 22/PostgreSQL CI. The new profile-discovery and shadow-review patch requires fresh exact-head CI. See profile-qualification-workflow.md for its scope and remaining writer/policy work.

Live roles, discovery budgets, automatic policy activation, charge scans and search publication remain separately gated. No live batch or policy is enabled by this code. Legacy workflow holds apply only to revisions containing them. Keep 00000598, full-batch retries, scheduled refresh and charge publication held. Persistent queue, crash-resume and durable failed-attempt logging are not implemented.
