### Test Philosophy & Verification Invariants
- **4 Shadow Paths:** Verify explicit test coverage for happy, nil, empty, and error paths.
- **Assertion Rigor & Anti-Masking:** Flag tautological tests (`expect(true).toBe(true)`), expected values recomputed from the production algorithm rather than a spec / oracle / literal, tests whose main claim is which internal collaborator was called, fixing failures by deleting assertions, skipping gates, or raising threshold limits.
- **Flakiness & Race Conditions:** Audit for uncoordinated async timing, missing await statements, or reliance on nondeterministic ordering.
