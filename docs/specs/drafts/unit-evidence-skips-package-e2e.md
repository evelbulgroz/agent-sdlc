# Intent

Status: draft.

## Goal

`resolveTargetedVerificationCommand` and `resolveAcceptanceEvidenceCommand` stop appending package `e2e/` specs to a unit `test` script. A task whose authored tests all live under `e2e/`, whose `test` script matches the unit-runner pattern, and whose `test:e2e` script does not, gets no targeted command and no acceptance-evidence command. The declared verification command stays as written. When every authored test is under `e2e/` and `test:e2e` itself matches the unit-runner pattern, that script is the selected command and its reporter follows that script. A task that also has unit specs still targets only the unit specs.

Fitness-app run `2026-11-27-conditioning-delete-cleanup` halted on `e2e-task` because the acceptance-evidence command was `pnpm --filter @fitness-app/pwa-frontend test -- e2e/session-data-sources.spec.ts e2e/session-actions.spec.ts --reporter=json`. The package `test` script is `cross-env NODE_ENV=test vitest run`, and Vitest includes only `src/**/*.spec.ts` and `src/**/*.spec.tsx`. The command exited 1 with `numTotalTests` 0 and `success` false. The declared `pnpm --filter @fitness-app/pwa-frontend test` had already exited 0. `test:e2e` is `playwright test`. The product browser obligation never ran, because task evidence runs only after the task has a tree.

## Non-goals

- Resuming run `2026-11-27-conditioning-delete-cleanup`. Its continuation is stop and `retry.allowed` is false.
- Requalifying the canary, or moving this rule into a file outside `boundedPlanningHash`.
- Changing product evidence commands, the host profile, or `verifyTaskEvidence`.
- Emitting a second evidence command when one task has both unit specs and package `e2e/` specs.
- Changing unit-spec targeting, a supplied registered unit argv, a compound `test` script, or the existing `*.e2e-spec.*` preference.
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
- `resolveTaskVerificationCommand` is unchanged. A supplied registered unit argv is returned before any path partition.
- `execution/task-verification-plan.ts` stays inside `boundedPlanningHash`. The behavior is not moved to an unhashed helper.
- `execution/task-verification-plan.ts` and `execution/task-verification-plan.spec.mjs` each stay at or under 500 lines and 20480 bytes. Existing test titles in the spec stay.

## Public contract impact

None. No host profile, product evidence argv, or declared task verification command changes. `playwright test` remains the host's browser evidence command and is not selected here.

## Acceptance criteria

1. AC-01: Package e2e specs are omitted when `test:e2e` is not a unit runner. Given verification command `pnpm --filter @fitness-app/pwa-frontend test`, authored paths `apps/frontends/fitnessapp-pwa-frontend/e2e/session-data-sources.spec.ts` and `apps/frontends/fitnessapp-pwa-frontend/e2e/session-actions.spec.ts`, `test` script `cross-env NODE_ENV=test vitest run`, and `test:e2e` script `playwright test`. Then `resolveTargetedVerificationCommand` returns null, `resolveAcceptanceEvidenceCommand` returns null, and `resolveTaskVerificationCommand` still returns the declared command. Cases: AC-01.1: both derived commands are null; AC-01.2: the declared command is unchanged; AC-01.3: Given the only spec path uses backslashes `e2e\\flow.spec.ts` under the same package. Then both derived commands are still null.
2. AC-02: A unit-runner `test:e2e` targets package e2e specs and keeps that script's reporter. Given package name `@fixture/example`, verification command `pnpm --filter @fixture/example test`, and only `apps/frontends/example/e2e/session-data-sources.spec.ts` then `apps/frontends/example/e2e/session-actions.spec.ts`. Then a `test:e2e` of `vitest run --config vitest.e2e.config.ts` selects `pnpm --filter @fixture/example run test:e2e` plus those two relative paths and an evidence command ending in `--reporter=json`; a `test:e2e` of `jest` ends the evidence command in `--json`; a `test:e2e` of `node --test` includes neither reporter token. Cases: AC-02.1: Vitest `test:e2e` uses both paths and `--reporter=json`; AC-02.2: Jest uses `--json`; AC-02.3: `node --test` adds no reporter token.
3. AC-03: Unit specs keep today's Vitest evidence command. Given authored path `frontends/example/src/ui/Page.spec.tsx`, verification command `pnpm --filter @fixture/example test`, and `test` script `vitest run`. Then the evidence command is that command plus `--`, `src/ui/Page.spec.tsx`, and `--reporter=json`. Cases: AC-03.1: the src spec and one JSON reporter remain; AC-03.2: the command contains no `e2e/` path.
4. AC-04: A mixed task targets only its unit specs. Given authored paths `frontends/example/src/ui/Page.spec.tsx` and `frontends/example/e2e/session-actions.spec.ts`, `test` script `vitest run`, and `test:e2e` script `playwright test`. Then the targeted command and the evidence command contain `src/ui/Page.spec.tsx` and do not contain `e2e/session-actions.spec.ts`. Cases: AC-04.1: the unit path remains; AC-04.2: the package e2e path is absent from both commands.
5. AC-05: A registered unit argv and a non-unit `test` script keep their current results. Given the AC-01 paths and a registered argv `pnpm run test:unit`. Then `resolveAcceptanceEvidenceCommand` returns that argv unchanged. Given `test` script `pnpm run test:unit && pnpm run test:e2e`, `test:e2e` script `vitest run --config vitest.e2e.config.ts`, package name `@fixture/example`, and only `frontends/example/src/flow.e2e-spec.ts`. Then the targeted command runs `test:e2e` with `src/flow.e2e-spec.ts`. Cases: AC-05.1: the registered argv is unchanged; AC-05.2: `src/flow.e2e-spec.ts` still selects `test:e2e`.

## Failure defenses

- Omitting an `e2e/` path from a unit command by also dropping a `src/` spec is not a success.
- A missing `test:e2e` script, or a `test:e2e` script that does not match the unit-runner pattern, does not fall through to the package `test` script for package e2e paths.
- A missing package name does not invent a filter. The `test:e2e` targeted command is null.
- The partition does not run before the registered-argv return, and it does not append a reporter to a compound `test` script.
- No second argv is created for the package e2e paths of a mixed task.
- The new tests do not rename or delete the existing tests in `execution/task-verification-plan.spec.mjs`.

## Verification plan

- `execution/task-verification-plan.spec.mjs` proves AC-01 through AC-05. Each new test title cites one `@ac` and its `@case` ids. Existing titles stay.
- Package check: `pnpm run test:unit` in this package.

## Unresolved questions

_None_

## Assumptions

- The halt command and the Vitest include are the ones observed on 2026-11-27 for run `2026-11-27-conditioning-delete-cleanup`. `TEST_FRAMEWORK_PATTERN` does not match `playwright test`.
- `execution/task-verification-plan.ts` is included by `listPackageBoundedPlanningFiles` through `execution/task-*.ts`. This edit changes `boundedPlanningHash`. A later start of a canary-ineligible plan needs a current qualification. This spec does not perform that qualification.
- On 2026-11-27 the production file is 373 lines and 12936 bytes, and the spec is 341 lines and 10511 bytes.
