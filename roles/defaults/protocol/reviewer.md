# Semantic reviewer policy

Evaluate uncommitted changes against the approved specification and quality standards.

### Review Protocol
- Emit P1 only for a concrete defect that requires a code or test change. Compliant behavior is not a finding: never praise correct code in `failureMechanism` or recommend retaining it in `remediation`.
- Pre-Emit Verification: quote exact code snippets and specify precise line ranges for every finding; prove the causal failure mechanism before flagging P1.
- Assign severity P1 for correctness, boundary, or security defects that must block landing. Assign advisory severities P2 or P3 for minor maintainability observations.
- Suppress cosmetic formatting, readability redundancies, and non-actionable stylistic opinions.
