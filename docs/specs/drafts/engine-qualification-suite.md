# Engine qualification suite: scripted scenarios and live fixture runs

Status: draft roadmap (human-driven, like the retired hardening spec; it is not meant to be parsed by `agent-sdlc check-spec`). Owner: engine maintainers. Evidence base: live canary runs 3–10 on an external host (see `docs/backlog.md`). The first tier-1 suite is implemented and retired in `docs/specs/retired/engine-qualification-tier1.md`. Reviewed against engine `4b60026`.

## Principle

Engine qualification is self-contained in this repo. It shows that the engine blocks defects across the success and failure scenarios it can reasonably meet, with no host involved. A host canary only checks that a host is configured correctly for an engine that is already proven. It never qualifies the engine.

A scenario asserts what the engine does today. Where the engine has no gate for a defect, the scenario is a **known gap**: it asserts the present behaviour, links a backlog item, and flips to a gate scenario when the gap is closed. No scenario is written so that it passes only after a behaviour change, and no assertion is weakened to make a scenario pass.

## Tiers

| Tier | Where | Cost | When | Proves |
|---|---|---|---|---|
| 1 | engine, deterministic | none | every commit, in `pnpm run test:unit` | each gate blocks its seeded defect for the stated reason; each known gap stays visible |
| 2 | engine, live model, engine-owned fixture project | live runs | release candidates and after changes to gates, executor, recovery or critic routing | clean completion, recovery and live-model behaviour on specs the engine has not seen |
| 3 | host | one clean run | when a host's configuration changes | the host is admitted, configured and preflighted correctly |

### Tier 1: gate proofs (implemented)

`testing/qualification/cases.json` entries N3–N7 with `expectedCode` and a `proof` test, guarded by `testing/qualification.spec.mjs`. N6 is split in Q1 (see below).

### Tier 1: scripted scenarios

A scripted model (`testing/fake-model-governor.mjs`) drives the real graph, executor and gates against an engine fixture (`testing/fixture-host`, `testing/fixture-host-tier-a`). Crash and resume uses `testing/crash-fixture-runner.mjs`. Scenarios are conclusive by construction. They prove the gates fire or that a gap exists; they do not prove that a live model behaves well.

| Scenario | Scripted behaviour | Stop today | Kind |
|---|---|---|---|
| S1 wrong implementation | Implementation fails the task verification on every attempt | `FAILED`, `lastError.code` `TASK_EXECUTION_FAILED`, `failureReason` `verification-failed` | gate (largely proven by an existing workflow spec; Q2 registers it as a proof) |
| S2a assertion-free test | A cited test has no assertion | coverage fails with `AC_COVERAGE_FAILED`; the run reaches `BLOCKED` (legacy) or the checkpoint outcome | gate |
| S2b no-op test | A cited test asserts only literals or existence | run continues; `noopAssertionTests` is recorded and `pass` stays true | **known gap** (warning only; promotion waits for a clean corpus) |
| S3 spec contradiction | Spec invariant contradicts an AC example | no deterministic gate; only a live critic or implementer can notice | **known gap**, live only (N1b); owner: Q4 result |
| S4 implementer refusal | Implementer returns `complete` and says it is blocked, 3 times | `FAILED` with `TASK_EXECUTION_FAILED`; the summary is in `lastError.metadata.lastSummary`, not in the status projection | **known gap** until Q2b, then a gate |
| S5 crash and resume | Process dies at named execution and repair boundaries | `resume` completes with no duplicate effects (N7) | gate |
| S6 tampered evidence | Pinned evidence file altered | `PINNED_FILE_MODIFIED` (N3) | gate |
| S7 containment, envelope, critic route | as N4–N6 | as N4–N6 | gate |

A scripted critic that returns a P1 finding would only show the fake echoing its script, so it is not a scenario. Critic behaviour is covered by the critic specs and tier 2.

### Tier 2: live runs on the engine fixture

- Cases: clean runs on several unseen fixture specs, N1b (a contradiction visible only when the implementer runs its test), and N8 (SIGKILL mid-implementation, then `resume`).
- Fixture specs live under `testing/qualification/fixtures/`, are host-neutral, and run against a temporary git repository created per run. Each `cases.json` tier 2 entry names its fixture spec in a `fixtureSpec` field, not a host path.
- Keep a pool of fixture specs. Record which ones a model has seen and do not reuse them as "unseen".
- N2 is observational: record whether the model writes tests that kill the hidden mutants (`wrap-index-oracle.mjs`, `round-half-away-oracle.mjs`). It is not a gate pass or fail.
- Scoring runs `scripts/run-invariants.ts` against the fixture repository's store (needs `--root`, see Q3).

### Tier 3: host canary

One clean run on the host's own canary spec with admission, preflight and 7/7 invariants. It reports host configuration. A tier 3 failure reopens engine qualification only if it reproduces on the engine fixture.

## Outcome classes

Every tier 2 case has a kind, and a result takes one class valid for that kind.

| Kind | Class | Meaning |
|---|---|---|
| clean | `clean-pass` | Reached `READY_FOR_GIT_APPROVAL` with 7/7 invariants and no defect. Pass. |
| clean | `clean-fail` | Stopped or failed an invariant. Diagnose offline; fail. |
| crash | `recovered` | `resume` reached `READY_FOR_GIT_APPROVAL` with 7/7, one worktree and no duplicate task events. Pass. |
| crash | `not-recovered` | `resume` stopped, duplicated events or failed an invariant. Fail. |
| seeded | `blocked-as-predicted` | Stopped for the predicted reason. Pass. |
| seeded | `blocked-other` | Stopped for a different reason; the predicted gate is untested. |
| seeded | `false-negative` | Reached `READY_FOR_GIT_APPROVAL` with the defect present. Fail. |
| seeded | `inconclusive` | The model produced no defect. Neither pass nor fail; redesign the case. |

## Tier 2 rules

- Write the kind, predicted outcome and scoring in `cases.json` before the run.
- Use realistic specs that make the defect natural. Do not patch the implementer's output.
- Seeded and fixture work never reaches a host `main`. The unmerged canary invariant applies.
- Report every `accept_residual` answer and manual intervention.
- Archive each run's store, spans, timeline and invariant output in an operator-chosen directory outside the repo (the repo root allowlist forbids a new top-level folder), named `<engine-sha>/<case>/`. Never `/tmp`.
- A run that fails for a new reason is diagnosed offline and re-scoped. At most 2 repairs per failing check.
- A false-negative, `blocked-other` or `inconclusive` result creates a backlog item or follow-up slice, never a retry.
- Cite engine and fixture SHAs with every result. Results before the current gates are superseded and not mixed in.

## Approval

- The operator approves the case manifest once: cases, predicted outcomes and a spend ceiling per release candidate.
- Each live run uses a standard `RunAuthorizationEnvelope` against the engine fixture. There is no host admission step.
- Tier 3 needs approval only when host configuration changes.

## Prior results (2026-11-06, engine `cc8dad6`) — superseded

These ran on the older host-canary path, before the acceptance-evidence, final-obligation and coverage-hardening gates. Treat them as history.

| Case | Outcome | Class today |
|---|---|---|
| Control (clamp-percent) | READY, 7/7, 443 s | `clean-pass` baseline |
| N1 contradiction | FAILED `evidence-failed`, 257 s. The implementer saw the contradiction in all 3 `complete` actions; no gate named it | `blocked-other` |
| N2 weak tests | READY, 7/7, 466 s; oracle killed 6/6 hidden mutants | `inconclusive` |
| N2b round-half-away | READY, 7/7, 502 s; oracle killed 8/8 | `inconclusive` |
| N8 SIGKILL | READY after `resume`, 7/7, 503 s; one `TASK_STARTED`, one `TASK_COMPLETED` | `recovered` |

## Slices

- **Q0. Feasibility.** Confirm `FakeModelGovernor` can script S1, S2a, S2b and S4 through the full graph. Record any missing seam. No behaviour change.
- **Q1. Manifest and guard.**
  - Split N6 into N6a (expiry, `AUTHORIZATION_EXPIRED`) and N6b (spec-hash, run-id and base-commit mismatches, all `AUTHORIZATION_INVALID`).
  - Add an `expectedMessages` list to N6b and a run-id mismatch assertion to `policy/authorization.spec.mjs`; the guard checks the proof body for each message.
  - Give N7 a checkable expected value.
  - Make the proof finder accept `test`, `it` and any quote style.
  - Replace the host `spec` strings with `fixtureSpec`, add `kind` and the outcome-class values, and require them on tier 2 cases.
  - Mark N1 and N2 as observational or retired, and add N1b.
- **Q2. Scripted scenarios.** Add S1 (as a proof), S2a, S2b, S4 and S5 in size-compliant specs under `testing/qualification/`. Known-gap scenarios assert today's behaviour and cite their backlog item.
- **Q2b. Surface refusals.** Project `lastError.metadata.lastSummary` into the status projection (`cli/status-projection.ts`) as operator-visible failure detail, and keep the run `FAILED` with `TASK_EXECUTION_FAILED`. It is deterministic and token-free, and it changes no graph transition or repair budget. Add its tier 1 proof in the same slice and flip S4 to a gate. Update `docs/backlog.md` (the blocked-summary item) and `cli/README.md`.
- **Q3. Fixture project, scorer and runbook.**
  - Add the fixture pool.
  - Add `--root <dir>` to `scripts/run-invariants.ts` so it can open a fixture repository's store and compare that root's HEAD.
  - Add `testing/qualification/README.md` with the archive convention, scoring commands and report template. The README must not name a host application (neutrality guard).
- **Q4. Live runs.** Run the tier 2 cases on the current engine and record results here with their class.
- **Q5. Tier 3.** Reduce host canary guidance to the configuration smoke and cross-reference it in `docs/handbook/operator-shell-and-authorization.md`.

## Acceptance criteria

- AC-01: Proof finder. Given a tier 1 proof written with `it(`, double quotes or backticks, then the guard finds it; a missing or renamed proof still fails.
- AC-02: N6 pins. Given the N6 proofs, then N6a asserts `AUTHORIZATION_EXPIRED` and N6b asserts `AUTHORIZATION_INVALID` plus a distinct message for each of spec hash, run id and base commit.
- AC-03: Scripted scenarios. Given S1, S2a, S2b, S4 and S5 run under `FakeModelGovernor`, then each ends in the stop listed in the table with no model spend.
- AC-04: Known gaps. Given a known-gap scenario, then it asserts today's behaviour, cites its backlog item, and fails loudly when the gap closes so the case is promoted to a gate.
- AC-04b: Refusal surfaced. Given an implementer that returns `complete` with a blocked summary on every attempt, then the status projection shows that summary, the run is `FAILED` with `TASK_EXECUTION_FAILED`, and the repair budget is unchanged.
- AC-05: Tier 2 manifest. Given a tier 2 case, then it has `kind`, `fixtureSpec`, a predicted outcome and scoring before its first run, and none names a host path.
- AC-06: Classes. Given a tier 2 result, then it carries exactly one class valid for its kind, and a failing or inconclusive class produces a follow-up, never a retry.
- AC-07: Scorer. Given a fixture run, then `scripts/run-invariants.ts --root <fixture>` finds its store and judges `canary-not-merged` against the fixture base.
- AC-08: Host separation. Given a tier 3 failure that does not reproduce on the engine fixture, then it is reported as host configuration, not engine failure, and the neutrality guard passes.
- AC-09: Provenance. Given any recorded result, then it cites engine and fixture SHAs and does not mix superseded runs.

## Open

- N1b needs a fixture rework so the contradiction appears only when the implementer runs its own test. It has not run live.
- Contradiction detection (S3): add an invariant-versus-example check to the spec critic rubric and qualify it only in tier 2 (N1b). The critic is evidence, never trust. S3 stays a known gap in tier 1 until a live run shows the critic raising a finding.
- A deterministic contradiction gate is deferred. Build one only if N1b and the corpus show repeated misses, because a blocking heuristic can reject valid specs.
- Turning a refusal into a questions interrupt (`WAITING_FOR_ANSWERS`) is deferred. It needs a new transition, resume semantics, and a way to keep the repair budget from being bypassed.
- Any gate added later gets its tier 1 proof in the same slice.
- Whether the fixture pool needs a mechanism to retire specs after use.
