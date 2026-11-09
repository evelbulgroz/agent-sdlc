# Workflow State Graph, Worktrees & Reconciliation (`workflow/`)

LangGraph JS/TS state machine orchestration, specification hashing, detached git worktree isolation, lazy workspace hydration, binary patch reconciliation, and authorized git branch/commit delivery.

## Key Files & Entrypoints

- `workflow/graph.ts` & `workflow/graph-topology.ts` — LangGraph state graph wiring, node transitions, and checkpoint persistence.
- `workflow/nodes/` — Modular graph node implementations (`spec-interview.ts`, `spec-draft.ts`, `approval.ts`, `authorization.ts`, `planning.ts`, `workspace.ts`, `execute-tasks.ts`, `reconcile.ts`, `review-qa.ts`, `commit.ts`, `finish-run.ts`).
- `workflow/specification.ts` & `workflow/acceptance-criteria.ts` — Specification completeness checks, `AC-NN` grammar validation, and `approvedSpecHash` binding.
- `workflow/worktrees.ts` & `workflow/worktree-guard.ts` — Detached worktree lifecycle and `assertPlanFrozenThenCreateWorktree` enforcement.
- `workflow/hydration.ts` — Lazy worktree dependency installation and host-declared `hydration.steps`.
- `workflow/checkpoint-hydration.ts` — Optional no-install preparation port on an injected `HydrationRunnerFn.checkpointHydration`. Only frozen, authorized checkpoint plans may select it; run/spec/base/plan, adapter and write scopes must match. Frozen preparation files are verified on every reuse, changed preparation fails without installation fallback, and its identity enters candidate preparation hashes. Legacy hydration ignores the port.
- `workflow/reconciliation.ts` — Topological binary patch extraction, `git apply --check` dry-run validation, and integration worktree assembly.
- `workflow/git-manager.ts` & `workflow/landed-check.ts` — Opt-in local branch creation, structured commit formatting, remote push, and blob-level `main` landed checks.
- `workflow/preflight-gate.ts` & `workflow/fleet.ts` — Preflight verification gating and fleet friction/learning-debt scanning.
- `workflow/task-quality-session.ts`, `workflow/quality-checkpoints.ts`, and `workflow/checkpoint-materialization.ts` — Explicit v2 task evidence, eligible slice closures, registered immutable snapshots, and checkpoint dispatch.
- `workflow/nodes/quality-answer.ts` and `workflow/quality-correction-runner.ts` — Human adjudication, approved owning-task edits, consumer rematerialization, staged revisions, and atomic correction completion.

## Core Invariants

1. **Plan-Frozen Worktree Guard (`worktree-guard.ts`):**
   Every production call to `createDetachedWorktree` (`prepare_workspace`, `TaskExecutor`, `resetIntegrationWorktree`) passes through `assertPlanFrozenThenCreateWorktree` and fails closed with `POLICY_VIOLATION` unless `taskPlanFrozen === true`.

2. **Detached Worktree Topology & Lazy Hydration (`worktrees.ts`, `hydration.ts`):**
   - **Single-task runs:** `tools/.agent-sdlc/<run-id>/worktree`
   - **Multi-task DAG runs:** `tools/.agent-sdlc/<run-id>/worktrees/<task-id>` plus `tools/.agent-sdlc/<run-id>/worktrees/integration`
   - Explicit `checkpoint-evidence-v1` runs also register flat `checkpoint-worktrees/<checkpoint-id>` snapshots. Their final candidate always uses `worktrees/integration`, including single-task plans.
   - Dependent tasks initialize from synthetic parent commit objects (`git commit-tree`) derived from preceding task trees without polluting repository branch refs. Synthetic identity and dates are fixed so identical tree/parent/message inputs survive retries; persisted parent commits are checked against the actual expected tree before reuse.
   - Worktrees hydrate lazily via `pnpm install --frozen-lockfile`, and the host-declared `hydration.steps` (for example setup scripts and scoped package builds).
   - The hydration fingerprint covers installation inputs only (lockfile and manifests); a `CACHED` result is not evidence that compiled artifacts are current. Hosts that need fresh upstream builds declare `verificationPreparation` (see [`../host/README.md`](../host/README.md)).

5. **Verification Preparation Binding (`nodes/planning.ts`, `preflight-gate.ts`, `nodes/commit.ts`):**
   - `plan_tasks` re-checks the authorized `preparationPolicyHash`, derives each task's prerequisite-build selection plus the union for final verification, and freezes their digest as runtime-state `preparationSelectionHash` in the `TASK_PLAN_GENERATED` transition (absent for hosts without preparation; `taskPlanHash` is unchanged).
   - Integration preflight and committed-tree verification run the union builds immediately before the host verify command (`execution/verification-preparation.ts`); a failed build returns `FAIL` without running verify.

3. **Binary Patch Reconciliation (`reconciliation.ts`):**
   - Task deltas are extracted using isolated git index files (`GIT_INDEX_FILE`) and applied sequentially to `worktrees/integration` in topological order after `git apply --check` and realpath containment checks. Patch capture, quality hashes, application, and archival preserve raw bytes, including non-UTF-8 source and Git binary patches.
   - **Zero automated LLM merge:** Patch conflicts trigger a `reconciliation_conflict` interrupt and halt for operator intervention (`continuation.action: 'answer'`).
   - High-risk task plans trigger a `high_risk_review` interrupt after task verification and before reconciliation.
   - Explicit v2 plans yield at completed vertical and activation slices before releasing cross-slice consumers. Verified enabling closures and accepted reviewed closures are both eligible predecessor bases, including sibling task deltas. Final reconstruction applies one selected completed delta per task, never an additional checkpoint delta.
   - `graph-config.ts` allocates the extra QA/implementation graph cycles from the frozen slice count (or the approved obligation bound before freeze), without increasing evidence, repair, or provider budgets.
   - A quality correction changes only explicitly named owning tasks; affected started consumers are rematerialized in frozen order. Revisions and rebuilt closures stay staged until correction completion atomically selects them. An interrupted, unconfirmed source-edit attempt cannot replay its approval automatically.
   - Corrected final reconstruction persists immutable candidate intent and reset/checkout progress before changing the integration worktree. Recovery accepts only the recorded prior/base/target tree appropriate to that phase and reuses the same candidate and evidence operations without refilling budgets; unrelated source edits fail closed.
   - Recoverable correction interruptions retain the consumed answer for bounded infrastructure recovery. Deterministic conflicts, interrupted edits, and unrecognized source/provenance instead create a new `quality_review` interrupt bound to the failed staged candidate and observed source trees. Its only action is `confirm`: acknowledge the failure and halt, without accepting edits, replaying QA/execution, or refilling budgets. A fresh correction over uncommitted failed staging is not authorized by that acknowledgement; it would require a separately defined supersession contract.

4. **Local & Remote Git Delivery (`git-manager.ts`, `nodes/commit.ts`):**
   - Without git authorization flags, verified runs halt at **`READY_FOR_GIT_APPROVAL`** with an uncommitted worktree and explicit operator instructions. The main checkout `HEAD` is never mutated.
   - When `createBranch: true` and `createLocalCommits: true` are authorized in the envelope, the workflow checks branch collisions (`git show-ref`), formats a structured commit (`Decisions:`, `Remaining:`, `Tried:`), re-runs canonical preflight on the clean committed tree, and transitions to **`DONE`**.
   - Opt-in `push` and `openPullRequest` require local commits; `merge` and `deploy` are permanently forbidden.
   - Checkpoint-quality delivery validates the recorded commit/tree against the authorized local branch, including reused commits. Graph pushes and the CLI push pin the exact recorded SHA (`<sha>:refs/heads/<branch>`, never forced), so branch movement cannot publish an unreviewed recommit. Branch drift detected before push fails closed; movement after the binding check cannot change the pinned source. Legacy delivery retains its existing behavior.
   - Under the explicit quality policy, unresolved findings, failed execution/coverage, stale candidate bindings, incomplete corrections, and exhausted budgets block delivery. Absent policies retain legacy advisory behavior; unknown policies fail validation. The offline engine contracts do not qualify or authorize any real host runner.
   - At the final gate, `workflow/final-obligation-evidence.ts` requires every approved criterion and case to have an evidence obligation discharged by a passed receipt of the bound candidate, and reports `NO_OBLIGATION`, `OBLIGATION_NOT_DISCHARGED` or `NO_EXECUTION_EVIDENCE` in the `ac-coverage` artifact. Receipts replace runner stdout, which the host verify path does not return on success.
