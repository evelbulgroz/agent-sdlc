# Integration preflight

Status: retired 2026-11-11. The three intents are implemented on `c5e6476` and kept here for reference. This file is an index. It is not a goal. Do not pass it to `check-spec`.

The 2026-11-10 draft that dispatched an autonomous remedy on the integration worktree, added `INTEGRATION_REPAIR`, and added `shell reply` flags is withdrawn. Reconciliation rebuilds that worktree from task diffs, and `REPAIRING_FAILURE` cannot re-enter preflight.

Retired intents:

- [integration-failure-status.md](integration-failure-status.md) is phase 1. It projects the halt path, the existing failure classification, and a closed category. A non-zero host exit still reads a result file that exists. It authorizes no write.
- [retirement-target-paths.md](retirement-target-paths.md) is phase 2. One scan at plan freeze closes the union of tasks marked `retirement`, assigns each eligible sibling to exactly one of those tasks, and owns `policy/static-import-graph.ts`. A `node:` import and a package subpath that names no walked file are not blockers. A bare specifier that names a walked file is. The critic recomputes blockers when process memory has none, and that recompute does not change the plan hash. A package coverage gate stays deferred. The full host preflight still runs once.
- [operator-integration-correction.md](operator-integration-correction.md) is phase 3, the residual card. It resolves an owner when the walker cannot prove the path, or the run has already halted, records a new task tree without a quality checkpoint, and uses the phase-2 walker as the proof. `stop` consumes the card, leaves task trees unchanged, and the next continuation is `stop`.

Autonomous deletion stays out. A transition that skips reconciliation and re-enters `VERIFYING_PREFLIGHT` stays out.
