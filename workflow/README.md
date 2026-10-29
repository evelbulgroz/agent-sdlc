# Workflow State Graph, Worktrees & Reconciliation (`workflow/`)

LangGraph JS/TS state machine orchestration, specification hashing, detached git worktree isolation, lazy workspace hydration, binary patch reconciliation, and authorized git branch/commit delivery.

## Key Files & Entrypoints

- `workflow/graph.ts` & `workflow/graph-topology.ts` — LangGraph state graph wiring, node transitions, and checkpoint persistence.
- `workflow/nodes/` — Modular graph node implementations (`spec-interview.ts`, `spec-draft.ts`, `approval.ts`, `authorization.ts`, `planning.ts`, `workspace.ts`, `execute-tasks.ts`, `reconcile.ts`, `review-qa.ts`, `commit.ts`, `finish-run.ts`).
- `workflow/specification.ts` & `workflow/acceptance-criteria.ts` — Specification completeness checks, `AC-NN` grammar validation, and `approvedSpecHash` binding.
- `workflow/worktrees.ts` & `workflow/worktree-guard.ts` — Detached worktree lifecycle and `assertPlanFrozenThenCreateWorktree` enforcement.
- `workflow/hydration.ts` — Lazy worktree dependency installation and host-declared `hydration.steps`.
- `workflow/reconciliation.ts` — Topological binary patch extraction, `git apply --check` dry-run validation, and integration worktree assembly.
- `workflow/git-manager.ts` & `workflow/landed-check.ts` — Opt-in local branch creation, structured commit formatting, remote push, and blob-level `main` landed checks.
- `workflow/preflight-gate.ts` & `workflow/fleet.ts` — Preflight verification gating and fleet friction/learning-debt scanning.

## Core Invariants

1. **Plan-Frozen Worktree Guard (`worktree-guard.ts`):**
   Every production call to `createDetachedWorktree` (`prepare_workspace`, `TaskExecutor`, `resetIntegrationWorktree`) passes through `assertPlanFrozenThenCreateWorktree` and fails closed with `POLICY_VIOLATION` unless `taskPlanFrozen === true`.

2. **Detached Worktree Topology & Lazy Hydration (`worktrees.ts`, `hydration.ts`):**
   - **Single-task runs:** `tools/.agent-sdlc/<run-id>/worktree`
   - **Multi-task DAG runs:** `tools/.agent-sdlc/<run-id>/worktrees/<task-id>` plus `tools/.agent-sdlc/<run-id>/worktrees/integration`
   - Dependent tasks initialize from synthetic parent commit objects (`git commit-tree`) derived from preceding task trees without polluting repository branch refs.
   - Worktrees hydrate lazily via `pnpm install --frozen-lockfile`, and the host-declared `hydration.steps` (for example setup scripts and scoped package builds).

3. **Binary Patch Reconciliation (`reconciliation.ts`):**
   - Task deltas are extracted using isolated git index files (`GIT_INDEX_FILE`) and applied sequentially to `worktrees/integration` in topological order after `git apply --check` and realpath containment checks.
   - **Zero automated LLM merge:** Patch conflicts trigger a `reconciliation_conflict` interrupt and halt for operator intervention (`continuation.action: 'answer'`).
   - High-risk task plans trigger a `high_risk_review` interrupt after task verification and before reconciliation.

4. **Local & Remote Git Delivery (`git-manager.ts`, `nodes/commit.ts`):**
   - Without git authorization flags, verified runs halt at **`READY_FOR_GIT_APPROVAL`** with an uncommitted worktree and explicit operator instructions. The main checkout `HEAD` is never mutated.
   - When `createBranch: true` and `createLocalCommits: true` are authorized in the envelope, the workflow checks branch collisions (`git show-ref`), formats a structured commit (`Decisions:`, `Remaining:`, `Tried:`), re-runs canonical preflight on the clean committed tree, and transitions to **`DONE`**.
   - Opt-in `push` and `openPullRequest` require local commits; `merge` and `deploy` are permanently forbidden.
