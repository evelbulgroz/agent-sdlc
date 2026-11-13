# Intent

Status: retired 2026-11-13 (implemented). This file is no longer a `check-spec` goal.

Prevent unprovable task plans from executing in detached worktrees by statically validating in `agent-sdlc` that every non-enabling slice in a `TaskManifest` contains at least one task whose authored paths (or generated outputs) include a test file recognizable by the citation parser and execution verification plan.

## Goal

In `agent-sdlc`, acceptance criteria are declared at the slice level on a `TaskManifest` (`slice.acceptanceCriteria`). During execution, each task assigned to a slice inherits its enclosing slice's criteria (`workflow/nodes/execute-tasks.ts:90`). However, an individual task's acceptance evidence check is skipped when the task authors no test file (`execution/task-acceptance-evidence.ts:48-53` returns `null` when `authoredTestPaths.length === 0`). Sibling tasks within the same slice and target package pool their test paths (`execution/task-verification-plan.ts:283-302, 337-339`), so a vertical slice legitimately splits into an implementation task and a companion test-authoring task.

If a non-enabling slice (`kind !== 'enabling'`) contains no tasks that author test files (for example, authoring only non-test source files, shell scripts like `tests/run.sh`, or markdown), every task in that slice skips individual evidence validation. The unprovable slice then proceeds across detached worktrees, burning autonomous repair and model governor allocations before failing only at post-reconciliation preflight with `AC_COVERAGE_FAILED`.

Currently, `validateTaskManifestAcceptanceCriteria` (`policy/contracts/planning-schema.ts:137-177`) only verifies slice existence, criterion syntax, and unique slice criterion ownership, leaving a static provability gap.

This specification closes that gap. Canonical test file matching is defined via `TEST_FILE_PATTERN` and `isTestFilePath` exported from `policy/contracts/primitives.ts` and `policy/contracts.ts` (matching `/\.(?:spec|test)\.[cm]?[jt]sx?$/`, matching execution's test file predicate in `execution/task-verification-plan.ts`). `validateTaskManifestAcceptanceCriteria` statically asserts that every non-enabling slice has at least one task whose `authoredPaths` or `generatedOutputs` contains a matching test file.

Unprovable manifests fail closed at `check-spec` (`cli/commands/maintenance.ts:85`) and `shell start` (`cli/commands/start.ts:103`) via `evaluateTaskReadiness` (`policy/task-planner/task-readiness.ts:148`) before any worktree or model governor allocation is created. Manifest-less flows (where `taskManifest` is null or omitted) derive tasks dynamically from touched surfaces and do not evaluate a static manifest.

## Non-goals

- Do not alter the regex-based citation extraction in `execution/ac-citations.ts` (`TEST_CALL_RE`, `DESCRIBE_CALL_RE`, `ASSERTION_RE`).
- Do not require test files for enabling slices (`kind === 'enabling'`), which by contract forbid acceptance criteria.
- Do not require every individual task in a multi-task vertical slice to author a test file; test paths continue to pool across sibling tasks within the slice.
- Do not widen the test file pattern to match shell scripts (`.sh`), markdown, or arbitrary non-spec files under `tests/` directories.
- Do not modify `review/critic-gate.ts`'s `isTouchedTestFile`, which retains broader heuristics for QA critic review of test fixtures and directories.
- Do not mutate quality baselines, attempt caps, or token budgets.

## Owning context

`@evelbulgroz/agent-sdlc`, directories `policy/contracts` and `execution`.

## Touched surfaces

- policy/contracts/primitives.ts
- policy/contracts.ts
- policy/contracts/planning-schema.ts
- policy/contracts/planning-schema.spec.mjs
- policy/contracts.spec.mjs
- testing/deepen-contracts.spec.mjs
- execution/task-verification-plan.ts
- testing/task-planner-fixtures.ts

## Invariants and constraints

- Every slice in a `TaskManifest` with `kind !== 'enabling'` must contain at least one task whose `authoredPaths` or `generatedOutputs` includes at least one file matching `TEST_FILE_PATTERN` / `isTestFilePath` (`/\.(?:spec|test)\.[cm]?[jt]sx?$/`).
- Slices with `kind === 'enabling'` do not require any test-authoring task.
- Tasks in a `TaskManifest` do not declare `acceptanceCriteria`; criteria are owned exclusively by slices and inherited by tasks sharing that `sliceId`.
- `validateTaskManifestAcceptanceCriteria` throws an `SdlcError` with code `INVALID_CONTRACT` naming the failing slice when any non-enabling slice lacks an authored or generated test file matching `TEST_FILE_PATTERN`.
- `TEST_FILE_PATTERN` and `isTestFilePath` are canonically defined in `policy/contracts/primitives.ts` and exported from `policy/contracts.ts`.
- `execution/task-verification-plan.ts` imports and reuses `isTestFilePath` (or `TEST_FILE_PATTERN`) instead of duplicating inline regex literals.
- `policy/contracts.spec.mjs` and `testing/deepen-contracts.spec.mjs` exact export lists are updated to include `TEST_FILE_PATTERN` and `isTestFilePath`.
- Every touched source and test file remains within the repository navigability ceilings of at most 500 lines and at most 20,480 bytes.

## Public contract impact

`TEST_FILE_PATTERN` and `isTestFilePath` are canonically exported from `policy/contracts.ts`. `validateTaskManifestAcceptanceCriteria` rejects non-enabling slices that lack test-authoring tasks with `INVALID_CONTRACT`. No runtime state schemas, database schemas, or CLI flag signatures are modified.

## Acceptance criteria

1. AC-01: A task manifest containing a non-enabling slice without any test-authoring task fails contract validation. Given a task manifest containing a non-enabling slice where no assigned task authors or generates a test file matching `TEST_FILE_PATTERN`. Then `validateTaskManifestAcceptanceCriteria` throws `INVALID_CONTRACT` naming the slice. Cases: AC-01.1: a vertical slice authoring only production code throws INVALID_CONTRACT; AC-01.2: a vertical slice authoring only shell scripts under tests throws INVALID_CONTRACT; AC-01.3: a vertical slice authoring only documentation throws INVALID_CONTRACT.
2. AC-02: Enabling slices and slices with pooled test-authoring tasks pass contract validation. Given a task manifest. Then `validateTaskManifestAcceptanceCriteria` succeeds without requiring every task to author tests. Cases: AC-02.1: an enabling slice requires no test file; AC-02.2: a vertical slice with an implementation task and a sibling test-authoring task passes; AC-02.3: a task producing a test file via generatedOutputs passes.
3. AC-03: `TEST_FILE_PATTERN` and `isTestFilePath` are canonically exported from `policy/contracts.ts` and consumed by execution verification planning. Given `policy/contracts/primitives.ts` and `policy/contracts.ts`. Then they export `TEST_FILE_PATTERN` (`/\.(?:spec|test)\.[cm]?[jt]sx?$/`) and `isTestFilePath`, and `execution/task-verification-plan.ts` imports and uses the shared predicate.
4. AC-04: Touched modules and test suites maintain navigability ceilings and export contracts. Given `policy/contracts/primitives.ts`, `policy/contracts.ts`, `policy/contracts/planning-schema.ts`, `execution/task-verification-plan.ts`, and companion specs. Then each file remains at most 500 lines and at most 20,480 bytes, and export contract assertions in `policy/contracts.spec.mjs` and `testing/deepen-contracts.spec.mjs` pass.

## Failure defenses

- `repositoryPathArray` in `planning-schema.ts` strictly validates that all paths are non-empty, repository-relative, and free of backslashes before test-path evaluation occurs.
- `isTestFilePath` safely returns `false` when given `null`, `undefined`, empty strings, non-string inputs, or production/shell paths.
- Slice syntax and uniqueness validations (`validateTaskManifest`) execute before test provability validation.
- Existing manifest fixtures across the codebase (such as `testing/task-planner-fixtures.ts`, `policy/task-planner/task-readiness.spec.mjs`, and `policy/contracts/planning-schema.spec.mjs`) are audited and updated where necessary to include valid test files on vertical slices without weakening any existing test assertions.

## Verification plan

- `policy/contracts/planning-schema.spec.mjs` cites AC-01, AC-01.1, AC-01.2, AC-01.3, AC-02, AC-02.1, AC-02.2, and AC-02.3 with `assert`.
- `policy/contracts.spec.mjs` and `testing/deepen-contracts.spec.mjs` cite AC-03 with `assert`.
- Sizing assertions for AC-04 are verified across all touched files.
- Full package done bar after implementation: `pnpm run build && pnpm run typecheck && pnpm run test:unit && node cli/cli.ts reliability replay`.

## Unresolved questions

_None_

## Assumptions

- The `agent-sdlc` engine citation parser (`execution/ac-citations.ts`) extracts test citations via regex pattern matching (`TEST_CALL_RE`, `DESCRIBE_CALL_RE`, `ASSERTION_RE`) from test files matching `/\.(?:spec|test)\.[cm]?[jt]sx?$/`. Tasks authoring only non-matching files (such as shell scripts or Markdown) cannot satisfy acceptance criteria coverage.
- Sibling tasks within a slice share evidence in `execution/task-verification-plan.ts`, so slice-level provability is satisfied when at least one task in the slice authors or generates a matching test file.
