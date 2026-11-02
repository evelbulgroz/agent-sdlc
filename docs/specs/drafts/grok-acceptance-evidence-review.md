# Grok acceptance review — acceptance evidence

**Status:** Read-only review of the current worktree, including untracked files.
**Date:** 2026-11-02. **Reviewer:** Grok.
**Scope:** Revised acceptance-evidence implementation against the four drafts
in this directory and `docs/handbook/anti-patterns.md`.

The suite, typecheck, build, and `reliability replay` were not re-run.
Conclusions come from the source. An earlier scan reported 0 of 157 changed
text files over the size ceiling and was not repeated here. Real host
adapters, host authorization, provider qualification, production ceilings,
and rollout thresholds remain activation prerequisites.

## Verdict

The offline implementation is not ready for acceptance. Five of the eight
claimed remediations are closed, two are only partly closed, and the in-graph
push is still open. Six high defects remain. Git delivery stays blocked for
the quality-state defects. The push defect can publish an unreviewed commit.

## Previous eight claims

| # | Claim | Result |
| --- | --- | --- |
| 1 | Strict quality answers, no injected `stateHash`, answer/resume round-trip | Schema and `stateHash` closed. A foreign finding id is stored before the graph rejects it. |
| 2 | Consumed answers stay replayable and project recovery | Closed. |
| 3 | Deterministic commits, durable final checkout, no replay of an unprovable edit | Those three gates are closed. A deterministic delta conflict still projects `resume` with no attempt cap. |
| 4 | New-policy `unlanded.patch` is one selected revision per task | Closed. A null recorded tree skips the equality check. |
| 5 | Check the branch commit and tree, then push that SHA | Open. The CLI does this. The graph push does not. |
| 6 | Process-group timeout and early stdin close | Timeout completion is closed on Linux. Adapter `PATH` lookup remains. |
| 7 | Production v2 `taskPlanHash` covers obligations, policy, and bindings | The hash binding is closed. The plan critic never sees those fields. |
| 8 | In-progress parent trees survive, and reused parent commits are checked | Closed for the in-progress window. |

## Findings

### 1. High — graph push publishes the movable branch

`workflow/nodes/commit.ts` 328–337 calls `assertQualityDeliveryAllowed` and
then `pushBranch` with no `sourceCommitSha`. `workflow/git-manager.ts`
371–376 therefore runs `git push -u origin <branch>`:

```ts
const refspec = sourceCommitSha
  ? `${sourceCommitSha}:refs/heads/${branchName}`
  : null;
gitCli('git', refspec
  ? ['push', remote, refspec]
  : ['push', '-u', remote, branchName], {
```

`cli/commands/pr.ts` 101–129 pins the SHA only when a checkpoint policy is
loaded. `workflow/quality-delivery.ts` 39–41 compares the preflight binding
tree with `snapshot.qualityCheckpointTreeSha`. It does not read
`refs/heads/<branch>` at push time.

Trace: delivery is allowed for commit `A`. Move `refs/heads/<targetBranch>`
to `B` before push resolves the name. The remote receives `B`. A same-tree
recommit also passes the tree gate and publishes a different SHA. Reused
local commits enter this node without `assertBranchCommitBinding`
(`workflow/nodes/commit.ts` 54–74).

Violates the push/PR delivery check in
`acceptance-evidence-and-qa-quality-gates.md` 172–177. Permits an unreviewed
commit to be published. `workflow/git-manager.spec.mjs` locks the unpinned
argv when `sourceCommitSha` is absent; its real-git SHA test calls
`pushBranch` directly.

Missing boundary: `createVerifyCommittedTreeNode` with push authorized, a
branch that moves after the quality check, and an assertion that the remote
receives `commitRecord.commitSha`.

### 2. High — the plan critic approves a hash it does not review

`policy/contracts/dag-schema.ts` 289–291 hashes the v2 wire projection.
Planning stores that hash (`workflow/nodes/planning.ts` 81–89) and the critic
binds it (`review/critic-gate.ts` 216 and 269). `packPlanDocument`
(`review/critic-input-packing.ts` 44–68) emits `planPolicyHash`, base, order,
and task metadata ending at `verificationCommand`. It omits
`evidenceObligations`, `qualityPolicy`, and `adapterBindings`. The contract
says the plan critic sees the obligations
(`acceptance-evidence-and-qa-quality-gates.md` 85–86).

Trace: a v2 plan with forbidden argv or a jsdom-only native-picker obligation
is hashed, a critic PASS is stored against that full hash, and freeze
continues. The model saw titles, paths, and verification commands. This fails
open for review. The hash still changes if those fields change.

Missing boundary: a plan-critic test whose packed document contains the
obligations, policy, and adapter bindings that `hashTaskPlanProjection` covers.

### 3. High — a coverage failure can resume into QA and accept the closure

`applyAcCoverageGate` commits `BLOCKED` and `AC_COVERAGE_FAILED`, including
`blockedReason: 'AC_COVERAGE_FAILED'`, before the human interrupt exists
(`workflow/preflight-gate.ts` 171–186). The interrupt is a second call
(381–384). Restart routing is:

```ts
if (snapshot.taskPlanFrozen !== true) return 'execute_plan_critic';
if (snapshot.preflightBindingArtifact) return 'execute_qa_critic';
```

`workflow/graph-topology.ts` 90–91. The earlier `QUALITY_REVIEW_BLOCKED`
check (line 31) does not match this reason. `createExecuteQaCriticNode` does
not consult `AC_COVERAGE_FAILED` (`workflow/nodes/review-qa.ts` 311–312).
After a QA pass, the closure is accepted and only then is delivery checked
(`workflow/qa-delivery.ts` 166–174):

```ts
quality.setClosureStatus(snapshot.runId, checkpointId,
  qualityContext.closure.binding.candidateRevision, 'accepted');
assertQualityDeliveryAllowed(runtime, deliverySnapshot);
```

Trace: stop after the coverage transition and before `blockQualityCheckpoint`.
Resume routes to `execute_qa_critic`. A QA pass spends one dispatch and
persists `accepted`. Delivery then throws because the latest coverage event
failed (`workflow/quality-delivery.ts` 53–61). The closure write is already
durable. The next resume replays that stored pass and throws again. Shell
watch stops after two identical blocked reasons (`cli/shell-driver.ts`
483–485).

Git push remains blocked. QA admission and closure acceptance do not. The
preflight spec stores the failure event and does not resume that snapshot
through `routeFromStart`.

Missing boundary: persist `AC_COVERAGE_FAILED` with `preflightBindingArtifact`
and no quality interrupt, restart from `START`, and assert the run does not
dispatch QA or accept the closure.

### 4. High — a deterministic correction conflict keeps projecting resume

`workflow/quality-correction-runner.ts` 202–220 sets
`qualityRecoveryAllowed` false only for an executing edit, a fixed
`SdlcError` list, or a message matching
`/unrecognized|provenance changed|identity changed/`. The list is
`PATH_CONTAINMENT_VIOLATION`, `POLICY_VIOLATION`, `TASK_EXECUTION_FAILED`,
`BUDGET_EXHAUSTED`, `INVALID_CONTRACT`, and `STORE_RECONCILIATION_FAILED`.
`materializeClosureTree` throws `RECONCILIATION_CONFLICT` with message
`Closure delta conflict for '<taskId>'` (`execution/eligible-closure.ts`
142–144). `failed` may return to `materializing`
(`persistence/quality-corrections.ts` 171–174). Continuation ignores the
blocked-attempt cap when the consumed answer is recorded
(`cli/continuation.ts` 95–98, `cli/status-projection.ts` 368–369):

```ts
if (qualityAnswerRecorded) {
  return validateContinuation(state.lastError?.metadata?.qualityRecoveryAllowed === false
    ? { action: 'stop', reason: 'HALTED' }
    : { action: 'resume', reason: 'INFRASTRUCTURE_RETRY' });
}
```

Trace: the owner revision is recaptured, then the consumer’s old delta does
not apply onto the new parent. The correction is stored `failed` with
`qualityRecoveryAllowed: true`. Every resume enters the runner again and
publishes `resume`. The current index is not updated, the model is not called
again once the owner row is `verifying`, and budgets are not replenished. A
raw `git apply` failure or `WORKTREE_FAILED` takes the same path. Shell watch
stops after two identical `QUALITY_REVIEW_BLOCKED` statuses. A supervisor
that follows the continuation card does not.

Fails closed for delivery and fails open for halt.
`workflow/quality-correction-runner.spec.mjs` 161–163 locks
`qualityRecoveryAllowed: true` for a generic simulated interruption. Its
consumer fixture does not overlap the owner file.

Missing boundary: a conflicting consumer patch, then two resumes, must end in
`stop` / `HALTED` with `qualityRecoveryAllowed: false` and zero additional
executor calls.

A crash during checkout, before status `executing`, is not this defect.
`executing` is stored before `executor.execute` (runner lines 118–122).
Resume of `executing` throws and does not call the model. Resume before that
write starts the approved edit for the first time.

### 5. High — a foreign finding id is stuck before the graph checks it

`cli/quality-answer.ts` 10–17 checks the interrupt, binding, and allowed
action. It does not check finding ids. `cli/commands/run-lifecycle.ts` 227
then calls `recordInterruptResponse`. A second artifact is rejected
(`persistence/interrupt-records.ts` 176–179):

```ts
if (interrupt.status === 'RESPONSE_RECORDED') {
  if (interrupt.responseArtifact !== responseArtifact) {
    throw new SdlcError('STALE_RESPONSE', 'A different response is already recorded');
  }
```

The exact-id check runs later (`workflow/nodes/quality-answer.ts` 77–82) and
throws `INVALID_INPUT`. The operator cannot replace the answer. The run stays
fail-closed and does not apply the correction. CLI quality-answer tests use
matching finding ids only.

Missing boundary: record a `quality_review` answer whose `findingIds` differ,
assert the interrupt stays `PENDING`, then record the exact set and consume it.

### 6. High — an uncharged QA reservation blocks every later dispatch

`reserveBudget` increments `logicalDispatches` before the provider call
(`persistence/quality-budget.ts` 89–94). A row still `reserved` is returned
as the slot (`review/qa-dispatch-slot.ts` 12–14). Any such reservation becomes
exhaustion (`review/qa-checkpoint.ts` 133–141):

```ts
if (round.action === 'budget_exhausted' || reservation) {
  return Object.freeze({ status: 'BUDGET_EXHAUSTED', hasP1: false, /* ... */ });
}
```

`qaDispatchLimits` also returns null while any other non-execution reservation
is `reserved` (`review/qa-resources.ts` 34–36).

Trace: stop after `reserveBudget` and before
`chargeBudget(..., 'interrupted')`. Later QA, including another checkpoint
with remaining logical capacity, returns `BUDGET_EXHAUSTED`. A charge that
reached `interrupted` advances `dispatchIndex` and can use a fresh id inside
the existing counter. This path does not replenish the counter or replay a
success. It fails closed by halting review. `review/qa-resources.spec.mjs`
encodes the stuck reservation as `BUDGET_EXHAUSTED`.

Missing boundary: a reserved row with no charge must either charge
`interrupted` and allow the next id while capacity remains, or halt only that
operation.

### 7. Medium — adapter argv is discovered through PATH

`AdapterRegistrationSchema` accepts any non-empty argv
(`policy/contracts/quality-evidence-schema.ts` 28). Production spawn forwards
`PATH: process.env.PATH` (`workflow/quality-checkpoints.ts` 64–70).
`spawnEvidence` uses `shell: false` and still passes `argv[0]` to `spawn`
(`host/evidence-transport.ts` 25–30). A slash-free command such as `node` is
resolved by `PATH`. The wire contract forbids command discovery
(`acceptance-evidence-wire-contract.md` 179–180). A different executable
earlier on `PATH` can emit one valid report and discharge obligations. Lookup
failure stays incomplete. This is an engine defect, separate from qualifying
a real host adapter.

Missing boundary: reject a non-absolute `argv[0]`, and compare the executed
inode with the hashed bundle.

### 8. Medium — delivery status can show a superseded QA result

`collectQaBriefAndAdvisories` keeps `review.attemptKey === currentAttemptKey`
(`workflow/node-helpers.ts` 213–218), so `:follow-up:` and `:dispatch:`
reviews are dropped. The selected row is `qaReviews.at(-1)`. The commit
payload copies that brief (`workflow/nodes/commit.ts` 283–303). Status prefers
a done or ready payload, and an empty array counts as present
(`cli/status-result.ts` 100–103). `currentQualityReview` does include those
prefixes (`cli/quality-status.ts` 154–160). `assertQualityDeliveryAllowed`
uses the `QA_CRITIC_COMPLETED` event. The operator can see old P1s after a
clearing follow-up, or miss a later dispatch pass. The git transition stays
on the event.

Missing boundary: a base-key P1, a later follow-up with no P1, a delivery
event, and a status document whose divergences come from the follow-up.

### 9. Medium — refutation evidence is a hash bag

`QualityAnswerSchema` requires non-empty `evidenceHashes` for `refute`
(`policy/contracts/quality-records-schema.ts` 89–98). The graph requires the
finding-id set to match and rejects `COVERAGE_FAILED`, `EVIDENCE_FAILED`, and
`INSUFFICIENT_EVIDENCE` (`workflow/nodes/quality-answer.ts` 77–86). There is
no finding-to-evidence map. One readable artifact can refute every critic
claim. The wire contract requires evidence that addresses each claim
(`acceptance-evidence-wire-contract.md` 314–316). Deterministic failures
cannot be cleared this way. Critic findings can.

Missing boundary: two findings, evidence bound to only one, and a rejected
`refute`.

### 10. Medium — deterministic blockers still have no checkpoint failure id

Empty findings produce empty `findingIds`, and the only allowed action is
`approve-correction` (`workflow/quality-interrupt.ts` 78–85). The interrupt
id hashes `runId`, `bindingHash`, `runtimeRevision`, `status`, and `reason`
(98–104). The wire contract asks for a checkpoint failure id (317–319). The
operator can correct, and cannot confirm the failure away. The answer is not
bound to a failure id separate from the reason text.

Missing boundary: a `COVERAGE_FAILED` interrupt with a failure id, and an
`approve-correction` answer that must echo it.

### 11. Low — failed coverage is labeled OK in the disposition

The failed payload still sets `canonical: true` and `status: 'OK'`
(`workflow/preflight-gate.ts` 206–209). `projectQualityStatus` copies
`payload.status` (`cli/quality-status.ts` 97–99) while also setting
`coverageStatus: 'AC_COVERAGE_FAILED'` and `coveragePass: false`. Delivery
reads the event type and `coveragePass`. An operator who reads only
`disposition.status` sees success.

Missing boundary: an `AC_COVERAGE_FAILED` event whose disposition status is
not `OK`.

## Earlier medium and low comments

| Comment | Classification |
| --- | --- |
| Budget hash checked immediately after calculation | Still absent. `save` writes JSON and returns the object (`persistence/quality-budget.ts` 44–48). `budgetHash` re-reads on the next consume or complete. Low. The CAS compares that later hash. |
| Refutation has no per-claim map | Still present. Finding 9. |
| Deterministic empty `findingIds` | Still present, with approve-correction only. Finding 10. |
| Adapter resolved through `PATH` | Still present. Finding 7. |
| Stale QA status | Still present in the delivery brief and payload. Finding 8. `currentQualityReview` includes follow-up and dispatch keys. |
| Symlinked parent directories | Fixed. `host/evidence-files.ts` 10–41 `lstat`s every segment, uses `O_NOFOLLOW`, and compares `realpath`. Retrieval returns `unavailable`. |
| Candidate line accounting | Fixed. Implementation paths are counted, then added to the JSON line count (`review/quality-evidence-packing.ts` 104–159). |
| Interrupted QA identity | Fixed only after `chargeBudget(..., 'interrupted')`. A crash that leaves `reserved` is Finding 6. |
| Early stdin close | `EPIPE` after exit is ignored (`host/evidence-transport.ts` 98–103). A passed receipt still requires `report.requestHash` of the full request (`host/evidence-port.ts` 182–188). No path was found where undelivered stdin discharges an obligation. |
| Helper-symbol retrieval | Intentionally unavailable (`review/quality-evidence-retrieval.ts` 74–76). Fail closed. |
| Old delta reapplied on the new parent | Intentional. The wire contract says to reapply the checked old delta as input and recapture a fresh parent and target (335–338). `parentRevisionSetHash` is written (runner line 91) and has no reader. Low write-only field. |
| Legacy false coverage emits `AC_COVERAGE_PASSED` | Intentional advisory behavior. New-policy failure emits `AC_COVERAGE_FAILED` and does not enter QA in that same call. |

## Tests that pass while production stays wrong

- `workflow/git-manager.spec.mjs` treats a missing `sourceCommitSha` as the
  normal push argv. The graph caller is the production push.
- `workflow/quality-correction-runner.spec.mjs` expects resume for a generic
  throw and never builds a conflicting consumer delta.
- `review/qa-resources.spec.mjs` expects a leftover `reserved` row to exhaust
  QA even when another slot could be charged.
- Plan-critic tests can assert `artifactHash === taskPlanHash` while
  `packPlanDocument` omits the hashed obligations.
- `host/evidence-transport.spec.mjs` times `sh -c sleep` and returns when
  `stop()` resolves, so it does not prove a grandchild died. A separate probe
  saw that grandchild dead after `SIGKILL` and was not repeated here.
- `host/evidence-port.spec.mjs` uses a fake child and closes stdin only after
  the full chunk.
- `workflow/reconciliation-integrity.spec.mjs` uses a fake `gitCli`. The hash
  comparison still runs.
- The preflight coverage spec stores `AC_COVERAGE_FAILED` and does not restart
  through `routeFromStart`.

## What is closed

Answer consumption is transactional and idempotent. The ask node returns the
consumed answer. Status hides a resolved consumed quality interrupt and
projects `resume` unless `qualityRecoveryAllowed === false`. Shell watch does
not treat `answer` as mechanical.

Synthetic correction commits pin author, committer, and `2000-01-01T00:00:00Z`
(`workflow/worktrees.ts` 96–104). Final materialization records `intended`,
`resetting`, then `checking-out` before `git read-tree --reset -u`
(`workflow/corrected-final-materialization.ts` 28–58). Staged revisions are
selected only in `completeCorrection`. An `executing` row is not given to the
model again.

New-policy archives rebuild from the current eligible revision of each task
and return that one diff (`persistence/run-archive-patch.ts` 40–71). A
supplied tree that differs throws. `targetTreeSha === null` skips that
comparison. The legacy worktree walk runs only when no v2 selection exists.

Production planning hashes `hashTaskPlanProjection` before save. Legacy
`1.0.0` plans with quality fields are rejected (`dag-schema.ts` 207–216).
Parent reuse compares `commit^{tree}` with `parentTreeSha`
(`execution/task-worktree-preparation.ts` 95–115). The in-progress write
includes `parentTreeSha` (196–201). Hydration keeps that tree only while
status is `in_progress`.

Linux evidence timeout kills the detached process group and resolves without
waiting for `close` (`host/evidence-transport.ts` 42–61). Missing adapters and
mismatched policy throw. Final checkpoint preparation compares the
reconstructed tree with `snapshot.targetTreeSha`. V2 reconciliation rejects a
missing delta and a mismatched patch hash.

## Conclusions

1. Claims 2, 4, 6’s process-group timeout, 7’s hash input, and 8 are closed.
   Claims 1 and 3 are closed for the behavior they name and still have the
   foreign-answer wedge and the conflict-resume loop. Claim 5 is not closed.
   The fresh-identity QA claim is closed only after an interrupted charge.
2. The offline implementation is not ready for acceptance. The push hole can
   publish a commit that was not the approved SHA. The plan critic can pass
   obligations it never saw. Coverage recovery can spend QA and accept a
   closure after a failed coverage gate. Correction conflicts and foreign
   answers do not halt cleanly.
3. Unresolved implementation work is findings 1–11, the write-only
   `parentRevisionSetHash`, the missing immediate budget-hash re-read, and the
   null-target archive equality skip. The activation prerequisites at the top
   of this note stay outside those defects.
