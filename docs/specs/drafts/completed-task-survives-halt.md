# Intent

Draft only. Do not start this goal until its sibling obligations file exists. The 24,576-byte critic packing ceiling stays.

## Goal

A task that has already completed keeps its recorded `targetTreeSha` when a later gate halts the run. A replacement slug can check that tree out for the completed task's authored paths and must not send the implementer back to rewrite them. Page fixes that sit outside those paths remain a new task on the new slug.

`execution/task-executor.ts` stores `targetTreeSha` when a task completes. The historic keyboard runs halted after that point, with `retry.allowed` false. Each replacement slug was cut from `HEAD` and rewrote `e2e/historic-strength-import.spec.ts`. The page defects were outside the task's authored paths, so the completed tree could not be reused.

## Non-goals

- Do not resume a halted slug.
- Do not widen the completed task's authored paths so it can edit the page.
- Do not land a halted worktree without the replacement slug's git approval.
- Do not raise the packing ceiling or the repair budget.
- Do not commit or push from the engine.

## Owning context

`execution/task-executor.ts` and `cli/status-projection.ts` in agent-sdlc.

## Touched surfaces

- execution/task-executor.ts
- execution/task-executor.halt.spec.mjs
- cli/status-projection.ts
- cli/shell-start-files.ts

## Invariants and constraints

- A halted run stays halted. The replacement is a new run id.
- The checked-out paths are exactly the completed task's authored paths at `targetTreeSha`.
- The new implementer task does not list those paths in `authoredPaths`.
- Git branch, commit, and push remain operator-authorized.

## Public contract impact

None. This is an engine worktree handoff. No product HTTP or OpenAPI change.

## Acceptance criteria

1. AC-01: status names the completed tree. Given a task whose verification passed and a run that then halted with `retry.allowed` false. Then shell status JSON includes that `taskId` and `targetTreeSha`. Cases: AC-01.1: completed task is listed; AC-01.2: a task that never completed has no tree to continue.
2. AC-02: the replacement starts from that tree. Given `shell start` with the halted run id and completed task id. Then the new worktree contains those authored paths at `targetTreeSha` before the implementer starts. Cases: AC-02.1: path bytes match the recorded tree; AC-02.2: a path outside the completed authored set stays at the new base commit.
3. AC-03: the implementer cannot rewrite the completed paths. Given the replacement task's `authoredPaths` omit the completed paths. Then an edit to a completed path is `PATH_CONTAINMENT_VIOLATION`. Cases: AC-03.1: edit inside a completed path is rejected; AC-03.2: edit inside a new authored path is accepted.

## Failure defenses

- A missing or non-tree `targetTreeSha` rejects the start before a worktree is created.
- A replacement that names a task whose verification did not pass is rejected.
- The halted run's ledger is not appended by the replacement.

## Verification plan

- `execution/task-executor.halt.spec.mjs` proves AC-01 and AC-03.
- A shell-start spec proves AC-02.
- Engine check: `pnpm test:unit` in this package.

## Unresolved questions

_None_

## Assumptions

- `targetTreeSha` stored by the current executor is the tree the replacement checks out.
