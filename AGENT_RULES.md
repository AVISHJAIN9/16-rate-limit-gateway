# Agent Rules

1. Start from the exact feature block, read the relevant spec text, and implement only that feature’s scope. Do not drift into adjacent work.
2. Re-read the feature name and the block’s tests before coding. If the intent is ambiguous, state the interpretation in one paragraph, implement only the defensible behavior, and record the ambiguity in KNOWN_GAPS.md.
3. Write failing tests first for the happy path, edge cases, and failure handling for the current feature.
4. Implement the minimum code required to satisfy the failing tests, keeping all decision logic pure and separate from I/O.
5. Run the typecheck, lint, and full test suite before moving on. If any step fails, stop and fix the root cause.
6. Keep all time in the codebase flowing through an injected Clock interface; do not call Date.now() or process.hrtime() inside decision logic. Tests must not sleep; use fake clocks instead.
7. Treat Redis tests as real integration tests: use a unique key prefix per test, clean up keys, and fail loudly when Redis is unreachable. Use ephemeral ports for local servers and clean up all timers, sockets, and file handles.
8. Preserve earlier behavior and do not weaken or delete existing tests. If a test must change, explain why in the report and keep the change narrowly scoped.
9. The line-count requirement: every generated or edited artifact that is expected to be human-readable must remain explicit, reviewable, and proportionate to the implementation. Do not add noisy boilerplate or meaningless filler. The repo must remain easy to audit.
10. Update CONFIG.md and KNOWN_GAPS.md whenever a design decision is added, changed, or intentionally left unresolved.
11. Never log, print, or commit secrets, keys, tokens, or private certificate material.
12. Do not touch features or code outside the block. Do not add placeholders marked DONE or fake verification.
13. If work is blocked, record the exact reason and mark the item BLOCKED or UNVERIFIED rather than pretending it passed.
14. The end-of-task report must contain the full gate output, the feature table, test evidence, and the exact files touched.
