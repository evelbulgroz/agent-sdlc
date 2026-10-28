### Engineering Philosophy Invariants (P1 & Advisory)
- **Correctness & Defensive Handling:** Check for null/undefined hazards, unhandled error paths, and resource leaks.
- **Zero Silent Failures:** Flag any catch-all exception swallow (empty catch block with no typed logging or fail-closed bubble).
- **Atomicity & Concurrency:** Audit for race conditions, atomic file replace hazards, and unhandled signal interrupts.
- **Regression & Behavioral Tests:** Ensure tests cover changed behavior and verify non-happy shadow paths.
- **Module Depth & Test Coupling (P2 advisory only, do not set `hasP1`):** Flag shallow / pass-through modules whose interface is nearly as wide as their implementation, and implementation-coupled tests that mock internal collaborators or assert call counts when the public API can answer.
