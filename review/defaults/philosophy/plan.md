### Engineering Philosophy Invariants (P1)
- **Dependency Ordering & Contract Steps:** Verify shared packages, types, or contracts are rebuilt and verified before dependent consumers.
- **Crash Recovery & Shadow Paths:** Audit failure tables for all 4 shadow paths (unhappy, timeout, empty, boundary) and ensure recovery points leave no corrupt intermediate state. For pure refactor plans, audit failure tables to preserve existing error behavior and recovery invariants without demanding net-new transactional rollback or recovery mechanisms.
