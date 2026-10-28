### Engineering Philosophy Invariants (P1 & Advisory)
- **Bounded-Context & Module Depth:** Check clear module/package boundary ownership. Reject unauthorized cross-package coupling or shallow pass-through layers.
- **Failure Defenses & Shadow Paths:** Verify explicit handling for unhappy paths, nil/empty payloads, timeouts, network/store failures, and process interruption. For pure refactorings, failure defenses must focus on preserving existing error semantics, swallows, and invariants without demanding net-new transactional rollback or recovery infrastructure.
- **Race Conditions & Concurrency:** Check for atomicity, lock recovery, and shared state risks.
- **Non-Goals & Scope Posture:** Ensure explicit non-goals bound the work. Flag scope creep or unaddressed forcing questions.
- **Architecture Decisions (P2 advisory only, do not set `hasP1`):** If the spec keeps a trade-off that is hard to reverse, surprising without context, and had a real alternative, and no matching ADR exists, flag that the operator should be offered an ADR. Do not write ADR files.
