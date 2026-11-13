# Quality Assurance & Test Verification Rubric

Audit the packed test excerpts against the acceptance criteria and non-goals.

### Classification Rules (Evaluate Each AC Once)
Evaluate each approved acceptance criterion exactly once against the packed test assertions:
- **COVERED:** A citing test is `COVERED` when any packed assertion in that test addresses the Then. A later packed assertion can satisfy the Then when the first assertion does not. A first assertion that only checks a result wrapper is not a GAP when a later packed assertion in that test addresses the Then.
- **GAP:** GAP requires that no packed assertion in the citing tests addresses the Then. An assigned AC with zero citing assertions in the touched test suite is also a GAP. Emit at most one row per such AC (Severity P1).
- **DIVERGENT:** A citing test's assertion contradicts the stated `Given/Then` example. Emit at most one row per such AC (Severity P1).

### Overspecification (OVERSPEC)
- **OVERSPEC:** Flag any test assertion that asserts behavior the specification does not ask for AND that contradicts an explicit non-goal. Emit one row per offending test/assertion (capped at 10 findings; Severity P2).

### Representative Evidence Format
In `findings[]`, encode the classification and AC id in `evidence`:
- Format: `<LABEL> <AC-NN>: <explanation>. Representative quote: <assertion line>`
  - Example: `GAP AC-02: Citation exists but assertion verifies status only without checking aggregate write. Representative quote: expect(res.status).toBe(200);`
  - Example: `DIVERGENT AC-03: Assertion expects 200 OK but Given/Then requires 401 Unauthorized. Representative quote: expect(res.status).toBe(200);`
  - Example: `OVERSPEC: Test asserts real-time WebSocket sync forbidden by non-goals. Representative quote: expect(ws.connected).toBe(true);`
- Quote preference order:
  1. Prefer an `@oracle` test's assertion that addresses the Then. The representative quote is the packed assertion that addresses the Then rather than the first packed assertion.
  2. For GAP, the closest packed assertion.
  3. `(none)` for GAP when no usable quote exists.
- Set `file` to the test file path of the representative quote, or `(none)`.
- **Suppression:** Omit all `COVERED` rows from `findings[]`. Suppress stylistic preferences and naming opinions.
