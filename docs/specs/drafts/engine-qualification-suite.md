# Engine qualification suite

Status: draft. Owner: engine maintainers. Evidence base: live fitness-app canary runs 3–10 (see `docs/backlog.md`).

## Purpose

Show that the engine blocks defects, not only that it completes clean runs. A case passes when the engine stops for the predicted reason. A green run on a seeded defect is a false negative and is recorded, never retried.

## Tiers

| Tier | Cost | When | Cases |
|---|---|---|---|
| 1 | no model spend | every engine commit, in `pnpm run test:unit` | N3 evidence tamper, N4 critic route exhausted, N5 path escape, N6 envelope expired or mismatched |
| 2 | full live run (about 25 min, about $0.3 each) | release candidates and after major engine changes | N1 wrong implementation, N2 weak test, a clean canary on the existing spec, a clean canary on an unseen spec |

## Case manifest

`testing/qualification/cases.json` holds one entry per case: `id`, `tier`, `seededDefect`, `expectedOutcome`, and for tier 1 `expectedCode` plus a `proof` (spec file and test title). `testing/qualification.spec.mjs` fails when a tier 1 proof test is renamed, removed, or no longer mentions its expected code, so a case cannot be dropped silently. Tier 1 behaviour itself is asserted by the existing gate specs and is not duplicated.

## Tier 2 rules

- Write the predicted outcome before the run, in the manifest.
- Use realistic specs that make the defect natural. Do not patch the implementer's output after the fact.
- Seeded work never reaches host `main`. The unmerged canary invariant applies.
- Pass criteria:
  - Clean canaries reach `READY_FOR_GIT_APPROVAL` with 7/7 invariants from `scripts/run-invariants.ts`.
  - N1 and N2 stop in a non-ready state with the predicted reason.
  - Report every `accept_residual` answer and every manual intervention per run.
- Archive each run's store, spans, timeline and invariant output outside `/tmp`.
- If a run fails for a new reason, diagnose offline and re-scope. At most 2 repairs per failing check.

## Results (2026-11-06, engine `cc8dad6`, host `e725ae10`, run on the older host-canary path)

| Case | Run | Outcome | Notes |
|---|---|---|---|
| Control (clamp-percent) | `…-aa22febc` | READY, 7/7, 443 s | Path works. |
| N1 contradiction | `…-4765e619` | FAILED `evidence-failed`, 257 s | The spec critic (grok-4.7) raised 0 findings. The implementer wrote no file in 3 attempts. Fail-closed, but no gate named the contradiction. |
| N2 weak tests | `…-9ff495c3` | READY, 7/7, 466 s | The oracle killed all 6 hidden mutants. No weak tests were produced, so the case is inconclusive for gate sensitivity. |
| N8 SIGKILL mid-implementation | `…-3a777ade` | READY after `resume`, 7/7, 503 s | One `TASK_STARTED`, one `TASK_COMPLETED`; the engine offered `INFRASTRUCTURE_RETRY`. |

Evidence is under the session `files/qualification/`.

## Open

- N1 and N2 specs are drafted in fitness-app `docs/specs/drafts/qualification-n{1,2}-*.md` (older host-canary path, no acceptance-evidence admission). N2 is scored offline by `testing/qualification/wrap-index-oracle.mjs` against hidden mutants.
- N1 did not show that a gate can detect the contradiction. Next: a variant where the implementer does write, or an explicit plan-gate probe.
- N1 finding: the implementer did detect the contradiction. Each of its 3 `complete` actions said it was blocked by contradictory requirements and asked which rule wins. The engine recorded only `evidence-failed`, with no operator-visible question. See `docs/backlog.md`.
- N2b (`…-df20ee16`, harder round-half-away spec, 8 hidden mutants, `round-half-away-oracle.mjs`): READY, 7/7, 502 s. The oracle killed all 8 mutants, so it is inconclusive again. The model writes thorough tests on these specs. Next: a subtler trap or a weaker implementer route.
- Decide whether the clean unseen-spec canary lives in the engine fixtures or in a host.
- Designed crash and resume cases (not yet in the suite).
