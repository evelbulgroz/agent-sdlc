# Intent

Status: retired 2026-11-11 (phase 3 implemented on `c5e6476`). The package coverage gate stays deferred. This file is no longer a `check-spec` goal.

## Goal

Let the operator approve one correction after an integration preflight halt. The correction becomes a new tree on the owning task. Reconciliation rebuilds the integration worktree from task diffs. The engine accepts a deletion only after a token-free reference proof. A second preflight failure halts with both records.

This is the residual operator path for a coverage-floor halt such as run `2026-11-10-sdlc-96d4e8da`, after the phase-2 retirement union has already frozen. It depends on the status record in `docs/specs/retired/integration-failure-status.md` and the walker in `docs/specs/retired/retirement-target-paths.md`. The normal way a retirement task gains a sibling path is that union scan. This card covers a path the walker cannot prove, including reflection and string tokens, and a run that has already halted. There is no autonomous deletion loop and no package coverage gate.

Current source: `workflow/reconciliation.ts` rebuilds integration by applying each task `git diff-tree` from `parentTreeSha` to `targetTreeSha`. An edit made only on the integration worktree is dropped on the next reconcile. `runApprovedQualityCorrection` requires a v2 plan, a stored correction, and `quality.listRevisionSelections`. `createTaskQualitySession` returns null when `getCheckpointQualityPolicy(plan)` is null, and the runner then throws `INVALID_CONTRACT` (`Correction quality policy missing`). A halt at `AUTONOMOUS_REPAIR_RETIRED` has no quality checkpoint for that runner. `correctionCompleted` transitions to `EXECUTING_IMPLEMENTATION`. `ESCALATED` may already transition to `RECONCILING_INTEGRATION` and to `EXECUTING_IMPLEMENTATION`. `REPAIRING_FAILURE` does not transition to `VERIFYING_PREFLIGHT`, and `repair_failure` only calls `escalateAutonomousRepairRetired`. `shell reply` is `cli/shell-driver.ts` and accepts `--run`, `--response-file`, and `--json`. `cli/shell-driver.ts` is 493 lines and 17257 bytes. `cli/arguments.ts` rejects other reply flags. `shell watch` replays only `resume` and `authorize`. `cli/continuation.ts` maps `ESCALATED` to `stop` with no response slots. `review/review-generation.ts` already refuses semantic repair on `policy.highRiskPaths` and oracle paths. Task-local repair stays at most two attempts (`maxAutonomousRepairs`).

## Non-goals

- Do not revive autonomous outer repair. `repair_failure` still halts.
- Do not add an `INTEGRATION_REPAIR` state.
- Do not add `--approve-remedy`, `--task-override`, or any other `shell reply` flag.
- Do not let `shell watch` submit the correction.
- Do not edit the integration worktree as the recorded patch.
- Do not treat a later green preflight, or a higher coverage number, as the reference proof.
- Do not waive a line-shifted clone or repair `contract_drift` in this slice.
- Do not commit, push, open a pull request, or raise the task-local repair budget.
- Do not increment `semanticRepairsCount`.
- Do not add a package coverage command or a second host preflight. That gate stays deferred. The canonical preflight still runs once after reconciliation.

## Owning context

agent-sdlc operator shell and quality correction. The proof runs in the engine against the candidate task tree. The model does not attest that references are zero.

## Touched surfaces

- cli/shell-driver.ts
- cli/correction-reply.ts (new)
- cli/correction-reply.spec.mjs (new)
- cli/host-invocation.ts
- cli/continuation.ts
- execution/reference-proof.ts (new)
- execution/reference-proof.spec.mjs (new)
- workflow/preflight-task-revision.ts (new)
- workflow/preflight-task-revision.spec.mjs (new)
- workflow/quality-correction-runner.ts
- workflow/nodes/quality-answer.ts
- workflow/preflight-gate.ts
- cli/README.md

## Invariants and constraints

- HOLD SCOPE: one residual operator card, the proof, rematerialization through the owning task, and the second-failure halt. Plan-time closure stays in the retirement draft.
- Offer the card only when `integrationFailure.category` is `coverage_floor_regression` and every reported path is inside the approved `allowedPathPrefixes`. `unclassified`, `baseline_clone_line_shift`, `quality_regression`, and `contract_drift` keep today's halt with no correction choice.
- A path that matches host `policy.highRiskPaths`, or an oracle path, gets no correction card. Zero correction attempts.
- The card is a continuation response slot `approve-correction` plus `stop`, submitted with `shell reply --response-file`. The slot lists the status paths and any resolved `taskId`. The response shape is `action`, optional `taskId`, and `paths`. `paths` must equal the card paths. The response cannot add a path.
- `action: stop` stores `integrationCorrectionConsumed: true` on the run, leaves every `targetTreeSha` and the frozen plan unchanged, leaves the state `ESCALATED` with `blockedReason` `AUTONOMOUS_REPAIR_RETIRED`, and does not increment `semanticRepairsCount`. The next continuation is action `stop` and reason `HALTED`. The card is not published again.
- `cli/shell-driver.ts` is 493 lines and 17257 bytes. The payload check lives in `cli/correction-reply.ts`. `shell-driver.ts` adds the import and the call only. If that crosses 500 lines, move `fillActionSlot` into the helper in the same slice before the call.
- The choice is absent from `MECHANICAL_CONTINUATION_ACTIONS`. `shell watch` leaves the card pending.
- Owner resolution uses the first match. If exactly one task's `taskAuthoredWritePaths` contains every reported path, that task is the owner and the response may omit `taskId`. Otherwise a task is the unique candidate when a file in its write set statically imports the reported path at `baseCommitSha` and that import is absent from the task `targetTreeSha`. The card names that `taskId` and the response must repeat it. Zero or several candidates require `taskId` in the response. Accept that id only when the task is in the frozen plan, every reported path is under its `targetPackage`, and every path is inside `allowedPathPrefixes`. A `taskId` that disagrees with a unique owner is rejected, and no tree changes.
- The correction write set for this revision is `taskAuthoredWritePaths` plus the card paths, still inside `allowedPathPrefixes`. The frozen plan path list is not rewritten. The new task patch may include the card paths, and reconciliation applies that full task diff.
- On approval with no bound quality checkpoint, `workflow/preflight-task-revision.ts` checks out the owning task at its current `targetTreeSha`, applies only the card edits, runs the proof, and on success stores a synthetic commit and `captureTaskDelta` as the new `targetTreeSha` and `patchHash`. It does not call `runApprovedQualityCorrection`, `createTaskQualitySession`, or `quality.listRevisionSelections`, and it does not require a quality policy or `qualityCheckpointId`.
- After that revision is stored, transition to `RECONCILING_INTEGRATION`. Do not transition to `EXECUTING_IMPLEMENTATION`. The existing reconcile node rebuilds integration from task diffs, and the graph enters `VERIFYING_PREFLIGHT` from there. `ESCALATED` to `RECONCILING_INTEGRATION` is already legal. Do not add a runtime state. Leave `repair_failure` as a halt.
- A bound quality checkpoint keeps its existing `approve-correction` runner. That runner calls the same proof before it keeps a deletion. It is not the entry point for `AUTONOMOUS_REPAIR_RETIRED`. Do not open a second card.
- Before the new task tree is accepted, `execution/reference-proof.ts` must pass and its artifact must be stored. The proof imports `policy/static-import-graph.ts` and does not reimplement the walker. It uses that walker's unresolved set. A non-literal import fails the proof. A bare specifier that names a walked file fails the proof when it refers to a deleted path. A `node:` import, and a package subpath that names no walked file, do not fail the proof. Decorator-only use and a string token still fail the proof.
- A deleted file needs zero resolved importers. A private method may be removed only inside a file that remains in the task write set, and only when the identifier has zero references in that static graph. The method name comes from the response and the file must already be on the card. Exported names fail the proof.
- Proof failure leaves the task tree unchanged and the run halted.
- One approval per halt. If preflight fails again, persist both failure records and return to the same halt kind with no further correction card. The task-local cap of two repairs is unchanged.
- This slice does not commit or push. Git delivery stays on the existing `READY_FOR_GIT_APPROVAL` gate.
- `workflow/quality-correction-runner.ts` is 247 lines and 15397 bytes. The checkpoint path adds a proof call only. The no-checkpoint materializer lives in `workflow/preflight-task-revision.ts`. `cli/status-projection.ts` stays untouched.
- No new dependency. Native type stripping and explicit `.ts` imports stay.

## Public contract impact

`ESCALATED` runs in category `coverage_floor_regression` gain a response slot. The response file may include `taskId` and must repeat the card `paths`. `action: stop` consumes the card and the following status continuation is `stop`. `shell reply` keeps `--run`, `--response-file`, and `--json`. Status gains no remedy proposal. High-risk and oracle paths gain no new operator action. Git delivery stays operator-gated. The frozen plan path list stays frozen.

## Acceptance criteria

1. AC-01: One response file can approve a contained correction or decline it. Given an ESCALATED coverage_floor_regression whose paths sit inside the approved prefixes and outside high-risk and oracle paths. Then shell reply accepts a response file choosing approve-correction, shell watch does not submit it, and action stop consumes the card without a new task tree. Cases: AC-01.1: the published slot is accepted; AC-01.2: an approve-remedy flag is rejected by the reply allowlist; AC-01.3: shell watch leaves the card pending; AC-01.4: a high-risk path offers no correction slot; AC-01.5: an oracle path offers no correction slot; AC-01.6: baseline_clone_line_shift offers no correction slot; AC-01.7: action stop persists integrationCorrectionConsumed, leaves the run ESCALATED, and the next continuation action is stop.
2. AC-02: The accepted edit is a new tree on the resolved owner. Given a coverage_floor_regression path inside allowedPathPrefixes. Then a unique owner is selected, an ambiguous owner requires taskId, and a proof-backed approval stores a new targetTreeSha. Cases: AC-02.1: the task diff contains the deletion; AC-02.2: reconcile rebuilds that deletion; AC-02.3: a path outside the card is rejected before any tree changes; AC-02.4: one removed import selects that task and the response must repeat taskId; AC-02.5: zero or several removed imports require taskId; AC-02.6: taskId is accepted only when the path is under targetPackage and inside allowedPathPrefixes; AC-02.7: a taskId that contradicts a unique write-set owner is rejected; AC-02.8: the revision patch may delete the card path without rewriting the frozen plan paths.
3. AC-03: The engine proof gates the edit. Given a proposed deletion or method removal. Then acceptance requires a stored proof of zero static references, and a green coverage number without that artifact is rejected. Cases: AC-03.1: zero static importers accepts a file deletion; AC-03.2: one importer outside the file rejects it; AC-03.3: a non-literal dynamic import rejects it; AC-03.4: a private method that still has a reference is rejected; AC-03.5: a preflight pass without the proof artifact rejects the revision.
4. AC-04: A second preflight failure stops with both records. Given a proof-backed correction whose rebuilt preflight fails. Then the run returns to the prior halt with both failure records and issues no second card. Cases: AC-04.1: the first and second packets are both retained; AC-04.2: no further approve-correction slot is issued; AC-04.3: semanticRepairsCount and the task repair cap stay unchanged.
5. AC-05: Re-entry reconciles without the quality correction runner. Given an ESCALATED coverage_floor_regression with no quality policy. Then the run reaches VERIFYING_PREFLIGHT through RECONCILING_INTEGRATION and runApprovedQualityCorrection is not called. Cases: AC-05.1: the approved path reconciles before preflight; AC-05.2: repair_failure with no operator approval still escalates; AC-05.3: the run does not commit or push; AC-05.4: EXECUTING_IMPLEMENTATION is not entered for this correction; AC-05.5: a missing quality policy still records the task tree after the proof; AC-05.6: a bound checkpoint correction uses the checkpoint runner and the same proof; AC-05.7: proof failure leaves the previous targetTreeSha in place.

## Failure defenses

- A coverage increase is not a proof. Assert the proof artifact id before the task tree is stored.
- Reject non-literal imports and bare specifiers that name a walked file. Do not treat them as zero. A `node:` import is not a reference to the deleted file.
- Assert action stop does not change `targetTreeSha` and the following continuation action is `stop`.
- Drive the card through `shell reply --response-file`. Assert `shell watch` does not consume it.
- Assert a direct write under the integration worktree is absent from the next reconcile.
- High-risk coverage uses the host profile list already read by `review/review-generation.ts`.

## Verification plan

- `execution/reference-proof.spec.mjs` cites AC-03 and imports `policy/static-import-graph.ts` rather than copying it.
- `cli/correction-reply.spec.mjs` cites AC-01 and AC-02. `workflow/preflight-task-revision.spec.mjs` cites AC-01.7, AC-02, and AC-05.
- Extend continuation specs for the card, checkpoint-runner specs for AC-05.6, and preflight-gate specs for AC-04.
- This slice is phase 3. Implement it after `integrationFailure` is projected and after `policy/static-import-graph.ts` exists.
- Run the touched specs, then `pnpm run build && pnpm run typecheck && pnpm run test:unit && node cli/cli.ts reliability replay` before calling the slice done.
- Saving this draft authorizes no implementation and no run.

## Unresolved questions

_None_

## Assumptions

- The status draft's `integrationFailure` object is the input to the card. This draft does not redefine categories.
- A reported path may sit outside every task write set. Owner resolution is the ordered rule in the invariants, not "the write set already contains the path".
- `ESCALATED` to `RECONCILING_INTEGRATION` stays the resume edge. This slice does not add `INTEGRATION_REPAIR` and does not send this correction through `EXECUTING_IMPLEMENTATION`.
- One operator approval is not an autonomous repair attempt.
- The static walker is the phase-2 module. This slice does not fork it. A sibling the retirement union already assigned is not a reason to open this card during planning.
