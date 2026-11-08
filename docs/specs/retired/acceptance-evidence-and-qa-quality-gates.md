# Intent

**Status:** Offline engine contracts implemented; production activation remains gated.
Host qualification, runtime limits and rollout gates precede activation.

## Goal

Demonstrate acceptance cases at task and non-enabling-slice checkpoints. Plan
observable evidence, independently assess adequacy, and block unresolved quality
failures from Git delivery. Passing tests and citations alone are not adequacy.

Trigger: fitness-app run `2026-11-01-sdlc-c640939f` reached
`READY_FOR_GIT_APPROVAL` with five QA P1s: genuine gaps and omitted assertions.
The operator closed gaps and delivered separately; this draft governs future runs.

## Motivating legacy evidence and limitations

The companion [checkpoint contract](acceptance-evidence-checkpoint-contract.md)
records source limitations: advisory P1s, one final QA review, and dependency
release before slice reconciliation. Execution/citations do not prove adequacy.

## Non-goals

- No automatic commits, branches, pushes, merges, PRs, or expanded authorizations.
- No general return of the retired autonomous repair workflow. Confirmed failures
  escalate to the operator; ordinary task-local correction before completion stays
  within existing authorization and budgets.
- No universal semantic proof, mandatory mutation per task, or consensus loops.
- No new dependencies, frameworks, build system, or command discovery.
- No weakening assertions, changing quality baselines, raising excerpt limits as
  the sole fix, or requiring duplicated tests just to satisfy excerpt order.
- No changes to fitness-app, its landed implementation, or historical run state.
- No code-critic graph node or governor/vendor-policy bypass.

## Owning context

Standalone agent-sdlc engine: task-plan contracts, acceptance evidence, task/slice
completion, critic evidence packing, QA disposition, persistence, continuation,
and Git-delivery guards.

## Touched surfaces

Existing integration points, subject to bounded task decomposition:

- `workflow/acceptance-criteria.ts`, task-plan contracts under `policy/contracts/`,
  `workflow/nodes/planning.ts`, and `workflow/graph-topology.ts`
- `workflow/nodes/execute-tasks.ts`, `workflow/nodes/reconcile.ts`,
  `workflow/reconciliation.ts`, `workflow/worktrees.ts`, `execution/task-tree-delta.ts`
- `execution/task-verification-plan.ts`, `execution/task-acceptance-evidence.ts`,
  `execution/ac-coverage.ts`, `execution/ac-worktree-coverage.ts`,
  `execution/test-execution-evidence.ts`, and `execution/task-executor.ts`
- `execution/minimal-verification.ts` and `execution/ac-author-feedback.ts`
- `review/excerpt-extractor.ts`, `review/critic-input-packing.ts`,
  `review/critic-gate.ts`, `review/critic-budget.ts`, review operation identity,
  and `review/semantic-review-evidence.ts`
- `workflow/preflight-gate.ts`, `workflow/nodes/review-qa.ts`,
  `workflow/nodes/commit.ts`, and `workflow/node-helpers.ts`
- Persistence records, cleanup/archive/retention under `persistence/`; status and
  continuation under `cli/`; authorization contracts
- `host/command-policy.ts`, `host/verify-runner.ts`, and host evidence-port contracts
- Existing colocated tests and module READMEs in the affected directories

Use small owning collaborators; choose new filenames in the task manifest.

## New-policy invariants and constraints

### 1. Plan evidence, not just citations

- Before worktree creation, each approved acceptance case has an evidence
  obligation in the candidate task plan. Criteria without named cases have one
  obligation at criterion level. Existing AC prose remains compatible.
- An obligation identifies its AC/case, public observable outcome, setup/action,
  expected result, sufficient layer/capabilities, test paths, authorized adapter/
  argv binding, and responsible task or non-enabling-slice checkpoint.
- Layers: unit, integration/boundary, browser, static. Native activation/picker/
  focus cannot be proved solely by jsdom or component simulation.
- Use the companion's framework-neutral evidence port. Hosts own runner commands,
  environment and report normalization; the engine owns receipt validation and
  gates, not Playwright/Jest parsing. Missing qualified capabilities block planning.
- Component tasks prove components; completed slices prove page wiring.
  Intermediate/enabling tasks need not prove unavailable downstream behavior.
- Reject missing/duplicate/foreign obligations, incompatible layers, undeclared
  paths, unsupported formats, or forbidden argv. Review layer adequacy against
  prose; validate structure and known layer rules deterministically.
- The plan critic sees these obligations. Freeze them with `taskPlanHash` before
  worktrees. Evidence commands introduce no new execution or write permissions.
  Permission mismatches require operator authorization, not silent scope growth.
- Author prompts show obligations; citations index evidence, not adequacy.

### 2. Execute and bind checkpoint evidence

- Applicable obligations are mandatory; absence of a supported evidence runner
  is an actionable planning/execution failure, not a null validator pass.
- Keep successful declared verification and executed-case citation checks.
  Additionally require execution of every declared obligation command and its
  case-level result, with explicit failed/skipped/not-run outcomes.
- Host adapters normalize runner reports into versioned file/case receipts.
  Unknown/incomplete output or exit code alone cannot discharge an obligation.
- Bind each receipt to run, task/slice, approved spec hash, frozen plan hash,
  candidate digest/tree, command, runner, case/test identity, result, and source
  paths. Include timestamps and artifact hashes; exclude secrets/environment dumps.
  Require file/case identity; an unrelated same-title test cannot discharge a case.
- Engine-observed invocation/candidate bindings validate untrusted adapter reports.
  Capability declarations prove neither exercised behavior nor assertion adequacy.
- Run task evidence before completion, then slice obligations against the
  reconciled candidate before releasing dependents. Component successes do not
  prove integration. Enabling slices retain verification without acceptance cases.
- Edits invalidate checkpoint and downstream evidence conservatively.
- Resume reuses only complete same-candidate receipts. Retain verification preparation.
- Final integration revalidates executed obligations against its actual tree;
  static citations or earlier task receipts alone cannot pass final coverage.

### 2a. Materialize slice checkpoint trees

- Checkpoint tree, scheduler barrier, authorization and review identity follow
  the companion [checkpoint contract](acceptance-evidence-checkpoint-contract.md).
  Vertical and activation slices require acceptance before releasing dependents.
- The companion binds task parents to eligible closure trees, applies task-only
  deltas once, and registers checkpoint paths for cleanup/archive/coverage.

### 3. Assess adequacy using complete, bounded evidence

- At slice completion, independently assess adequacy through the governed
  heterogeneous critic capability before releasing dependents.
- Review input groups evidence by obligation: requirement, declared layer,
  relevant setup/action/assertions, public implementation seam, and executed
  receipt. It must distinguish a real page test from a composition simulation.
- Pack deterministically by case, not the first N assertions in a test. Preserve
  source provenance and identify included/omitted portions, assertion counts,
  truncation, unread files, and unresolved helper references.
- Resolve oversized evidence with bounded follow-up packets in the same attempt
  and budget; truncation cannot prove absence.
- If sufficient context cannot be obtained within budget or authorization, return
  `insufficient_evidence` and escalate. It is neither PASS nor a confirmed missing
  test. Never widen read scope to resolve an unavailable dependency.
- Absence claims consider full authorized evidence and helpers. Recycled baseline
  AC ids alone do not prove new requirements.
- Preserve raw findings separately from dispositions. Final QA reconciles current
  evidence without repeating unchanged successful slice reviews.
- The companion contract defines distinct slice/final admission and attempt keys,
  operation/packet identity, and `(S + 1) * (R + 1) * (F + 1)` dispatch allocation.
  New-policy QA replaces the one-review cap; exhaustion halts.

### 4. Distinguish findings from delivery decisions

- Deterministic failures (commands, missing execution, coverage, contracts,
  authorization, binding, or containment) halt the owning checkpoint immediately.
  Never publish an event named PASSED for a failed result.
- Critic findings have a persisted disposition: confirmed, refuted, or
  insufficient evidence. Quoting existing code is citation grounding, not proof
  of absence or deterministic corroboration.
- An omitted-assertion allegation is refuted only by preserved case-relevant
  evidence addressing the claim. A semantic gap without a deterministic
  reproducer requires operator adjudication after the evidence review; another
  model verdict alone does not establish merge trust.
- A raw unresolved P1, confirmed P1, or insufficient-evidence decision blocks
  checkpoint completion and Git delivery. Advisory non-P1 findings stay visible.
  An operator may classify/refute a finding with a recorded rationale and evidence;
  no blanket "ignore all P1" action is added.
- Confirmed gaps produce a scoped packet with obligations, evidence, reproduction
  or absence assessment, edit paths, and rerun commands; escalate without edits.
- Use the companion human-only correction contract: active-task command failures
  retain task repair; critic decisions never enter it. Adjudication/correction
  requires `answer`, not mechanical `resume`/`authorize`; shell watch must stop.
- Correction respects source scope, obligations, and repair limits. Changed
  requirements/plans/permissions require renewed approval and binding.
- Correction revises owning-task deltas, not snapshots; rematerialize consumers
  and rerun evidence/reviews under the resolution contract.

### 5. Enforce one delivery invariant everywhere

- Both `READY_FOR_GIT_APPROVAL` and `COMMITTING_CHANGES` require current successful
  deterministic verification, discharged obligations, completed adequacy review,
  and zero unresolved/confirmed P1 or insufficient-evidence blockers.
- Check the same invariant at authorization-to-delivery transitions, resumed
  commit entry, committed-tree verification, and push/PR delivery. Prior Git
  permission does not exempt a run from quality gates.
- Status separates execution, citation, adequacy, and disposition with bindings
  and actionable operator responses; advisory-only review is not green.
- Delivery/PR/status readers select current candidate/checkpoint review identities
  and dispositions, not earliest or simply latest QA. Retain historical events;
  new failures emit `AC_COVERAGE_FAILED`, and all coverage consumers read both
  success and failure with candidate binding. Unavailable/deferred critics and
  SKIP/BUDGET_EXHAUSTED never bypass required new-policy review.
- Operator-shell continuation remains the lifecycle boundary. Mechanical replay
  cannot adjudicate findings, authorize correction, expand permissions, or reset
  a consumed repair/review budget.

### 6. Compatibility and qualification

- Activate through an explicit versioned quality policy for newly approved runs.
  Include its normalized value in the approved planning-policy binding and frozen
  plan. Existing resumes must not silently adopt new obligations or semantics.
- Preserve terminal runs. Label legacy behavior; adoption requires explicit
  reauthorization/replanning and execution of the new gates.
- Legacy false coverage remains advisory; split policy fixtures per the resolution
  contract. Never treat historical PASSED events as new-policy quality trust.
- Use additive versioned persistence migrations. Preserve historical raw findings,
  receipts, reviewer/vendor provenance, and decisions; never rewrite the baseline.
- Set finite review budgets before activation. Exhaustion halts, never skips adequacy.
- Every changed/new file stays at or below 500 lines and 20,480 bytes. Native Node
  type stripping and explicit in-source `.ts` imports remain unchanged.

## Public contract impact

New quality policy, task-plan obligations and host-command evidence port;
versioned reports, checkpoint receipts and dispositions; additive status/
continuation fields and explicit operator adjudication responses.
Strict task-plan schema 1.0.0 requires a version bump; case ids stay evidence
references, not task-plan criterion ids. New-policy QA budgeting replaces the
one-review cap while retaining bounded governor accounting and legacy semantics.

Review schemas/migrations/actions before implementation. This draft approves no
wire shape or run. `coveragePass` must not imply adequacy.

## Acceptance criteria

1. AC-01: Plans assign executable evidence. Given component, integration, browser and static cases. Then obligations specify sufficient layers, authorized argv and checkpoints before freeze. Cases: AC-01.1: cases assigned once; AC-01.2: missing or foreign obligations rejected; AC-01.3: jsdom cannot prove file-picker behavior; AC-01.4: forbidden argv rejected; AC-01.5: obligation edits invalidate binding.
2. AC-02: Completion requires executed evidence. Given host adapters and passed, failed, skipped or missing results. Then only current normalized file/case receipts discharge obligations. Cases: AC-02.1: valid receipt passes; AC-02.2: command failure blocks; AC-02.3: unsupported output blocks; AC-02.4: wrong tree or same title in another file rejected; AC-02.5: final gate rejects missing execution; AC-02.6: two runner formats share one port; AC-02.7: forged binding or capability-only pass rejected.
3. AC-03: Slice closures gate dependents. Given enabling, vertical and activation slices. Then eligible closure trees parent dependents and current task deltas reconcile once. Cases: AC-03.1: acceptance releases dependents; AC-03.2: task success cannot bypass; AC-03.3: verified enabling siblings included; AC-03.4: unrelated slices excluded; AC-03.5: conflict halts; AC-03.6: mixed closure binds downstream parent; AC-03.7: corrected deltas survive final delivery once.
4. AC-04: Review resolves omitted context. Given decisive fourth assertions and shared helpers. Then bounded packets resolve evidence or halt as insufficient. Cases: AC-04.1: fourth assertion retrieved; AC-04.2: helper resolved; AC-04.3: exhausted retrieval halts; AC-04.4: omissions declared.
5. AC-05: Citations do not prove adequacy. Given a passed correctly titled test with an unrelated assertion. Then independent assessment requests adjudication of its unproved outcome. Cases: AC-05.1: weak assertion detected; AC-05.2: adequate assertion accepted; AC-05.3: simulation cannot prove page wiring.
6. AC-06: New-policy failed coverage blocks. Given false coverage or evaluation error. Then AC_COVERAGE_FAILED blocks progression while legacy semantics remain explicit. Cases: AC-06.1: uncovered case blocks; AC-06.2: error blocks; AC-06.3: success is not adequacy; AC-06.4: readers select current policy-bound evidence.
7. AC-07: Critic decisions require human control. Given task command failures and critic P1s. Then only active-task command failures use existing repair; adjudication/correction requires a human answer. Cases: AC-07.1: evidence supports refutation; AC-07.2: uncertainty needs operator; AC-07.3: confirmed gap produces packet; AC-07.4: shell watch stops; AC-07.5: critic cannot enter task repair; AC-07.6: answer binds revised tasks and consumer rematerialization.
8. AC-08: Blockers prevent Git delivery. Given commit-disabled and commit-enabled envelopes. Then unresolved quality or unavailable required reviews block every delivery entry. Cases: AC-08.1: Git-ready blocked; AC-08.2: commit blocked; AC-08.3: resumed delivery guarded; AC-08.4: clear evidence permits authorized delivery; AC-08.5: earliest unrelated review cannot satisfy current gate.
9. AC-09: Review accounting is checkpoint-specific. Given S slices, approved R and F, corrections and restarts. Then distinct slice/final candidates dispatch within the stated finite allocation without resetting budgets. Cases: AC-09.1: complete exact attempt reusable; AC-09.2: changed tree invalidates evidence; AC-09.3: interrupted dispatch consumes budget; AC-09.4: exhaustion halts; AC-09.5: two slices and final review all dispatch; AC-09.6: follow-ups have distinct operation ids; AC-09.7: first QA cannot satisfy later slice.
10. AC-10: Qualification measures defect detection. Given frozen adequate, omitted-context, weak-test and seeded-defect fixtures. Then offline routing replay and separately governed evaluation report false positives, negatives, uncertainty and cost. Cases: AC-10.1: adequate tests avoid confirmed gap; AC-10.2: weak evidence cannot deliver; AC-10.3: corrected tests kill named defects; AC-10.4: replay token-free; AC-10.5: uncertain outcomes retained.
11. AC-11: Rollout preserves history and checkpoint lifecycle. Given legacy and registered checkpoint worktrees. Then adoption is explicit and lifecycle readers distinguish checkpoints from tasks. Cases: AC-11.1: persistence round-trip; AC-11.2: adoption needs approval; AC-11.3: history unchanged; AC-11.4: cleanup removes each registered worktree; AC-11.5: archive excludes duplicate checkpoint patches; AC-11.6: final coverage excludes stale checkpoints.

## Failure defenses

- Test failed coverage/P1 at delivery boundaries with both authorization modes.
- Use irrelevant assertions, omitted fourth assertions, and shared-helper fixtures.
- Use real browser fixtures for native behavior, not mocked clicks.
- Bind integration evidence to the reconciled tree, not sibling successes.
- Crash/replay between receipt, disposition, completion, and delivery fails closed.
- Missing reviewer capability/provider halts without weakening vendor policy.

## Verification plan

- Draft only: do not launch a run, modify engine code, or create a task manifest
  until the policy, schemas, budgets, and legacy behavior have been accepted.
- Implement planning, bound execution, adequacy review, delivery guards,
  persistence/continuation and controlled qualification.
- Extend acceptance-evidence, coverage, critic-placement and packing suites.
  Keep preflight-gate and graph-slice3 false-coverage assertions explicitly legacy;
  add new-policy blocking counterparts. Use focused owning suites.
- Cover positive, null/missing, empty, timeout/error, stale, and interrupted
  boundaries. Cite AC/cases; preserve assertions and baselines.
- Update `workflow/graph-qa-advisory.spec.mjs`, `review/critic-budget.spec.mjs`
  and shell-watch tests with explicitly separated legacy/new-policy expectations.
- Keep routing replay token-free. Separately authorize hosted evaluation with
  finite limits; freeze corpus/reviewer configuration and retain error examples.
- Implementation done bar:
  `pnpm run build && pnpm run typecheck && pnpm run test:unit && node cli/cli.ts reliability replay`.
- Update affected module documentation alongside wire/API changes. Use disposable
  fixture worktrees and leave qualification canaries unmerged.

## Prerequisite resolution

Follow the companion [resolution contract](acceptance-evidence-resolution-contract.md):
implement reviewed contracts with two fixture report shapes, then separately
authorize real host adapters, bounded semantic evaluation and an opt-in pilot.

Review the [wire proposal](acceptance-evidence-wire-contract.md) before coding.
Host argv, runtime limits and measured rollout thresholds need separate approval.
Explicit R=1/F=1 is accepted for offline work, not a default or spend approval.
Interface correctness has hard fixture gates; semantic reliability needs measured
evidence. A passing corpus does not establish universal adequacy.

## Assumptions

- Default to operator escalation, not post-QA auto-repair or model-only P1 dismissal.
- Activating browser/static support requires qualified host adapters.
- Conservatively invalidate evidence; do not infer fine-grained independence yet.
