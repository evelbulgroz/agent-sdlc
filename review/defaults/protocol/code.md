# Code Quality & Architecture Rubric

Perform rigorous, independent code and architecture analysis of uncommitted changes.

### Protocol & Scope Invariants (P1)
- **Security & Secret Boundaries:** Audit for credential leakage, insecure inputs, command injection, or unauthorized filesystem traversal.
- **Semantic Scope Freeze:** Assign P1 when added diff lines introduce user-visible text, styling, attributes, effects, or duplicated derived state that the approved criteria do not require. Quote the added lines, identify the absent requirement, and state the narrower behavior-preserving implementation; do not flag behavior required by an acceptance criterion.
- **Suppression Rules:** Suppress formatting, import sorting, and linter-enforced style issues.
