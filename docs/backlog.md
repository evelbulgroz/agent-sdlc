# Backlog

Open work for `@evelbulgroz/agent-sdlc`. Keep items short, evidence-linked and actionable.

## Reassess critic constraints and contributions

**Origin:** host canary for fitness-app (runs `2026-10-29-host-canary-4` to `-7`, October 2026).

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
