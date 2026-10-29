# Critic Review & Deterministic Verification (`review/`)

Heterogeneous adversarial critic review (`spec`, `plan`, `code`, `qa`), uncommitted git tree review generations, compact test excerpt extraction, and deterministic preflight verification.

## Key Files & Entrypoints

- `review/agent-review.ts` — Standalone critic CLI (`agent-review --phase <spec|plan|code|qa> --author-vendor <vendor>`).
- `review/critic-gate.ts` & `review/critic-budget.ts` — Graph-node critic runners (`spec`, `plan`, `qa`), round caps, and `attemptKey` / `artifactHash` deduplication.
- `review/critic-review.ts` & `review/author-vendor.ts` — Heterogeneous `CriticReviewAdapter`, vendor exclusion resolution, and surrogate-pair-safe prompt truncation (`sliceSafe`).
- `review/critic-input-packing.ts`, `review/critic-prompt.ts` & `review/excerpt-extractor.ts` — Rubric loading (`.agents/review-rubrics/*.md`), 24 KB / 1,000-line context ceiling, secret stripping, and compact test assertion excerpt packing.
- `review/critic-report-store.ts` & `review/citation-verifier.ts` — Report persistence under `tools/.review/<run-id>/` and finding citation checks.
- `review/review-generation.ts`, `review/review-execution.ts` & `review/semantic-review-evidence.ts` — Uncommitted tree materialization (`git write-tree`), scope fingerprints, and adversarial semantic review validation.
- `review/verifier.ts` & `review/failure-packet.ts` — Deterministic host verification (`verify.argv` via `host/verify-runner.ts` and `host/verify-config.ts`: `npm test` exit-code default, custom `verify.argv`, or receipt-backed `pnpm run verify:receipt`), 5-point evidence binding, and sanitized failure-packet construction.

## Core Invariants

1. **Reviewer-Vendor Heterogeneity (`critic-review.ts`, `author-vendor.ts`):**
   - The critic model's canonical vendor must strictly differ from every vendor that materially authored the artifact (`excludedVendors`).
   - `spec` and `plan` exclude the host author vendor; `code` and `qa` derive all successful `implementer`, `repairer`, `cleaner`, and `hardener` vendors from the runtime ledger.
   - Matching or unknown vendors fail closed with `IDENTICAL_REVIEWER_VENDOR` or `AUTHOR_VENDOR_UNKNOWN`.

2. **Graph Critic Placement vs Standalone Code Phase (`critic-gate.ts`):**
   Critic review is an evidence layer, not merge trust; canonical local done remains the host verification gate configured in `.agents/sdlc-host.json` (`verify.argv`—defaulting to `npm test` in `1.3.0` exit-code mode or receipt-backed `pnpm run verify:receipt` with `status=OK canonical=true`; see [`../host/README.md`](../host/README.md)).

   | Phase | Surface | Cap | Behavior |
   |---|---|---|---|
   | `spec` | Graph node (before `SPEC_APPROVED`) | $\le 2$ per approval attempt (`spec:<n>`) | Audits draft against `.agents/review-rubrics/spec.md`; residual P1s attach to the human approval packet. Never writes `approvedSpecHash`. |
   | `plan` | Graph node (before worktree creation) | $\le 2$ per envelope (`plan:<approvedPlanPolicyHash>`) | Audits runtime `taskPlanHash` against `.agents/review-rubrics/plan.md` before `taskPlanFrozen`; residual P1s trigger HITL (`accept_residual` / `reauthorize` / `cancel`). |
   | `qa` | Graph node (after green preflight & AC coverage) | $1$ per `approvedSpecHash` | Packs frozen ACs, compact test excerpts, and preflight log excerpts against `.agents/review-rubrics/qa.md`. Never executes test suites. |
   | `code` | Standalone CLI only (`agent-review --phase code`) | $1$ per generation/artifact | Never invoked from a graph node; runs on-demand for working-tree or staged diffs. |

3. **Prompt Ceilings, P1 Derivation & Provider Exhaustion (`critic-input-packing.ts`):**
   - Assembled critic prompts are capped at $\le 24\text{ KB}$ and $\le 1,000$ lines (`INPUT_OVERSIZED`).
   - Report status is derived strictly from whether any P1 finding exists (`hasP1`), ignoring subjective model status fields.
   - `excerpt-extractor.ts` retains at most 3 assertion lines per test ($\le 240$ chars), enforces an 80-line per-file soft cap, and prioritizes oracle files and uncited ACs before evicting.
   - In graph runs, if all configured provider routes fail to return a critic response, the node records a `CRITIC_REVIEW_FAILED` advisory and continues; budget, policy, and contract errors remain blocking.

## Standalone CLI Usage

```bash
agent-review --phase spec --target docs/specs/my-spec.md --author-vendor anthropic
agent-review --phase plan --target docs/specs/my-plan.md --author-vendor openai
agent-review --phase code --author-vendor google --scope packages/example-service
agent-review --phase code --author-vendor google --staged
agent-review --phase qa --target test/suite.ts --test-output test.log --author-vendor anthropic
```
