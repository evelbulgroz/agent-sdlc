# Intent

Status: retired 2026-11-13 (implemented). This file is no longer a `check-spec` goal. The progress note remains beside this file. The incident evidence is in Goal and Assumptions.

## Goal

Ten fitness-app engine starts on 2026-11-12 landed six conditioning deepening specs. Four starts were new slugs after a halt. `semanticRepairsCount` was 0 on every run. Critics were xAI grok-4.7. This spec changes the task quality gate and the spec, plan, and QA protocols so those halts and false P1s are less likely on the next behavior-preserving change. It does not reopen integration repair, and it does not tighten case grammar in the parser.

The halts that cost a new slug were not missed package tests. Import-occurrence v2 (`2026-11-12-conditioning-log-owns-writes-import-occurrence-v2`) finished 25 tests and then `evidence-failed` on `occurrence-task`. Attempts 2 and 3 were shown `[jscpd] clone put-log-occurrence.use-case.ts:64-73 — baseline clone at …:66-75 shifted` and the hint `place new imports after line 75`. The approved spec required deleting `DERIVED_GETTER_KEYS` above that range. The hint names the wrong repair for a deletion in the body. Lifecycle v1 (`2026-11-12-conditioning-log-cache-lifecycle-bridge`) completed all three tasks. Integration preflight then failed `quality_failure` with `blockedReason` `AUTONOMOUS_REPAIR_RETIRED`: `log-cache-lifecycle-bridge.ts:6-24` was cloned as `export class LogCacheLifecycleBridge` at `user-repo-association.store.ts:92`. The task gate only compares baseline clone locations. It does not see a new class body. `@Optional()` injection made the package tests pass. Patch v1 (`2026-11-12-conditioning-log-owns-writes-patch`) died with `GOVERNOR_ROUTES_EXHAUSTED` after every implementer call used only `xai-grok-quality`. That is an operator pin, specified on the host, not here.

Plan P1s on source-constraint shadows, and QA P1s that quote only the first `expect`, did not by themselves force a new slug. They still stop a run at plan acceptance, and a qualification that treats QA P1 as product failure would reject landed work. Attach, delete-fetch, and the GPS run reached git approval on the first slug. GPS fixed a real AC-08 defect with one in-run revise. That path should stay.

## Non-goals

- Do not reopen `AUTONOMOUS_REPAIR_RETIRED`, add an integration repair loop, or edit `workflow/preflight-gate.ts`. A new clone must fail the authoring task while that task can still edit. High-risk halts stay retired. The coverage-floor correction card stays the only integration correction.
- Do not require `Given` and `Then` inside `AC_CASE_GRAMMAR`. `workflow/acceptance-criteria.spec.mjs` accepts `Cases: AC-01.1: username empty; AC-01.2: password empty.` Retired specs and unit fixtures use the same short form. Rejecting it fails those tests and every host spec that followed the published grammar. The spec rubric below distinguishes a branch label from a distinct outcome.
- Do not edit `roles/defaults/`, `implementer.json`, or a host role addendum. `implementerRoleHash` is the role JSON. The new implementer sentences go in the task header built by `execution/task-scope.ts`.
- Do not change excerpt eviction. `DEFAULT_FILE_SOFT_CAP` stays 80. The preserve-one rule in `review/excerpt-extractor.ts` stays. The QA change is classification against every assertion that was packed.
- Do not spawn `jscpd`, raise attempt caps, raise token ceilings, or edit `execution/minimal-executor.ts` or `execution/minimal-executor.spec.mjs`. The canned finding in that spec still contains the old `place new imports after line 3` phrase as input.
- Do not run a live canary in this change. `execution/task-quality-gate.ts` is in `boundedPlanningHash`. The operator reruns the canary after this lands.
- Do not edit the fitness-app host. Host authoring rules are a separate draft in that repository.

## Owning context

`@evelbulgroz/agent-sdlc`, directories `execution` and `review`.

## Touched surfaces

- execution/task-quality-gate.ts
- execution/task-quality-gate.spec.mjs
- execution/task-scope.ts
- execution/task-scope.spec.mjs
- review/defaults/protocol/qa.md
- review/defaults/protocol/plan.md
- review/defaults/protocol/spec.md
- review/critic-prompt.spec.mjs

## Invariants and constraints

- `evaluateTaskQualityGate` with no authored paths still returns `pass` true and `findings` `[]`.
- A baseline jscpd location whose bytes moved still fails the gate. The finding starts with `[jscpd] clone`, names the original range and the shifted range, contains `must stay byte-for-byte`, contains `same number of replacement lines`, and does not contain `place new imports after`.
- A new clone is an identical line window of at least `minLines` that starts on a line matching a class or function declaration, appears in two production `.ts` files under `targetPackage`, and has at least one of those files in `authoredPaths`. `minLines` is the integer `minLines` in `jscpd.json` beside the eslint config, otherwise 8. Spec, test, and `.d.ts` files are not scanned. The reported range of each copy is the declaration line through the last line of the longest identical run that starts there. A window is not a new clone when either copy overlaps a baseline jscpd location in the same file. A window is not a new clone when `baseCommitSha` and `gitCli` are set and `git show` returns both files with the same identical run at base. When `baseCommitSha` or `gitCli` is null, only the baseline-overlap rule applies. A thrown `git show` counts as absent at base for that file. The finding contains `new clone` and both `file:start-end` ranges.
- The declaration line matches optional `export`, optional `default`, optional `async`, then `class` or `function`, then a name. Import blocks and duplicate method bodies with no declaration do not match. Comparison is byte-exact per line after stripping a trailing `\r`. That is the lifecycle shape. It is not a second jscpd.
- The new-clone scan runs after the existing early returns. With no `qualityGate` config, or a missing gate config or baseline file, the gate still returns `pass` true and `findings` `[]`. `jscpd.json` is read from the directory of the resolved eslint config. It is not a host-profile field.
- The task header from `formatTaskScope` gains two sentences: `A class or function this task imports must not be redeclared in an authorized file. Import it instead; a copied class with the same name is a duplicate, not a reuse.` and `A quality-gate line shift fails the task even when the package tests pass. Restore the named line range byte-for-byte. A deletion above that range needs the same number of replacement lines.`
- QA protocol: a citing test is `COVERED` when any packed assertion in that test addresses the Then. A first assertion that only checks a result wrapper is not a GAP when a later packed assertion in that test addresses the Then. GAP requires that no packed assertion in the citing tests addresses the Then. The quote preference names the packed assertion that addresses the Then, or for GAP the closest packed assertion, instead of the first packed assertion.
- Plan protocol: a shadow that restates a spec failure defense or a source constraint is sufficient on a behavior-preserving change. Ordered overlap through `dependsOn` is not two writers from one base. A null `parentTreeSha` before execution is not that evidence. The existing removed-path sentence stays, and the spec rubric still does not contain `removedPaths`.
- Spec protocol: the spec critic sees only the spec sections, not the task manifest. A verification-plan citation of an AC is valid when the spec text names a later task or slice that owns that AC and runs after the earlier task on the shared file. The critic does not flag the earlier task's test command for that citation. A case that only names a branch of the parent Then is measurable. A case that states a distinct outcome without its own Given and Then is a P1.
- Each authored file stays at or under 500 lines and 20480 bytes.

## Public contract impact

None. `evaluateTaskQualityGate` still returns `pass`, `findings`, and optional `summary`. `parseAcceptanceCriterion` still accepts a short case label. Role JSON and `implementerRoleHash` stay unchanged. Integration preflight still escalates a repairable verifier failure to `AUTONOMOUS_REPAIR_RETIRED` when no quality checkpoint is bound.

## Acceptance criteria

1. AC-01: A shifted baseline clone tells the implementer to keep the original lines byte-for-byte. Given a worktree whose baseline finding is `pkg/src/moved.ts:1-1` with base text `const clone = 1;` and current text that places that line second. Then `evaluateTaskQualityGate` returns `pass` false, and the finding contains `must stay byte-for-byte` and `same number of replacement lines` and does not contain `place new imports after`.
2. AC-02: A duplicated class declaration fails the task gate with both locations. Given a gate config and baseline file present, `minLines` 8, an authored production file `pkg/src/store.ts` whose eight lines are an `export class LogCacheLifecycleBridge` body, `pkg/src/bridge.ts` with the same eight lines, no baseline finding for either file, and `git show` at base returning an empty `pkg/src/store.ts`. Then `evaluateTaskQualityGate` returns `pass` false and a finding that contains `new clone`, `pkg/src/store.ts:1-8`, and `pkg/src/bridge.ts:1-8`.
3. AC-03: Existing baseline windows, spec-file copies, and an empty path list do not become new clones. Given the same eight-line class body. Then a baseline-overlapping window, a duplicate already present at base, a spec-file copy, and an empty authored-path list do not add a `new clone` finding. Cases: AC-03.1: a window overlapping a baseline range is not a new clone. Given a baseline jscpd location `pkg/src/store.ts:1-20` that contains the eight-line window and the bytes at that location unchanged. Then findings do not contain `new clone`; AC-03.2: a spec file is outside the scan. Given the duplicate body only in `pkg/src/store.spec.ts` and the production file. Then `pass` is true when no baseline shift exists; AC-03.3: no authored paths stay a pass. Given `authoredPaths` `[]`. Then `pass` is true and `findings` is empty; AC-03.4: a duplicate already present at base is not a new clone. Given no baseline finding and `git show` at base returning both files with the same eight lines. Then findings do not contain `new clone`.
4. AC-04: The quality-gate files stay within the navigability budget. Given `execution/task-quality-gate.ts` and `execution/task-quality-gate.spec.mjs` after this change. Then each file is at most 500 lines and at most 20480 bytes.
5. AC-05: The task header forbids a second declaration and states the line-shift repair. Given `formatTaskScope` for a task with one authored path. Then the header contains `a copied class with the same name is a duplicate, not a reuse.` and `A quality-gate line shift fails the task even when the package tests pass.` and `same number of replacement lines`.
6. AC-06: The task-scope files stay within the navigability budget. Given `execution/task-scope.ts` and `execution/task-scope.spec.mjs` after this change. Then each file is at most 500 lines and at most 20480 bytes.
7. AC-07: QA classifies from every packed assertion in the citing test. Given `review/defaults/protocol/qa.md` loaded by `loadRubric` for phase `qa`. Then the rubric states that a later packed assertion can satisfy the Then when the first assertion does not, that GAP requires no packed assertion in the citing tests to address the Then, and that the representative quote is the packed assertion that addresses the Then rather than the first packed assertion.
8. AC-08: The plan rubric accepts source-constraint shadows and ordered overlap. Given `review/defaults/protocol/plan.md` loaded by `loadRubric` for phase `plan`. Then the rubric states that a shadow restating a spec failure defense or a source constraint is sufficient on a behavior-preserving change, and that `dependsOn` makes shared-path overlap ordered, and that a null `parentTreeSha` before execution is not evidence of two writers from one base.
9. AC-09: The spec rubric allows a later task to cite a shared file, and it still rejects an unmeasured distinct case. Given `review/defaults/protocol/spec.md` loaded by `loadRubric` for phase `spec`. Then the rubric states that a verification-plan AC citation is valid when the spec names a later task or slice that owns the AC and runs after the earlier task on the shared file, that a branch label of the parent Then is measurable, and that a distinct outcome without its own Given and Then is a P1. The spec rubric does not contain `removedPaths`.
10. AC-10: The rubric files stay within the navigability budget. Given `review/defaults/protocol/qa.md`, `review/defaults/protocol/plan.md`, `review/defaults/protocol/spec.md`, and `review/critic-prompt.spec.mjs` after this change. Then each file is at most 500 lines and at most 20480 bytes.

## Failure defenses

- A missing `jscpd.json` beside the eslint config uses `minLines` 8 and does not throw.
- A declaration window shorter than `minLines` does not fail the gate.
- Duplicate import lines with no class or function declaration do not fail the gate.
- The existing one-line baseline shift fixture still fails. It is titled `@ac AC-01 evaluateTaskQualityGate fails when a baseline clone moves` and gains the AC-01 message assertions.
- An empty authored-path list still returns `pass` true. A thrown git show on a baseline file does not become a new-clone failure.
- QA, plan, and spec sentences stay in their own rubrics. Copying the plan removed-path sentence into the spec rubric fails AC-09.
- Any named file over 500 lines or 20480 bytes fails AC-04, AC-06, or AC-10. A second helper file is outside `authoredPaths`, so path containment rejects it.
- A pre-existing duplicate class pair that is not in the baseline does not fail a task that only edits one of those files. AC-03.4 covers that.
- Replacement lines are not a baseline edit. Host preflight already fails a moved, unchanged clone (`review/integration-diagnostics.ts`), so the gate cannot accept the move.
- Spawning `jscpd`, editing `minimal-executor.ts`, or editing role JSON fails the non-goals.

## Verification plan

- `execution/task-quality-gate.spec.mjs` cites AC-01, AC-02, AC-03, AC-03.1, AC-03.2, AC-03.3, AC-03.4, and AC-04 with `assert`. The existing shift test is the AC-01 test, and the existing no-authored-paths test is the AC-03.3 test.
- `execution/task-scope.spec.mjs` cites AC-05 and AC-06 with `assert`.
- `review/critic-prompt.spec.mjs` cites AC-07, AC-08, AC-09, and AC-10 with `assert`, using `loadRubric` for the protocol sentences and file reads for the size checks.
- Each increment ends with `pnpm run typecheck` and the touched suites green. The manifest's task command is `pnpm run test:unit`.
- Package done bar after implementation: `pnpm run build && pnpm run typecheck && pnpm run test:unit && node cli/cli.ts reliability replay`.
- Canary follows that done bar and is not part of a task command. `execution/task-quality-gate.ts` and `execution/task-scope.ts` both match the bounded-planning pattern `/^task-.*\.ts$/` in `policy/canary-planning-files.ts`, so this change stales `boundedPlanningHash`.

## Unresolved questions

_None_

## Assumptions

- Run ledger, all 2026-11-12, sqlite `runs.state` and `lastError`. Patch `FAILED` `GOVERNOR_ROUTES_EXHAUSTED` on `patch-domain-task` after implementer ops on `xai-grok-quality` only. Patch-v2, attach, delete-fetch, import-occurrence-v3, and `sdlc-d5b3bf4c` reached `READY_FOR_GIT_APPROVAL`. Import-occurrence and import-occurrence-v2 `FAILED`. Lifecycle `ESCALATED` `AUTONOMOUS_REPAIR_RETIRED`. Lifecycle-v2 reached `READY_FOR_GIT_APPROVAL`.
- Import v2 attempt artifacts `94c93c5275c2339f1f6a2592083004282842366b9045cbadcbace891442b4c9f.json` and `ad2dac6c2ff7315ed695115b72f92ed3dfdcb01c21cd7ad5a418a51353c80244.json` contain the shifted-clone finding and `place new imports after line`. The implementer saw the gate. Three attempts were not enough because the spec required the deletion. The message change does not by itself make that deletion legal. The host draft tells authors to name the preserved range.
- Lifecycle failure packet `c329ae4dbdc30f51af32f52d70473ca5f6219a4a19a21ed09e697535df18ed0d` records `classification` `quality_failure` and the jscpd clone of `log-cache-lifecycle-bridge.ts:6-24`. The integration worktree still has `export class LogCacheLifecycleBridge` at `user-repo-association.store.ts:92` and the same methods as lines 6-24 of the bridge file. Verified 2026-11-13: bridge lines 6-24 and store lines 92-110 are byte-identical, starting at `export class LogCacheLifecycleBridge implements UserLifecycleObserver {`. Host `minLines` is 8. `association-wiring-task` authored the store while the bridge file existed. All three `dag_tasks` are `completed`.
- `execution/task-quality-gate.ts` reports a shifted baseline location and eslint `sonarjs` findings. It does not scan for a new class body. Full preflight jscpd does, after every task has finished, and `escalateAutonomousRepairRetired` does not reopen a task.
- `review/excerpt-extractor.ts` already keeps every assertion until the 80-line file cap or the 24KB budget, then keeps the first assertion. The QA protocol's quote preference still says the representative quote is the first packed assertion, which anchors the critic on the first `expect`. This spec changes that preference with the classification rule. Recorded QA rows on patch-v2 (10 GAP, file `(none)`), attach (7, including DIVERGENT), delete-fetch, import-v3, and GPS describe that first expect. Lifecycle-v2 QA had 0 findings. This spec changes the classification rule and leaves eviction alone. If a citing test is over the soft cap, later expects can still be dropped. That remaining gap is accepted.
- Plan philosophy already says a pure refactor preserves existing error behavior. `review/defaults/protocol/plan.md` does not. The critic emitted P1s for file-size and forbidden-token shadows on delete-fetch, import-v3, and lifecycle v1, and for shared `conditioning-log-writes.spec.ts` path prefixes on patch-v2. The engine backlog item "Plan critic P1 on boilerplate shadow paths" is the same class of finding. This spec puts the suppression in the protocol.
- The spec critic receives `SpecDocumentPackingInput` (`review/critic-input-packing.ts`): spec sections only, no `dependsOn`. The suppression is stated in spec-text terms.
- Lifecycle-v2 spec critic P1 said the bridge task's full-package test cannot pass because the verification plan cites AC-04 and AC-05. The cache task lists those ACs and depends on the bridge task. v1 already showed the cache task adding the citations. The spec protocol suppression matches that handoff.
- Import v1 and v2 spec critic P1s on AC-18.1 and AC-18.2 were real: the cases said the import succeeds and did not name the return value or `logRepo.update`, while the parent Then at the start of v1 named the weather repository. Short branch labels such as `username empty` are a different shape and stay legal. The rubric sentence is the adopted remedy.
- GPS `sdlc-d5b3bf4c` spec g0 P1 on AC-08 was real (`matched` is not an outcome). One in-run revise cleared it. No engine change is proposed for outcome vocabulary. The host draft covers that.
- `currentCanaryBindings` hashes `implementer.hashes.roleHash`, which is `sha256` of the role JSON, and `boundedPlanningHash` over `execution/task-*.ts` plus the fixed planning files. Protocol markdown is outside both. `execution/task-scope.ts` and `execution/task-quality-gate.ts` are both inside the `/^task-.*\.ts$/` pattern.
- Two gate tests carried ids from a retired spec that collided with this spec's AC-06 and AC-03.2. They were retitled on 2026-11-13 to `@ac AC-03 @case AC-03.3 … no authored paths` and `@ac AC-01 … baseline clone moves`. No file in this repository referenced the old titles.
- Integration reopen or strict case grammar needs a follow-up spec. Folding either in reopens a retired repair loop or breaks `parseAcceptanceCriterion` fixtures.
