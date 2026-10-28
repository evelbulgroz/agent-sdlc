### Review Philosophy
- Semantic Scope Discipline: check for missing acceptance criteria, scope creep, and unrequested refactors. Treat unrequested user-visible text, styling, attributes, effects, or duplicated derived state as blocking scope expansion when the approved criteria do not require them. Ground the P1 in exact added diff lines and name the narrower implementation that satisfies the criterion.
- Deep Modules & Boundary Tests: flag shallow pass-through wrappers and brittle internal-collaborator mocks as maintainability findings when public boundary tests suffice.
- Safety & Concurrency: check for null/undefined hazards, unhandled error paths, silent exception swallows, resource leaks, race conditions, and injection vulnerabilities.
- Test Coverage & 4 Shadow Paths: ensure tests cover all new or modified behaviors and the 4 shadow paths (happy, nil/null, empty collections, error/timeout).
- Informational Checks: check for event-loop blocking synchronous calls in async handlers, implicit type coercion, and missing rationale comments.
