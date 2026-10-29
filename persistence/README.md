# Persistence, Runtime Store & Run Archival (`persistence/`)

Authoritative SQLite run store (`runtime.sqlite`), content-addressed artifact storage, LangGraph checkpoint persistence, and 7-day run retention, worktree cleanup, and `.archive/` compaction.

## Key Files & Entrypoints

- `persistence/runtime-store.ts` — SQLite event store facade coordinating domain record modules (`checkpoint-records.ts`, `delivery-records.ts`, `friction-records.ts`, `generation-records.ts`, `interrupt-records.ts`, `learning-records.ts`, `model-operation-records.ts`, `projection-records.ts`, `review-records.ts`, `run-ledger.ts`, `store-integrity.ts`, `store-migrations.ts`, `task-plan-records.ts`).
- `persistence/artifacts.ts` — Content-addressed run artifact store with SHA-256 digest verification.
- `persistence/run-paths.ts` — `REPOSITORY_ROOT`, state directory resolution (`tools/.agent-sdlc` or `AGENT_SDLC_STATE_DIR`), `liveRunRoot`, `archiveRoot`, `listRunDatabases`, and realpath containment checks.
- `persistence/langgraph-checkpointer.ts` & `persistence/ledger-archive.ts` — LangGraph SQLite checkpointer and model-usage ledger snapshot archiving.
- `persistence/run-retention.ts`, `persistence/run-cleanup.ts`, `persistence/run-compaction.ts` & `persistence/run-archive.ts` — Pure retention classification, merged-worktree removal, `VACUUM INTO` SQLite compaction, and atomic `.archive/` staging.

## Core Invariants

1. **Machine-Local Authoritative State vs Git-Tracked Projections (`run-paths.ts`):**
   - Live run state defaults to `<stateDir>/<run-id>/` (or `AGENT_SDLC_STATE_DIR` within the repository root) and is gitignored.
   - `docs/specs/runs/<run-id>/` (`intent.md`, `decisions.md`, `status.json`, `candidate-learnings.json`) is a read-only compatibility projection, never the authoritative state store.
   - `recordDiagnostic()` in `runtime-store.ts` writes diagnostic rows and `FALSE_ECONOMY_DETECTED` events in a single atomic SQLite transaction; replay mismatches fail closed with `STORE_RECONCILIATION_FAILED`.

2. **Two-Tier Run Retention & Compaction (`prune-runs`):**
   `agent-sdlc prune-runs [--dry-run] [--json]` sweeps recorded runs under `<stateDir>/<run-id>`:
   - **Merged-worktree cleanup (< 7 days, `run-cleanup.ts`, `workflow/landed-check.ts`):** Runs in `DONE` or `READY_FOR_GIT_APPROVAL` updated less than 7 days ago whose changed paths match `main` (`git diff-tree` blob comparison against `git ls-tree main`) have their detached worktrees (`worktree`, `worktrees/<task-id>`, `worktrees/integration`) removed via `removeWorktree(..., { force: true })` and `git worktree prune` while preserving `runtime.sqlite`, `artifacts/`, and the model-usage ledger.
   - **7-day archive compaction ($\ge 7$ days, `run-compaction.ts`, `run-archive.ts`):** Runs in any state with `now - runs.updated_at >= 7d` are staged into `<stateDir>/.archive/<run-id>.partial/`, compacted via `VACUUM INTO` with `checkpoints` and `checkpoint_writes` dropped, verified via `PRAGMA integrity_check` and exact retained row counts, bundled with `artifacts/`, `ledger.json`, and `unlanded.patch` (for unlanded `READY_FOR_GIT_APPROVAL` or `DONE` runs), atomically renamed to `<stateDir>/.archive/<run-id>/`, and appended to `<stateDir>/.archive/index.jsonl` with per-role `provider`, `estimated`, and `tokenDetails` totals before live worktrees and folders are removed.

3. **Archive Analytics & Auto-Prune Trigger (`cli/auto-prune.ts`):**
   - `scripts/critic-trends-sources.ts`, `workflow/fleet.ts`, and `scripts/trace-summary.ts` read both live and archived run stores via `listRunDatabases`. `resume` and `status` reject archived run IDs with `INVALID_INPUT` naming `<stateDir>/.archive/<run-id>`.
   - After the host verification script records a canonical `OK` result on `main` in the primary checkout (when `CI` is unset and `AGENT_SDLC_AUTO_PRUNE !== '0'`), `auto-prune.ts` spawns a detached `prune-runs` sweep guarded by `<stateDir>/.archive/sweep.lock` and logging to `<stateDir>/.archive/sweep.log`.
