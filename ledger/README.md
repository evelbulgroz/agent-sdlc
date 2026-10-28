# Run Ledger, Cost Accounting & Fleet Analytics (`packages/agent-sdlc/ledger/`)

Per-run model operation accounting, per-role token/cost aggregation, archive ledger snapshots, and cross-run fleet friction summaries for `@fitness-app/agent-sdlc`.

## Key Files & Entrypoints

- `packages/agent-sdlc/persistence/run-ledger.ts` — SQLite run ledger queries and per-role token/cost aggregation (`provider`-reported vs. `estimated` fallback, plus `tokenDetails`).
- `packages/agent-sdlc/persistence/ledger-archive.ts` — Model-usage ledger snapshot archiving (`ledger.json`) during run completion and 7-day compaction.
- `packages/agent-sdlc/persistence/model-operation-records.ts` — Immutable model operation attempt persistence in `runtime.sqlite`.
- `packages/agent-sdlc/workflow/fleet.ts` — Fleet-level friction and learning-debt scanner (`readFleetFrictionSummary`) across live/archived run databases and `.agents/trace-findings/*.json`.

## Core Invariants & Analytics Surfaces

1. **Governed Attempt & Per-Role Accounting (`model-operation-records.ts`, `run-ledger.ts`):**
   - Every model invocation dispatched through `packages/agent-sdlc/adapters/model-governor.ts` records pre-dispatch reservations and post-dispatch token/cost usage in `runtime.sqlite`.
   - `run-ledger.ts` aggregates `operations`, `promptTokens`, `completionTokens`, `totalTokens`, `costMicrousd`, and observational `tokenDetails` (`cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`) by `roleId` and by accounting source (`provider` vs. `estimated`).
   - Proven non-execution failures (`executionProvenFalse: true`) reconcile reservations to zero token and cost charge.

2. **Archive Ledger Preservation (`ledger-archive.ts`):**
   - When runs are compacted into `<stateDir>/.archive/<run-id>/` (`packages/agent-sdlc/persistence/run-archive.ts`), `ledger.json` and `index.jsonl` retain per-role `provider`, `estimated`, and `tokenDetails` totals so historical cost and token analytics survive SQLite removal.

3. **Fleet Friction & Companion Analytics (`workflow/fleet.ts`):**
   - `readFleetFrictionSummary()` tracks `unreviewedFrictionCount` (runs with `PROMPT_FRICTION_DETECTED` not yet audited via `agent-sdlc skills`) and `staleRecommendationsCount` (`RECOMMENDED` `layer3` trends not yet applied in `.agents/applied-skills.json`), surfaced in `status.json`.
   - Companion analytics modules: execution failure traces & cross-run fingerprint clustering (`packages/agent-sdlc/scripts/trace-summary.ts`, [`../execution/README.md`](../execution/README.md)), critic & skill trend aggregation (`packages/agent-sdlc/scripts/aggregate-critic-trends.ts`, [`../roles/README.md`](../roles/README.md)), and stratified reliability & route-comparison reporting (`packages/agent-sdlc/policy/reliability/report.ts`, [`../policy/README.md`](../policy/README.md)).
