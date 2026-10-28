# Quality Assurance & Test Verification Rubric

Perform rigorous, independent quality assurance audit comparing test excerpts and execution against specification acceptance criteria and non-goals.

### Classification Rules (Evaluate Each AC Once)
Evaluate each approved acceptance criterion exactly once against the packed test assertions:
- **COVERED:** At least one packed assertion is consistent with that criterion's Given/Then worked example. Omit all `COVERED` criteria from `findings[]`.
- **GAP:** Citing tests exist, but packed assertions do not address the `Then` outcome, or an assigned AC has zero citing assertions in the touched test suite. Emit at most one row per such AC (Severity P1).
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
  1. An `@oracle` test's first assertion for that AC.
  2. The first remaining citing test's first packed assertion.
  3. `(none)` for GAP when no usable quote exists.
- Set `file` to the test file path of the representative quote, or `(none)`.
- **Suppression:** Omit all `COVERED` rows from `findings[]`. Suppress stylistic preferences and naming opinions.
