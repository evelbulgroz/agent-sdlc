# Intent

Status: retired 2026-11-28 (implemented on `3115787`). This file is no longer a `check-spec` goal.

## Goal

`resolveTargetedVerificationCommand` and `resolveAcceptanceEvidenceCommand` stop appending package `e2e/` specs to a unit `test` script. A task whose authored tests all live under `e2e/`, whose `test` script matches the unit-runner pattern, and whose `test:e2e` script does not, gets no targeted command and no acceptance-evidence command. The declared verification command stays as written. That null evidence command leaves the completion validator unset, so the task skips static AC citation checks and execution binding. When every authored test is under `e2e/` and `test:e2e` itself matches the unit-runner pattern, that script is the selected command and its reporter follows that script. A task that also has unit specs still targets only the unit specs. When that validator runs on a command that names test paths, a criterion cited exclusively from an omitted package `e2e/` spec is outside its required set. A criterion with no citation stays required. A criterion cited from a unit spec on the command stays required and must pass in the recorded report. An evidence command that names no test path keeps every approved criterion.

Fitness-app run `2026-11-27-conditioning-delete-cleanup` halted on `e2e-task` because the acceptance-evidence command was `pnpm --filter @fitness-app/pwa-frontend test -- e2e/session-data-sources.spec.ts e2e/session-actions.spec.ts --reporter=json`. The package `test` script is `cross-env NODE_ENV=test vitest run`, and Vitest includes only `src/**/*.spec.ts` and `src/**/*.spec.tsx`. The command exited 1 with `numTotalTests` 0 and `success` false. The declared `pnpm --filter @fitness-app/pwa-frontend test` had already exited 0. `test:e2e` is `playwright test`. The product browser obligation never ran, because task evidence runs only after the task has a tree.

## Non-goals

- Resuming run `2026-11-27-conditioning-delete-cleanup`. Its continuation is stop and `retry.allowed` is false.
- Requalifying the canary, or moving this rule into a file outside `boundedPlanningHash`.
- Changing product evidence commands, the host profile, or `verifyTaskEvidence`.
- Emitting a second evidence command when one task has both unit specs and package `e2e/` specs.
- Changing unit-spec targeting, a supplied registered unit argv, a compound `test` script, or `TEST_FILE_PATTERN`. The `*.e2e-spec.*` preference stays in place. `src/flow.e2e-spec.ts` stays unrecognized by `isTestFilePath`, so that preference still does not select `test:e2e`.
- Recording an omitted package `e2e/` citation as an executed pass.
- Editing the fitness-app repository.

## Owning context

`execution/task-verification-plan.ts` in agent-sdlc.

## Touched surfaces

- execution/task-verification-plan.ts
- execution/task-verification-plan.spec.mjs

## Invariants and constraints

- The unit-runner pattern stays `vitest`, `jest`, or `node --test`. `playwright test` does not match it.
- A package e2e path is a package-relative test path whose slash-normalized form contains a directory segment `e2e/`. `src/flow.e2e-spec.ts` is not one. Backslashes are normalized before the test.
- Both exported commands use that same partition. The evidence reporter follows the selected script: Vitest adds one `--reporter=json`, Jest adds one `--json`, and `node --test` adds neither.
- When the selected script is `test:e2e`, the targeted argv is `pnpm`, `--filter`, the package name, `run`, `test:e2e`, then the package-relative e2e paths in authored order. A missing package name yields null, as it does today.
- `resolveTaskVerificationCommand` is unchanged. A supplied registered unit argv is returned before any path partition, and the validator for that argv keeps the task's acceptance criteria.
- The required-set partition runs inside the completion validator and its `staticCheck`, using the test files on disk at that call. Command resolution does not drop a criterion.
- The validator still searches for a matching command recorded after the last substantive write before it evaluates coverage. A missing entry returns `evidenceMissing: true` and `coverage: null`. That ordering stays.
- The required set starts as every approved criterion. A criterion leaves that set only when it has a citation and every citation is in an omitted package `e2e/` test. A criterion with no citation stays required. A case stays required while its parent criterion stays required. Slice-completed sibling test paths use this same rule when the command names test paths.
- The exemption runs only when the evidence command names at least one test path. A command that names none keeps every approved criterion and the full authored test set. That includes a compound `test` script returning `pnpm --filter <package> test` and the repository suite `pnpm run test:unit`, along with a registered unit argv.
- An empty required set, once the validator runs, happens only when every approved criterion was cited exclusively in omitted package `e2e/` tests. The skip is a null `completionValidator`, or a validator whose `staticCheck` returns null and whose call does not require the evidence command. An uncited criterion keeps the set non-empty. `createAcceptanceEvidenceValidator` returns null for a null command, an empty test-path list, or an empty criteria list.
- `TEST_FILE_PATTERN` stays `/\.(?:spec|test)\.[cm]?[jt]sx?$/`. `resolveAuthoredTestPaths` filters through `isTestFilePath` before the `*.e2e-spec.*` preference runs.
- `execution/task-verification-plan.ts` stays inside `boundedPlanningHash`. The behavior is not moved to an unhashed helper.
- `execution/task-verification-plan.ts` and `execution/task-verification-plan.spec.mjs` each stay at or under 500 lines and 20480 bytes. Existing test titles in the spec stay.

## Public contract impact

A null acceptance-evidence command is intentional when every authored test is a package `e2e/` path and `test:e2e` is not a unit runner. `createAcceptanceEvidenceValidator` in `execution/task-acceptance-evidence.ts` returns null when `acceptanceEvidenceCommand` is null, when `authoredTestPaths` is empty, or when `acceptanceCriteria` is empty. The task acceptance validator does not run, so static AC citation checks and execution binding both skip. The declared verification command still runs. This null result is not a passed execution of those criteria.

A mixed task whose evidence command names test paths still builds a validator. The required set starts as every approved criterion, decided when the validator runs. A criterion leaves that set only when it has a citation and every citation is in an omitted package `e2e/` spec. It is not recorded as executed. A criterion with no citation stays required and is reported uncovered. A criterion cited from a unit spec on the command remains required. An evidence command that names no test path does not exempt criteria. `pnpm --filter @fixture/example test` from a compound `test` script and `pnpm run test:unit` from the repository suite both keep the full required set. An empty required set, only when every approved criterion was cited exclusively in omitted package `e2e/` tests, skips the same static checks, either with a null validator or with a call that does not require the evidence command.

Host profiles, product evidence argv, and declared task verification commands stay as written. `playwright test` remains the host browser evidence command and is not selected here.

## Acceptance criteria

1. AC-01: Package e2e specs are omitted when `test:e2e` is not a unit runner. Given verification command `pnpm --filter @fitness-app/pwa-frontend test`, authored paths `apps/frontends/fitnessapp-pwa-frontend/e2e/session-data-sources.spec.ts` and `apps/frontends/fitnessapp-pwa-frontend/e2e/session-actions.spec.ts`, `test` script `cross-env NODE_ENV=test vitest run`, and `test:e2e` script `playwright test`. Then `resolveTargetedVerificationCommand` returns null, `resolveAcceptanceEvidenceCommand` returns null, and `resolveTaskVerificationCommand` still returns the declared command. Cases: AC-01.1: both derived commands are null; AC-01.2: the declared command is unchanged; AC-01.3: Given the only spec path uses backslashes `e2e\\flow.spec.ts` under the same package. Then both derived commands are still null; AC-01.4: Given a worktree whose `apps/frontends/fitnessapp-pwa-frontend/package.json` has those scripts, the task carries those authored paths and one grammatical acceptance criterion. Then `resolveTaskVerificationContext` returns a null `completionValidator`.
2. AC-02: A unit-runner `test:e2e` targets package e2e specs and keeps that script's reporter. Given package name `@fixture/example`, verification command `pnpm --filter @fixture/example test`, and only `apps/frontends/example/e2e/session-data-sources.spec.ts` then `apps/frontends/example/e2e/session-actions.spec.ts`. Then a `test:e2e` of `vitest run --config vitest.e2e.config.ts` selects `pnpm --filter @fixture/example run test:e2e` plus those two relative paths and an evidence command ending in `--reporter=json`; a `test:e2e` of `jest` ends the evidence command in `--json`; a `test:e2e` of `node --test` includes neither reporter token. Cases: AC-02.1: Vitest `test:e2e` uses both paths and `--reporter=json`; AC-02.2: Jest uses `--json`; AC-02.3: `node --test` adds no reporter token.
3. AC-03: Unit specs keep today's Vitest evidence command. Given authored path `frontends/example/src/ui/Page.spec.tsx`, verification command `pnpm --filter @fixture/example test`, and `test` script `vitest run`. Then the evidence command is that command plus `--`, `src/ui/Page.spec.tsx`, and `--reporter=json`. Cases: AC-03.1: the src spec and one JSON reporter remain; AC-03.2: the command contains no `e2e/` path.
4. AC-04: A mixed task targets only its unit specs, and completion follows that partition. Given authored paths `frontends/example/src/ui/Page.spec.tsx` and `frontends/example/e2e/session-actions.spec.ts`, `test` script `vitest run`, and `test:e2e` script `playwright test`. Then the targeted command and the evidence command contain `src/ui/Page.spec.tsx` and do not contain `e2e/session-actions.spec.ts`, and the completion validator drops a criterion only when that criterion is cited exclusively in an omitted package `e2e/` spec. Cases: AC-04.1: the unit path remains; AC-04.2: the package e2e path is absent from both commands; AC-04.3: Given `resolveTaskVerificationContext` on a worktree whose `frontends/example/package.json` has those scripts, an asserting test in `src/ui/Page.spec.tsx` cites AC-01, an asserting test in `e2e/session-actions.spec.ts` cites AC-02, and the evidence command recorded after the last substantive write has passed titles containing the AC-01 title only. Then `staticCheck` returns null, `pass` is true, and `coverage.notExecutedAcIds` is `[]`; AC-04.4: Given that same worktree and an evidence report whose passed titles omit the AC-01 title. Then `staticCheck` returns null, `pass` is false, and `coverage.notExecutedAcIds` is `["AC-01"]`; AC-04.5: Given those paths and scripts, the approved criterion is only AC-02, the unit spec cites no acceptance criterion, and the only asserting citation is AC-02 in the package e2e spec. Then the AC checks are skipped, so `completionValidator` is null, or `staticCheck` returns null and a call with no recorded evidence command returns `pass` true; AC-04.6: Given `resolveTaskVerificationContext` runs before either spec file exists, and the AC-04.4 files and omitted-title report are written afterward. Then that same completion validator returns `pass` false and `coverage.notExecutedAcIds` is `["AC-01"]`; AC-04.7: Given that mixed worktree, approved criteria AC-01 and AC-02, the unit spec cites only AC-01, the package e2e spec cites no acceptance criterion, and the evidence report passes the AC-01 title. Then `pass` is false and `coverage.uncoveredAcIds` is `["AC-02"]`.
5. AC-05: Untargeted evidence commands keep every approved criterion, and an unrecognized e2e-spec name yields no targeted command. Given the AC-01 paths and a registered argv `pnpm run test:unit`. Then `resolveAcceptanceEvidenceCommand` returns that argv unchanged and required-set partitioning does not run. Cases: AC-05.1: the registered argv is unchanged; AC-05.2: Given `test` script `pnpm run test:unit && pnpm run test:e2e`, `test:e2e` script `vitest run --config vitest.e2e.config.ts`, package name `@fixture/example`, and only `frontends/example/src/flow.e2e-spec.ts`. Then `resolveTargetedVerificationCommand` returns null; AC-05.3: Given `resolveTaskVerificationContext`, `test` script `vitest run && node --test scripts/evidence.spec.mjs`, verification command `pnpm --filter @fixture/example test`, a unit spec that cites AC-01, approved AC-01 and AC-02 with AC-02 cited nowhere, and that evidence command recorded after the last substantive write with exit code 0 and passed titles containing the AC-01 title. Then the evidence command is `pnpm --filter @fixture/example test`, `evidenceMissing` is false, `pass` is false, and `coverage.uncoveredAcIds` is `["AC-02"]`; AC-05.4: Given `resolveTaskVerificationContext`, verification command `pnpm run test:unit`, an authored spec that cites AC-01, approved AC-01 and AC-02 with AC-02 cited nowhere, and that evidence command recorded after the last substantive write with exit code 0 and passed titles containing the AC-01 title. Then the evidence command is `pnpm run test:unit`, `evidenceMissing` is false, `pass` is false, and `coverage.uncoveredAcIds` is `["AC-02"]`.

## Failure defenses

- Omitting an `e2e/` path from a unit command by also dropping a `src/` spec is not a success.
- A missing `test:e2e` script, or a `test:e2e` script that does not match the unit-runner pattern, does not fall through to the package `test` script for package e2e paths.
- A missing package name does not invent a filter. The `test:e2e` targeted command is null.
- The partition does not run before the registered-argv return, and it does not append a reporter to a compound `test` script.
- No second argv is created for the package e2e paths of a mixed task.
- Leaving a browser-only criterion in the required set, so `staticCheck` reports it uncovered or `notExecutedAcIds` contains it, is not a success.
- Dropping a criterion cited by a unit spec on the evidence command is not a success.
- Dropping a criterion that has no citation, so `uncoveredAcIds` loses AC-02 and `pass` becomes true, is not a success.
- Applying the exclusive-e2e exemption to a compound `test` command or to `pnpm run test:unit` is not a success.
- Reading AC-04.5 as also approving an uncited AC-01 is not a success. That AC-01 stays required.
- Satisfying AC-05.3 or AC-05.4 with `evidenceMissing: true` and `coverage: null` is not a success.
- Fixing the required set at command-resolution time, before the spec files exist, is not a success.
- A `test:e2e` argv for `src/flow.e2e-spec.ts` is not a success.
- A null completion validator that records the omitted criteria as executed is not a success.
- Merging a slice-completed sibling package `e2e/` spec back into the validator's required paths is not a success.
- The new tests do not rename or delete the existing tests in `execution/task-verification-plan.spec.mjs`.

## Verification plan

- `execution/task-verification-plan.spec.mjs` proves AC-01 through AC-05. Each new test title cites one `@ac` and its `@case` ids. Existing titles stay.
- AC-04.3, AC-04.4, AC-04.5, AC-04.6, and AC-04.7 call `resolveTaskVerificationContext` on a temporary worktree and invoke the returned completion validator and `staticCheck`. An argv deep-equal does not satisfy those cases. AC-04.6 builds that context before the spec files exist. AC-04.7 keeps the uncited criterion uncovered.
- AC-01.4 asserts `completionValidator` is null for the all-package-e2e fixture with one acceptance criterion.
- AC-05.2 asserts `resolveTargetedVerificationCommand` returns null for `src/flow.e2e-spec.ts`.
- AC-05.3 and AC-05.4 call `resolveTaskVerificationContext` with the matching command recorded after the last substantive write, exit code 0, and passed titles containing the AC-01 title. They assert `evidenceMissing` is false and `coverage.uncoveredAcIds` is `["AC-02"]`. An argv deep-equal or a call with no tool history does not satisfy those cases.
- Package check: `pnpm run test:unit` in this package.

## Unresolved questions

_None_

## Assumptions

- The halt command and the Vitest include are the ones observed on 2026-11-27 for run `2026-11-27-conditioning-delete-cleanup`. `TEST_FRAMEWORK_PATTERN` does not match `playwright test`.
- `execution/task-verification-plan.ts` is included by `listPackageBoundedPlanningFiles` through `execution/task-*.ts`. This edit changes `boundedPlanningHash`. A later start of a canary-ineligible plan needs a current qualification. This spec does not perform that qualification.
- On 2026-11-27, before this behavior lands, `execution/task-verification-plan.ts` is 373 lines and 12936 bytes, and `execution/task-verification-plan.spec.mjs` is 341 lines and 10511 bytes.
- On 2026-11-27, `isTestFilePath('frontends/example/src/flow.e2e-spec.ts')` is false and the AC-05.2 resolver inputs return null. `TEST_FILE_PATTERN` is `/\.(?:spec|test)\.[cm]?[jt]sx?$/`.
- On 2026-11-27, a unit spec citing AC-01, with approved AC-01 and AC-02 and with AC-02 cited nowhere, reports `uncoveredAcIds: ["AC-02"]` and `pass: false`. Passing only AC-01 as the criteria list returns `pass: true`. AC-04.7 rejects that narrowing. A criterion cited exclusively in the omitted package e2e spec remains outside the required set.
- On 2026-11-27, compound-script evidence for `vitest run && node --test scripts/evidence.spec.mjs` is `pnpm --filter @fixture/example test`, and repository-suite evidence is `pnpm run test:unit`. Neither argv contains a test path. Both keep the full required set. Invoking the validator for either command with no tool history returns `evidenceMissing: true` and `coverage: null` before coverage evaluation.
