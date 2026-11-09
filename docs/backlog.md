# Backlog

Open work for `@evelbulgroz/agent-sdlc`. Keep items short, evidence-linked and actionable.

## Reassess critic constraints and contributions

**Origin:** downstream host canary (runs `2026-10-29-host-canary-4` to `-7`, October 2026).

**Observed**
- `review/excerpt-extractor.ts` sets `DEFAULT_ASSERTIONS_PER_TEST = 3`, so the QA critic sees at most 3 assertions per test (24 KB / 1,000-line packing budget; under pressure the eviction order keeps one assertion per test).
- Runs 4 and 6 failed `canary qualify` with `QA_ACCEPTANCE_DIVERGENCE` ("GAP AC-02") although the implementation and test were correct: the cases the critic called missing (`null`, `undefined`, string) were asserted after the first 3 and so were not packed. Run 7 passed after the canary AC was narrowed to 3 inputs.
- The packed brief gives no signal that assertions were omitted, so a reader takes the critic's claim at face value.
- Critic output varies between runs: the plan critic raised two P1 findings on run 5 for a fixture that produced none on runs 4 and 6.
- The plan `doneBar` text was hardcoded in `review/critic-input-packing.ts` and triggered P1 findings; clarified in `b9efef4`.
- The implementer is not told about the 3-assertion limit, so passing depends on assertion order.

**Questions to answer**
1. False-negative rate: how often do the critics pass a defective change? No mutation-style evidence exists yet. Use deliberately wrong implementations and weak tests as seeded defects.
2. False-positive rate and cost: how many reruns and tokens do critic-only failures cost across recorded runs?
3. Is `maxAssertionsPerTest` (and the 24 KB / 1,000-line budget) the right constraint? Should it be a host-profile setting, scaled by AC count, or replaced by per-AC excerpt selection?
4. Should the packed brief flag omitted assertions (for example "N assertions not shown") and should the implementer prompt state the limit?
5. Which critic outcomes should block (`QA_ACCEPTANCE_DIVERGENCE`, plan P1) versus advise, given that the deterministic host `verify` receipt is the real gate?
6. How do we reduce run-to-run variance (pinned reviewer, repeat-and-agree, or grounding checks like the existing citation verifier)?

**Out of scope until answered:** raising `DEFAULT_ASSERTIONS_PER_TEST` or weakening critic gates. Either changes engine behaviour that was qualified in isolation.

**Done when:** the questions above have evidence-backed answers and each resulting change is specced and covered by tests.

## Further canary run-time reductions

**Origin:** live canary runs 9 and 10 against the reference host (November 2026). Run time fell from about 3,240 s to about 1,426 s after worker-pool hydration, batched blob writes, native realpath, a shared admission verify set and `tool` spans. Run 10 breakdown: prepare 412 s, evidence 302 s, implementer 168 s, `tool` 328 s, critic 30 s, plus about 155 s of startup.

**Candidates (none approved; each keeps every verification unless stated)**
1. **Child-side recipe verification (about 64 s/run).** `commandBridge` re-runs `verifyRecipeInputs` although the trusted parent verifies before and after execution. Dropping it is a defence-in-depth decision and needs explicit sign-off.
2. **Overlapped hydration (about 100–300 s/run).** Prepare is 9 hydrations of about 42 s plus an 83 s final checkpoint. First confirm whether a task worktree depends on the previous checkpoint. Needs an engine graph change.
3. **Worker-thread engine verify (about 100 s/run).** Verification is syscall-bound; `tsconfig.build.json` rewrites only static imports, so a build-safe worker design is required.
4. **Plan gate (about 63 s)** and **`live-run` startup (about 30 s per invocation, 4 invocations).** Not yet profiled beyond the admission dedupe.
5. **Evidence adapter variance.** The adapter takes 9–10 s on 3 invocations and 19–20 s on 5; cause unknown.
6. **Residual `pnpm --filter` overhead.** About 5 s per command after the three manifest hashes is inferred, not measured.
7. **Driver tail (about 190 s)** between run end and driver exit (preflight, cleaning, archiving) is not broken down.

**Done when:** each adopted change has a measurement before and after, tests, and a confirming canary that passes 7/7 invariants.

## Surface implementer "blocked" summaries

**Origin:** qualification case N1 (November 2026). The implementer refused to edit on contradictory requirements and asked which rule wins in its `complete` summary, but the engine recorded only a generic `evidence-failed` with no operator-visible question.

**Candidate:** when the implementer completes with no file edits, publish its summary as a diagnostic or interrupt on the failed snapshot. Fail-closed behaviour stays unchanged.

**Done when:** an N1 rerun shows the implementer's question in `status.json`, and a test covers it.

**Status (2026-11-09):** the engine already carries `lastSummary` on the failed result and the status projection shows it as `tasks[].failureMetadata.lastSummary`. `testing/qualification/refusal-scenario.spec.mjs` covers it. N1b live rerun (2026-11-09, run `2026-11-09-sdlc-92125131`): `FAILED` with `TASK_EXECUTION_FAILED`, and `status` showed `tasks[0].failureMetadata.lastSummary` naming the contradiction. **Closed.**

## Plan critic P1 on boilerplate shadow paths

**Origin:** qualification case C1 (2026-11-09, run `2026-11-09-sdlc-06451a1c`).

**Observed:** on a clean two-file helper spec the plan critic raised one P1 (`tasks[0].shadowPaths` holds only category labels, no recovery action). The run stopped at `WAITING_FOR_PLAN_ACCEPTANCE` and reached `READY_FOR_GIT_APPROVAL` (7/7) only after `accept_residual`. N8 and N2 on similar specs raised none, so this is critic variance on engine-generated plan text, not a spec defect.

**Candidate:** either the generated `shadowPaths` carry concrete recovery statements, or the plan critic rubric stops treating the generated labels as a defect. Measure the false-positive rate over several clean runs first.

**Done when:** at least five clean tier 2 runs on unseen specs raise no plan critic P1, or each P1 names a real defect.
