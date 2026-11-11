# Canary Qualification Fixture (`docs/specs/canary/`)

Standing, single-task canary specification and companion task manifest used for hosted canary qualification of `@evelbulgroz/agent-sdlc`.

## Purpose

The hosted canary is an end-to-end smoke test verifying that the host environment's profile, model-usage governor, verification pipeline, and executor function together with the engine.

Whenever changes are made to engine orchestration logic, planning files (`policy/canary-planning-files.ts`), implementer prompts, or model policy (`.agents/model-usage-policy.json`), existing canary qualification evidence (`<stateDir>/canary-qualification.json`) is invalidated (`CANARY_STALE` / `CANARY_REQUIRED`), blocking multi-task DAG runs until a fresh canary passes.

## Contents

- `canary.md` — The target specification describing an isolated, low-complexity change (`clampPercent` in `scripts/canary-probe.ts`) with two acceptance criteria (`AC-01`, `AC-02`).
- `canary.tasks.json` — The frozen single-task plan (`canary-probe-task` within slice `canary-probe`) bounded within the canary limits (1 vertical slice, 1 task, $\le 2$ ACs, $\le 3$ authored paths, complexity score $\le 10$).

## Critical Invariant: Unmerged Canary

As mandated by repository policy, **never commit or merge a canary worktree into `main`**.

The canary run is driven to `READY_FOR_GIT_APPROVAL` to generate qualification evidence and qualify the run (`agent-sdlc canary qualify`). If merged into `main`, canary `@ac` test citations would enter the host repository's test baseline (`execution/ac-coverage.ts`), polluting coverage accounting.

## Qualification Workflow

1. **Verify bounds:**
   ```bash
   agent-sdlc canary check \
     --goal-file docs/specs/canary/canary.md \
     --task-plan-file docs/specs/canary/canary.tasks.json \
     --json
   ```

2. **Execute run to `READY_FOR_GIT_APPROVAL`:**
   ```bash
   agent-sdlc shell start \
     --goal-file docs/specs/canary/canary.md \
     --task-plan-file docs/specs/canary/canary.tasks.json \
     --json
   ```

3. **Qualify the completed run:**
   ```bash
   agent-sdlc canary qualify --run <run-id> --json
   ```
