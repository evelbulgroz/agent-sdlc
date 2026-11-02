# Acceptance review: acceptance-evidence implementation (revision 2)

**Reviewer:** Claude (Opus 5.5), read-only review, 2026-11-02.
**Subject:** uncommitted worktree on `main` (HEAD `b01e840`), including untracked files,
implementing the four `acceptance-evidence-*` drafts in this directory.
**Verdict:** not ready for acceptance. Six of the eight earlier findings are fixed and two
are only partly fixed. The fixes also introduced three new High-severity defects: one
that can push unreviewed commits, and two that leave a run stuck.

Activation prerequisites (real host adapters, host authorization, provider qualification,
production resource ceilings, rollout thresholds) are intentional gates and are not
counted as defects here.

## Done bar

Re-run by the reviewer:
`pnpm run build && pnpm run typecheck && pnpm run test:unit && node cli/cli.ts reliability replay`

- 1494 tests: 1493 pass, 0 fail, 1 skipped.
- `reliability replay: PASSED (20/20, providerOperations=0)`.
- Every changed or new file is within 500 lines and 20,480 bytes.

The checks are green, but the defects below are not covered by any test.

## How findings were checked

- **Code-checked:** the reviewer read the causal code directly.
- **Reproduced:** a delegated reviewer reproduced it with the real CLI, a real SQLite
  store, real git or real subprocesses (scratch only under `/tmp`). Not re-run by the
  reviewer.
- **Hypothesis:** traced but not reproduced.

## New or still-open findings

### High

**N1. After any completed correction, no later checkpoint can be accepted.** Code-checked
and reproduced.

- **Code:** `persistence/quality-records.ts:114-116`:
  ```ts
  (revision.correctionId && revision.correctionId !== stagedCorrectionId)) { qualityFailure('Closure revision provenance mismatch');
  ```
  `saveClosure` (line 137) and `setClosureStatus` (line 188) call this without a
  `stagedCorrectionId`. Revisions promoted by `completeCorrection` keep their `correctionId`.
- **Trace:** `completeCorrection` finishes, then a fresh slice or final closure is set to
  `accepted` (`workflow/qa-delivery.ts:139/167`) and throws "Closure revision provenance
  mismatch".
- **Violates:** AC-03.7 and AC-07.6 (a correction must survive through to delivery).
- **Impact:** fails closed, but any run that has had a correction cannot reach delivery.
- **Missing test:** complete a correction, then accept a later slice or final checkpoint.

**N2. The in-graph push still pushes the movable branch ref.** Code-checked and
reproduced with a local bare remote.

- **Code:** `workflow/nodes/commit.ts:328-336` calls
  `pushBranch({ worktreeDir, branchName: branchToPush, remote: 'origin', gitCli })` with no
  `sourceCommitSha`. The verifier read `HEAD^{tree}` once, earlier.
- **Trace:** after `assertQualityDeliveryAllowed` passes, anything that commits to the
  branch is pushed. In the reproduction the remote ended up at the unreviewed commit. B5
  was fixed only in `cli/commands/pr.ts`, which pushes `<sha>:refs/heads/<branch>`, not
  forced, and rejects a moved branch.
- **Impact:** when the envelope authorizes push, this **permits unreviewed delivery**.
- **Missing test:** move the branch after the verifier runs, then assert the graph push
  is rejected or pinned to the approved SHA.

**N3. A deterministic failure after an answer is consumed produces an endless `resume`
loop with no path for a human.** Code-checked and reproduced through the real CLI.

- **Code:**
  - `cli/continuation.ts:95-98`:
    `if (qualityAnswerRecorded) … : { action: 'resume', reason: 'INFRASTRUCTURE_RETRY' }`.
    There is no attempt limit.
  - `workflow/nodes/quality-answer.ts:114-115`: after `consumeAnswer`, it does
    `if (!closure) throw … 'Missing refuted checkpoint'`. Failures in
    `assertClosureReady` (for example N1) or in `advanceAfterGreenPreflight` behave the
    same way.
- **Trace:** four status/resume cycles each showed `continuation=resume`,
  `executable=true`, and exit 64. A fresh `answer` is rejected with "Interrupt is not
  current".
- **Violates:** the repair budget (AGENTS.md #7, at most two autonomous repairs) and
  "failed/interrupted exits keep the blocker" with a usable human path.
- **Impact:** fails closed on authorization, but not on liveness. Shell watch stops only
  because the CLI exits with an error. A host that keeps executing the continuation card
  loops forever.
- **Missing test:** a CLI-level post-consume deterministic failure must end in a bounded
  halt.

### Medium

**N4. A correction failure that needs adjudication cannot be adjudicated.** Code-checked.

- **Code:** `workflow/quality-correction-runner.ts:207-224` sets
  `pendingInterruptId: answer.interruptId` (already resolved) and
  `qualityRecoveryAllowed: false`.
- **Trace:** continuation says stop. `answer` rejects because there is no pending
  interrupt, and no new interrupt is issued. A manual `resume` re-runs the correction
  runner. For a failed rebuild, that re-runs verification and QA, which spends tokens.
- **Impact:** fails closed, but the run is wedged.

**N5. Patch hashes disagree for non-UTF-8 content.** Code-checked; the hash mismatch was
reproduced with real git.

- **Code:**
  - `execution/task-tree-delta.ts:327-336` hashes `diff-tree` output decoded with
    `encoding: 'utf8'`.
  - `execution/eligible-closure.ts:123-124` hashes the raw Buffer.
- **Trace:** a delta touching a Latin-1 file triggers
  `INVALID_CONTRACT … delta hash mismatch` at slice, final, correction or archive
  materialization.
- **Impact:** fails closed. In addition, `quality-correction-runner.ts:99` applies a
  UTF-8-decoded patch, which would corrupt those bytes if it were ever reached.
- **Masking test:** `persistence/run-archive-quality.spec.mjs:176-177` wraps `gitCli`
  with `encoding:'utf8'`, which hides the mismatch.

**N6. The plan critic certifies a hash covering content it never sees.** Code-checked.

- **Code:** `review/critic-gate.ts:216` uses `artifactHash = snapshot.taskPlanHash`, which
  now covers obligations, policy and adapters. But `packPlanDocument`
  (`review/critic-input-packing.ts:44-68`) sends no obligations, slices, `qualityPolicy`
  or `adapterBindings`.
- **Violates:** quality-gates spec §1: "The plan critic sees these obligations."
- **Impact:** grants no extra authority, because the envelope still binds `qualityPlan`.
  It does create false evidence of review.

**N7. A v2 run cannot be re-planned after a crash or reauthorization.** The write-once
rejection is code-checked; reaching it from the graph is a hypothesis.

- **Code:** `createdAt: resolveNow()` (`policy/task-planner.ts:243/327/488`) changes the
  plan on every rebuild. `saveTaskPlan(plan)` (`workflow/nodes/planning.ts:82`) runs
  before the transition, and the immutable record is write-once.
- **Trace:** paths that would hit this are:
  - a crash between save and transition;
  - `reauthorize` at the plan critic (sets `taskPlanHash: null`);
  - BLOCKED/ESCALATED routing that falls back to `plan_tasks`.

  Each would hit "changed contents".
- **Impact:** fails closed; this conflicts with "adoption requires reapproval/replanning".

**N8. Background descendants survive a successful evidence run.** Code-checked and
reproduced.

- **Code:** `host/evidence-transport.ts:97`: `child.once('close', …) => finish(...)`. The
  process-group kill runs only from `stop()`.
- **Trace:** `sh -c '(sleep 33 …) & echo "{}"; exit 0'` returned exit 0 in 5 ms, and the
  `sleep` was still alive afterwards. A survivor can mutate the worktree after the
  `after = observeSource()` check.
- **Impact:** **permits stale evidence**.
- **Missing test:** assert no descendants remain after success.

**N9 (hypothesis). "Recoverable" deterministic correction errors retry without limit.**
Errors such as `RECONCILIATION_CONFLICT`, `WORKTREE_FAILED` and hydration failures set
`qualityRecoveryAllowed: true`, so continuation projects `resume` and the same failure
repeats. No retry counter was found.

### Low

- **Hard crash during QA dispatch halts as `BUDGET_EXHAUSTED`** (code-traced). A
  `kill -9` during dispatch leaves the reservation `reserved`; `review/qa-checkpoint.ts:132`
  (`|| reservation`) then halts with a mislabelled reason. In-process failures do get
  fresh charged identities.
- **Crash after a response is recorded asks the human again** (reproduced). Status shows
  `answer/HUMAN_RESPONSE_REQUIRED`, but a different answer is rejected. `resume` completes
  the original answer.
- **Duplicate refutation events are possible** (hypothesis). Replaying a final refutation
  could emit a second `REVIEW_EVALUATED`, because `transition` does not deduplicate by
  causalId.
- **Crash part-way through corrected-final checkout is unrecoverable** (hypothesis). A
  partial `read-tree -u` leaves a mixed tree, which fails permanently with
  `POLICY_VIOLATION`.
- **Hydration writes demoted task rows during a correction** (code-traced). Quality
  records remain authoritative, so this is integrity noise.
- **Two edge cases in parent and binding checks** (code-traced). `parentCommitSha` reuse
  checks the commit's tree but not its parent. A v2 run with no bound checkpoint whose
  verifier fails takes the legacy escalation path.
- **Processes can escape the timeout kill** (reproduced). Descendants that call `setsid`
  leave the process group, though wall time stays bounded at about 504 ms. This is
  inherent to process groups and is worth documenting.
- **Minor test softening.** `workflow/graph-topology.spec.mjs` no longer asserts the node
  count; `testing/deepen-workflow.spec.mjs` still does (33→35).

## Earlier Medium/Low comments

| Item | Status |
|---|---|
| Budget-ledger hash computed just before the check (`quality-correction-runner.ts:182`) | **Still present.** The compare-and-swap is a no-op; low impact because completion is a single transaction. |
| Refutation evidence has no per-claim mapping | **Still present.** An unrelated readable artifact was accepted (`quality-answer.ts:72-83`, `qa-delivery.ts:43-55`). |
| Deterministic failures have empty `findingIds` | **Still present** (`quality-interrupt.ts:78-85`). Fails closed because only approve-correction is offered. |
| Adapter `argv[0]` resolved through PATH | **Still present** (`evidence-transport.ts:25`). Reproduced: a planted `node` earlier on PATH was executed. |
| Stale status coverage/QA reads | **Fixed for quality runs** (`status-result.ts:111-136`). Legacy runs keep the old readers, which looks intentional. |
| Retrieval through symlinked parent directories | **Fixed.** Reproduced: a symlinked directory returns `unavailable`. A narrow TOCTOU window remains (hypothesis). |
| Candidate line accounting | **Fixed** (`quality-evidence-packing.ts:125,159`). |
| Interrupted QA dispatch | **Partly fixed.** See the hard-crash item under Low. |
| stdin EPIPE on early exit | **Fixed.** Reproduced with a 2 MB stdin and with fd 0 closed. |

## Other claimed fixes

- **Broken quality bindings surface instead of falling back: fixed.** The `catch` is gone.
- **Reconciliation rejects missing deltas and verifies patch hashes: fixed**, but see N5.
- **Final checkpoint tree checked against the selected-revision reconstruction:
  unverified.** No reviewer exercised it directly.
- **Legacy compatibility: holds.** HEAD and the current tree produced byte-identical
  legacy hashes on the same fixture. Advisory false coverage, `AC_COVERAGE_PASSED` and
  `QA_CRITIC_CAP=1` are unchanged, and a resume cannot switch policy.
- **No assertions were deleted or weakened** apart from the node-count softening noted
  under Low.

## Tests that pass only because mocks bypass production behaviour

- **`testing/task-quality-fixture.mjs`, shared by 5 specs.** It skips `planTaskDag` and
  injects `taskPlanHash`. It also monkey-patches `getAuthorization`, stubs `transition`,
  and uses fake evidence spawn.
- **`workflow/quality-answer-recovery.spec.mjs`.** Calls the answer node directly with an
  injected throw. It never goes through the CLI, graph replay or the continuation
  projection, so it misses N3 and N4.
- **`cli/commands/quality-answer.spec.mjs`.** Exercises only `confirm`, with a fake binding
  and no closure. It also locks in the mechanical `resume` projection after consumption.
  The resolution contract says these responses must never be projected as `resume`, so
  either that sentence or the projection needs to change.
- **`host/evidence-transport.spec.mjs:68`, the "real process timeout" test.**
  `sh -c 'sleep 0.6'` execs sleep directly, so there is no descendant and no `ps` check;
  the test would pass without the descendant-kill fix.
- **`cli/commands/pr.spec.mjs`.** Uses a fake `gitCli` on a non-quality run. The graph push
  in `commit.ts` is never driven against real git, which is why N2 went undetected.
- **`workflow/reconciliation-integrity.spec.mjs` and
  `persistence/run-archive-quality.spec.mjs`.** A fake patch string and a UTF-8-wrapped
  `gitCli` hide N5. The archive spec also has no correction or obsolete revision.
- **`workflow/nodes/planning.spec.mjs`, the v2 test.** It never mutates an obligation,
  adapter or policy, and `assertTaskPlanHash` has no negative test.

## Conclusions

**1. Are the earlier eight closed?** Six are fixed and two are only partly fixed:

| Finding | Status |
|---|---|
| B1: CLI quality answers | Fixed |
| B2: answer recovery | Partly fixed: replay works, but N3/N4 replace the wedge with a loop or a dead end |
| B3: correction recovery | Fixed: deterministic commits verified with real git; durable intent before checkout |
| B4: archive patch | Fixed: one diff from base to the selected-revision closure |
| B5: push authorization | Partly fixed: `pr.ts` only; the in-graph push (N2) is still open |
| H6: evidence timeouts | Fixed for timeouts; the success path is still open (N8) |
| H7: frozen plan hash | Fixed; the critic input gap (N6) is new |
| H8: parent provenance | Fixed |

**2. Is the offline implementation ready for acceptance?** No. N2 permits unreviewed
delivery, and N1 and N3 mean any run that goes through a correction or a post-answer
failure cannot finish or loops.

**3. What remains unresolved?**

- **Blockers:** N1–N3.
- **Medium:** N4–N8, plus the N9 hypothesis.
- **Earlier Medium/Low comments still present:** the budget-ledger hash check, per-claim
  refutation evidence, empty `findingIds`, and PATH-resolved `argv[0]`.
- **Missing regression tests:** a correction followed by a later checkpoint acceptance;
  a graph push against real git with branch drift; CLI post-consume failures; non-UTF-8
  deltas; leftover descendants after a successful evidence run; v2 replan and
  reauthorization; and the critic seeing obligations.

These are all offline defects, separate from the activation prerequisites.
