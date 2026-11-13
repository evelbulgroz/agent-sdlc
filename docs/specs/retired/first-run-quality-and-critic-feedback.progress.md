# Implementation progress: first-run quality and critic feedback

Spec: `first-run-quality-and-critic-feedback.md` (same directory).
Implemented directly in this session, not through `shell start`. Increments follow
`first-run-quality-and-critic-feedback.tasks.json`. Each increment left `pnpm run typecheck`
and its touched suite green.

## Increments

1. [x] Quality gate (`quality-gate-task`, AC-01–AC-04)
   - `execution/task-quality-gate.ts`: a shifted baseline clone must stay byte-for-byte, and a deletion above that range needs the same number of replacement lines. The finding no longer says `place new imports after`.
   - The same gate reports a new clone: an identical run of at least `minLines` that starts on a class or function declaration in two production `.ts` files under `targetPackage`, with at least one file authored. `minLines` is the integer in `jscpd.json` beside the resolved eslint config, otherwise 8. Spec, test, and `.d.ts` files are skipped. A window that overlaps a baseline jscpd location, or that `git show` already has in both files at base, is not a new clone. A thrown `git show` counts as absent for that file. The scan runs only after the existing early returns.
   - Tests: `execution/task-quality-gate.spec.mjs`.
2. [x] Task header (`task-prompt-task`, AC-05–AC-06)
   - `formatTaskScope` in `execution/task-scope.ts` tells the implementer that a copied class with the same name is a duplicate, not a reuse, and that a quality-gate line shift fails the task even when the package tests pass.
   - Role JSON was not edited.
   - Tests: `execution/task-scope.spec.mjs`.
3. [x] Rubrics (`rubric-task`, AC-07–AC-10)
   - QA: a later packed assertion can satisfy the Then; GAP requires that no packed assertion in the citing tests addresses the Then; the representative quote is the packed assertion that addresses the Then. An `@oracle` test's assertion that addresses the Then is preferred.
   - Plan: a shadow that restates a spec failure defense or a source constraint is sufficient on a behavior-preserving change. `dependsOn` makes shared-path overlap ordered. A null `parentTreeSha` before execution is not evidence of two writers from one base. The removed-path sentence stays in the plan rubric only.
   - Spec: a verification-plan citation is valid when a later task or slice owns the AC on the shared file. A branch label of the parent Then is measurable. A distinct outcome without its own Given and Then is a P1. The spec rubric does not contain `removedPaths`.
   - Tests: `review/critic-prompt.spec.mjs` via `loadRubric`.

## Review fixes

- `minLines` is read from `jscpd.json` in the directory of the resolved eslint config. A missing or unreadable file uses 8. `execution/task-quality-gate.ts` has no `tools/quality/` literal. A regression test places that file beside `pkg/lint/eslint.cjs`, not on a fixed host path.
- AC-03.1, AC-03.2, and AC-03.4 are titled `@ac AC-03 @case AC-03.N`.
- The QA quote list prefers an `@oracle` test's assertion that addresses the Then. The opening line of `qa.md` was shortened, so it no longer starts with "Perform rigorous, independent audit" as the plan and spec rubrics do. `qa.md` is 2325 bytes. The 6000-token hard-crash fixture in `review/qa-resources.spec.mjs` is at its limit: the next QA sentence has to replace existing words. That fixture's `maxPromptTokens` of 6000 and charge of 6123 stay as they are.
- The plan rubric no longer says `Do not demand new transactional recovery.`
- `review/critic-review.spec.mjs` is not a spec touched surface. Its plan fixture stays at 4150 words. The plan protocol grew from 2731 bytes to 3061 bytes, so a real plan has 330 bytes less room under the 24KB assembly ceiling. A 4200-word plan prompt is 24706 bytes (130 over 24576). A 4150-word plan prompt is 24456 bytes (120 under) and 25245 tokens (over the 20000-token strict ceiling). The 4150-word fixture is 250 bytes of document shorter than 4200 words.
- `execution/task-quality-gate.ts` is 499 lines. The next edit there needs a split first. Declaration gaps, overlapping clone windows, and the exceptions-file limit are in `docs/backlog.md`.

## Verification

On 2026-11-13, `pnpm run build`, `pnpm run typecheck`, and `pnpm run test:unit` passed (1902 pass, 0 fail, 1 skipped). `node cli/cli.ts reliability replay` passed 20/20 with `providerOperations=0`. Nothing was committed.

## Retirement

Retired 2026-11-13 after `07bf6cf`. Canary run `2026-11-13-sdlc-ce64034e` reached `READY_FOR_GIT_APPROVAL`. `canary qualify` returned `PASSED`, and the gate is `CANARY_CURRENT` for that commit. The canary worktree was not merged.

## Skipped

- No live canary. `execution/task-quality-gate.ts` and `execution/task-scope.ts` are inside `boundedPlanningHash`.
- No edit to `workflow/preflight-gate.ts`, `execution/minimal-executor.ts`, role JSON, or excerpt eviction.
