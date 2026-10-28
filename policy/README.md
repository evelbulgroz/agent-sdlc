# Policy, Authorization, Planning & Reliability (`packages/agent-sdlc/policy/`)

Run Authorization Envelope validation, Task DAG planning and serialization rules, state and schema contracts, typed error taxonomy (`SdlcError`), and offline reliability replay and hosted canary qualification.

## Key Files & Entrypoints

- `packages/agent-sdlc/policy/authorization.ts` — `RunAuthorizationEnvelope` creation, cryptographic hash binding, scope derivation (`deriveScopeFromDraft`), and operation permission guards.
- `packages/agent-sdlc/policy/task-planner.ts` & `packages/agent-sdlc/policy/policy-gate.ts` — Task DAG planning, per-task complexity scoring (`<= 20`), topological serialization, and contract-sink synthesis.
- `packages/agent-sdlc/policy/contracts.ts` — Closed state schemas, allowed tool definitions (`ALLOWED_TOOLS`), and structural validators (`policy/contracts/*`).
- `packages/agent-sdlc/policy/errors.ts` — `SdlcError` and `SDLC_ERROR_CODES`.
- `packages/agent-sdlc/policy/reliability.ts` & `packages/agent-sdlc/policy/canary-planning-files.ts` — Offline reliability corpus replay, read-only SQLite reliability reporting, and hosted canary qualification (`policy/reliability/*`).
- `packages/agent-sdlc/policy/reversible-decisions.ts` & `packages/agent-sdlc/policy/local-policy-fingerprint.ts` — Standard repository decision rules and local model-usage policy fingerprinting.

## Core Invariants

1. **Run Authorization Envelope (`authorization.ts`):**
   Execution past `SPEC_APPROVED` requires an affirmative envelope binding:
   - `approvedSpecHash`: SHA-256 of the approved specification.
   - `approvedPlanPolicyHash`: SHA-256 of authorization *inputs* (`runId`, `approvedSpecHash`, `baseCommitSha`, sorted packages/paths, `maxSemanticRepairs`, git flags) — distinct from runtime `taskPlanHash`.
   - `baseCommitSha`: Git commit from which worktrees branch (a later repo `HEAD` does not invalidate an in-flight envelope).
   - `allowedPackages`, `allowedPathPrefixes`, `maxSemanticRepairs` (default `2`), and `expiresAt`.
   - `allowedOperations`: `editIsolatedWorktree`, `runAllowlistedCommands`, and `createDetachedWorktree` must be `true`; `createBranch`, `createLocalCommits`, `push`, and `openPullRequest` are opt-in; `merge` and `deploy` fail closed if `true`.

2. **Task DAG Planning & Serialization (`task-planner.ts`):**
   - Optional sibling `--task-plan-file <path>` (`schemaVersion: "1.0.0"`) groups `enabling`, `vertical`, and `activation` slices. Every frozen `AC-NN` has exactly one non-enabling owner.
   - Per-task ceilings: $\le 5$ ACs, $\le 8$ authored paths, $\le 5$ path prefixes, $\le 3$ delivery layers, $\le 1$ dependency mutation, and complexity score $\le 20$ (`TASK_DECOMPOSITION_REQUIRED`, exit `64`).
   - Shared kernel tasks (`packages/*`) serialize before dependent consumers; contract producers (`registry`, `authentication`) serialize before consumers (`api-gateway`, `pwa-frontend`).

3. **Reliability Replay, Stratified Reporting & Hosted Canary Gate (`reliability.ts`, `policy/reliability/report.ts`, `policy/reliability/canary.ts`):**
   - `agent-sdlc reliability report [--json]` (`packages/agent-sdlc/policy/reliability/report.ts` and `packages/agent-sdlc/policy/reliability/run-evidence.ts`) aggregates read-only run evidence across live and archived runs into overall rates (`taskCompletion`, `validEdit`, `firstPassVerification`, `repairSuccess`), stratified metrics (`strata` by `complexityBand`, `targetPackage`, `deliveryLayers`, `highRisk`, `routeId`, `modelId`, and `failover` with `latencyMs`, `inputTokens`, `outputTokens`, and `costMicrousd` distributions), head-to-head matched `routeComparisons`, and ranked `failureRecurrence` tables.
   - `agent-sdlc reliability replay --json` validates the closed corpus (`packages/agent-sdlc/testing/reliability-corpus/`) with provider credentials removed (`providerOperations: 0`).
   - `agent-sdlc canary check` and `canary qualify --run <run-id> --json` enforce hosted canary qualification (1 vertical slice/task, $\le 2$ ACs, $\le 3$ authored files, complexity $\le 10$, non-high-risk, no contract/dependency/generated outputs, `0` rejected mutations, `0` semantic repairs, green verification + QA critic), writing mode-`0600` evidence to `<stateDir>/canary-qualification.json` (e.g. `tools/.agent-sdlc/canary-qualification.json`).
   - **Hash Binding & Staleness:** Qualification binds five hashes—`repositoryId`, `workflowHash`, `boundedPlanningHash` (`packages/agent-sdlc/policy/canary-planning-files.ts`), `implementerRoleHash`, and `modelPolicyHash` (`.agents/model-usage-policy.json`). Any drift in those four code/policy hashes marks the receipt `CANARY_STALE` (or `CANARY_REQUIRED` if missing/failed), blocking non-canary multi-task runs; documentation-only commits (`*.md`) preserve qualification across `HEAD` advances.
   - **Failure Categories & Unmerged-Fixture Invariant:** Qualification classifies failures into `STALE_BASE_COMMIT`, `IMPLEMENTER_NON_COMPLETED`, `REPAIR_INVOKED`, `INVALID_EDIT`, `VERIFICATION_FAILURE`, and `QA_ACCEPTANCE_DIVERGENCE`. Because `packages/agent-sdlc/execution/ac-coverage.ts` treats `@ac` tags already present on `HEAD` as `baselineTestCitations`, a standing canary fixture must stop at `READY_FOR_GIT_APPROVAL` and **never** be merged into `main`.

## Error Taxonomy (`SdlcError`)

| Category | Error Codes (`packages/agent-sdlc/policy/errors.ts`) |
|---|---|
| **Input & Contract** | `INVALID_INPUT`, `INVALID_CONTRACT`, `INVALID_TRANSITION`, `PATH_OUTSIDE_ROOT`, `PATH_CONTAINMENT_VIOLATION`, `INPUT_OVERSIZED` |
| **Run & Lifecycle** | `RUN_NOT_FOUND`, `RUN_ALREADY_EXISTS`, `RUN_CANCELLED`, `RUN_REJECTED`, `STALE_RESPONSE`, `INTERRUPT_RESOLVED` |
| **Authorization** | `AUTHORIZATION_INVALID`, `AUTHORIZATION_EXPIRED`, `OPERATION_NOT_PERMITTED` |
| **Governor Bridge** | `GOVERNOR_UNAVAILABLE`, `GOVERNOR_BUDGET_DENIED`, `GOVERNOR_CONCURRENCY_DENIED`, `GOVERNOR_ROUTES_EXHAUSTED`, `GOVERNOR_RUN_DEADLINE_EXPIRED`, `MODEL_OUTPUT_INVALID`, `BUDGET_EXHAUSTED` |
| **Worktree & Execution** | `WORKTREE_DIRTY`, `WORKTREE_FAILED`, `HYDRATION_FAILED`, `PREFLIGHT_FAILED`, `REPAIR_BUDGET_EXCEEDED`, `HIGH_RISK_PATH_VIOLATION`, `TASK_PLAN_INVALID`, `TASK_EXECUTION_FAILED`, `ROLE_EXECUTION_FAILED`, `CAPACITY_LIMIT_EXCEEDED` |
| **Reconciliation & Git** | `RECONCILIATION_CONFLICT`, `GIT_COMMIT_FAILED`, `BRANCH_ALREADY_EXISTS`, `BRANCH_ALREADY_CHECKED_OUT`, `POLICY_VIOLATION`, `INVALID_DECISION_RULE` |
| **Critic Review** | `AUTHOR_VENDOR_UNKNOWN`, `IDENTICAL_REVIEWER_VENDOR`, `CRITIC_REVIEW_FAILED` |
| **Storage & Store** | `STORE_BUSY`, `STORE_CORRUPT`, `STORE_VERSION_UNSUPPORTED`, `STORE_RECONCILIATION_FAILED`, `ARTIFACT_CORRUPT`, `PROJECTION_DRIFT`, `INTERNAL_ERROR` |
