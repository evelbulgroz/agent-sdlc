# Intent

Status: retired 2026-11-11 (phase 1 implemented on `c5e6476`). This file is no longer a `check-spec` goal.

## Goal

When integration preflight or committed-tree verification fails, project a deterministic failure record the operator can read. The record names the halt path, the existing failure-packet classification, a closed integration category, and the paths a structured host report supplied.

Motivating run `2026-11-10-sdlc-96d4e8da` reconciled fourteen green task worktrees and then failed host preflight. This repository does not contain that run. The normative behavior is fixture-tested here.

Current source: `review/failure-packet.ts` maps quality, ESLint, and jscpd text to `quality_failure`. `FAILURE_CLASSIFICATIONS` in `policy/contracts/review-records.ts` is the closed set `test_failure`, `quality_failure`, `build_failure`, `review_finding`, `infrastructure_failure`, and `unknown`. `validateFailurePacket` rejects unknown keys. `workflow/preflight-gate.ts` calls `blockQualityCheckpoint` when a quality checkpoint is bound, and otherwise calls `escalateAutonomousRepairRetired` for a repairable verifier failure. `cli/continuation.ts` maps `ESCALATED` to continuation action `stop`. `projectedBlockedReason` in `cli/status-document.ts` omits `ESCALATED`, so the public status document hides `AUTONOMOUS_REPAIR_RETIRED`. `execution/task-quality-gate.ts` already fails a baseline jscpd clone whose text moved and tells the implementer to keep the original line numbers. `execution/ac-coverage.ts` checks citations, not statement coverage. `host/verify-runner.ts` returns `HostVerifyFailOutcome` with no `preflightResult` when `exitCode !== 0` or the result file is missing. Fail returns after a successful parse (non-canonical outcome, base mismatch, head mismatch) also omit the parsed object. `HostVerifyFailOutcome` has no `preflightResult` field. `review/verifier.ts` `runPreflightAndBind` builds `PreflightFailResult` from `outcome.output` only, and that type has no diagnostics field. `executePreflightVerifier` and `executeCommittedPreflightVerifier` both use `runPreflightAndBind`.

## Non-goals

- Do not add a runtime state, a transition into `VERIFYING_PREFLIGHT`, or a remedy task.
- Do not delete files, edit the integration worktree, or emit a deletion proposal.
- Do not waive a moved clone, rewrite `quality-v1.json`, or change `execution/task-quality-gate.ts` so a line shift passes.
- Do not add `ORPHAN_COVERAGE_DROP`, `LINE_SHIFT_BASELINE_DRIFT`, or `UNIFIED_CONTRACT_DRIFT` to `FAILURE_CLASSIFICATIONS`.
- Do not scrape percentages, line numbers, or orphan lists out of preflight prose.
- Do not relabel `AC_COVERAGE_FAILED` as a statement-coverage failure.
- Do not start, resume, or authorize run `2026-11-10-sdlc-96d4e8da`.
- Do not schedule a package coverage command or an extra host preflight. The canonical preflight remains one integration command.

## Owning context

agent-sdlc engine status projection and preflight failure records. One package. Hosts supply an optional diagnostics object. The engine does not own the host coverage floor.

## Touched surfaces

- host/verify-runner.ts
- host/verify-runner.spec.mjs
- review/verifier.ts
- review/verifier.spec.mjs
- review/failure-packet.ts
- workflow/preflight-gate.ts
- workflow/preflight-gate.spec.mjs
- cli/status-document.ts
- cli/status-integration-failure.ts (new)
- cli/status-integration-failure.spec.mjs (new)
- cli/README.md

## Invariants and constraints

- HOLD SCOPE: classification, status projection, and the tests and CLI note that display them.
- `classification` stays the existing closed enum. `category` is a separate closed set on the status record: `baseline_clone_line_shift`, `coverage_floor_regression`, `contract_drift`, `quality_regression`, `unclassified`.
- Leave the `validateFailurePacket` key set unchanged. Persist category on the verifier failure event payload and on status. A later schema bump may fold it into the packet.
- Read category only from an optional `integrationDiagnostics` object on the canonical host verify result. The object is closed and versioned. Absence, an unknown version, or an unknown category yields `unclassified`.
- When `verifyConfig.resultPath` is set and that file exists, `runHostVerify` parses it for a non-zero exit and for a zero exit. A successful parse is stored as optional `preflightResult` on `HostVerifyFailOutcome`, including the non-canonical, base-mismatch, and head-mismatch fail returns.
- A missing result file, or a file that is not a JSON object, leaves `preflightResult` unset. The outcome stays a failure and the category stays `unclassified`. Parsing never turns a non-zero exit into a pass.
- `runPreflightAndBind` copies a valid `integrationDiagnostics` object onto optional `PreflightFailResult.integrationDiagnostics`. `executePreflightVerifier` and `executeCommittedPreflightVerifier` both take that path. `preflight-gate.ts` and the committed-tree halt read that field and do not open the result file again.
- `coverage_floor_regression` requires `integrationDiagnostics.coverageFloor.pass` false and a non-empty path list. `contract_drift` requires `integrationDiagnostics.contractDrift.pass` false and a non-empty path list. Paths are copied from that object.
- `baseline_clone_line_shift` requires a `jscpd` diagnostic whose `textUnchanged` is true and whose observed line range differs from the baseline range. The preflight result stays failed. `quality_regression` is the category when `textUnchanged` is false. The task-local gate in `execution/task-quality-gate.ts` keeps its current fail-on-shift behavior.
- Halt paths are `AUTONOMOUS_REPAIR_RETIRED` (repairable verifier failure, no bound quality checkpoint), `QUALITY_CHECKPOINT_PREFLIGHT` (`blockQualityCheckpoint` with `PREFLIGHT_FAILED` and allowed action `approve-correction`), and `VERIFICATION_OUTSIDE_AUTHORIZED_SCOPE` (repairable false, category `unclassified`).
- Apply the same record to committed-tree verifier failures that escalate with `AUTONOMOUS_REPAIR_RETIRED`.
- `continuation` on the record is `stop` for `ESCALATED` when no correction card is open, and `approve-correction` for the quality-checkpoint interrupt. This slice does not add response slots. An open card and its stop answer belong to the operator slice.
- `cli/status-projection.ts` is 486 lines and 20369 bytes, with 111 bytes of headroom. Put the record builder in `cli/status-integration-failure.ts`. `buildStatusDocument` attaches it. Do not edit `cli/status-projection.ts`.
- `cli/status-document.ts` is 463 lines and 13170 bytes. The blocked-reason change and the one call must stay inside that headroom. Move an existing helper out first if they do not fit.
- `host/verify-runner.ts` is 274 lines and 6548 bytes. `review/verifier.ts` is 378 lines and 9312 bytes. Keep the new fields and the parse branch in those files.
- `projectedBlockedReason` must surface `AUTONOMOUS_REPAIR_RETIRED` for `ESCALATED` runs that carry that blocked reason.
- No model call. No new dependency. Native type stripping and explicit `.ts` imports stay.

## Public contract impact

Status documents gain an optional `integrationFailure` object with `haltPath`, `classification`, `category`, `targetPaths`, and `continuation`. Documents for runs that have not failed preflight omit it. The failure packet schema is unchanged. Shell reply flags are unchanged. `HostVerifyFailOutcome` gains optional `preflightResult`. `PreflightFailResult` gains optional `integrationDiagnostics`. Neither field is a new shell flag.

## Acceptance criteria

1. AC-01: A repairable preflight failure is readable on the status document. Given a host verify failure with no bound quality checkpoint and a valid integrationDiagnostics object. Then integrationFailure records haltPath AUTONOMOUS_REPAIR_RETIRED, the existing classification, one closed category, the reported paths, and continuation stop. Cases: AC-01.1: a coverage floor failure maps to coverage_floor_regression; AC-01.2: an unchanged jscpd clone at new lines maps to baseline_clone_line_shift and preflight stays failed; AC-01.3: a changed clone maps to quality_regression; AC-01.4: a contract drift failure maps to contract_drift; AC-01.5: a missing diagnostics object maps to unclassified; AC-01.6: a committed-tree verifier failure uses the same record shape.
2. AC-02: A bound quality checkpoint keeps its interrupt. Given a canonical preflight failure while a quality checkpoint is bound. Then haltPath is QUALITY_CHECKPOINT_PREFLIGHT, the allowed action is approve-correction, and blockedReason is not AUTONOMOUS_REPAIR_RETIRED. Cases: AC-02.1: checkpoint-bound preflight failure; AC-02.2: repairable false stays VERIFICATION_OUTSIDE_AUTHORIZED_SCOPE with category unclassified.
3. AC-03: Classification authorizes no write. Given any integration category, including unclassified. Then the engine writes no worktree edit, no deletion proposal, and no new runtime state. Cases: AC-03.1: coverage_floor_regression carries paths and no remedy text; AC-03.2: baseline_clone_line_shift does not make evaluateTaskQualityGate pass; AC-03.3: validateFailurePacket still rejects an extra category key; AC-03.4: AC_COVERAGE_FAILED is not relabeled coverage_floor_regression.
4. AC-04: The operator status shows the escalated halt reason. Given runtime state ESCALATED with blockedReason AUTONOMOUS_REPAIR_RETIRED and no open correction card. Then the status document blockedReason is AUTONOMOUS_REPAIR_RETIRED and continuation action is stop. Cases: AC-04.1: escalated repair retirement is visible; AC-04.2: a run with no preflight failure omits integrationFailure.
5. AC-05: A failing host command still yields a written diagnostics object. Given verifyConfig.resultPath names a JSON object that contains integrationDiagnostics. Then a non-zero exit and a non-canonical parsed result both carry that object through HostVerifyFailOutcome and PreflightFailResult into the status category. Cases: AC-05.1: a non-zero exit with an existing result file supplies the category; AC-05.2: a missing result file stays unclassified; AC-05.3: a parsed non-canonical result still supplies the category; AC-05.4: invalid JSON stays unclassified and the outcome stays failed; AC-05.5: the committed-tree verifier uses the same PreflightFailResult field.

## Failure defenses

- Fixture the host result object. Do not parse the motivating run's prose and do not copy its coverage percentages into an assertion of production truth.
- A diagnostics object that names a path is evidence of what the host reported, not proof that the path is unreferenced.
- An unchanged clone still fails the gate. A changed clone is `quality_regression`.
- Unknown diagnostics fail closed to `unclassified` and still halt.

## Verification plan

- Add `cli/status-integration-failure.spec.mjs` for AC-01, AC-03, and AC-04, with `@ac` and `@case` citations.
- Extend `host/verify-runner.spec.mjs` and `review/verifier.spec.mjs` for AC-05.
- Extend `workflow/preflight-gate.spec.mjs` for AC-02 and the committed-tree twin of AC-01.6.
- This slice is phase 1. It blocks no later slice's schema, and the correction slice consumes `integrationFailure` only after this projection exists.
- Keep one assertion that `evaluateTaskQualityGate` still fails a shifted baseline clone.
- Run the touched specs, then `pnpm run build && pnpm run typecheck && pnpm run test:unit && node cli/cli.ts reliability replay` before calling the slice done.
- Saving this draft authorizes no implementation and no run.

## Unresolved questions

_None_

## Assumptions

- Hosts that want a specific category will add `integrationDiagnostics` to the verify result. Older hosts stay `unclassified` and keep today's halt.
- `RUNTIME_SCHEMA_VERSION` stays put because the failure packet key set is unchanged.
- `cli/status-document.ts` can take a single call-site addition without crossing 500 lines or 20480 bytes. If it cannot, move an existing helper out in the same slice before adding the field.
