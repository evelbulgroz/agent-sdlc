# Persistence, Runtime Store & Run Archival (`persistence/`)

Authoritative SQLite run store (`runtime.sqlite`), content-addressed artifact storage, LangGraph checkpoint persistence, and 7-day run retention, worktree cleanup, and `.archive/` compaction.

## Key Files & Entrypoints

- `persistence/runtime-store.ts` — SQLite event store facade coordinating domain record modules (`checkpoint-records.ts`, `delivery-records.ts`, `friction-records.ts`, `generation-records.ts`, `interrupt-records.ts`, `learning-records.ts`, `model-operation-records.ts`, `projection-records.ts`, `review-records.ts`, `run-ledger.ts`, `store-integrity.ts`, `store-migrations.ts`, `task-plan-records.ts`).
- `persistence/artifacts.ts` — Content-addressed run artifact store with SHA-256 digest verification.
- `persistence/run-paths.ts` — `REPOSITORY_ROOT`, state directory resolution (`tools/.agent-sdlc` or `AGENT_SDLC_STATE_DIR`), `liveRunRoot`, `archiveRoot`, `listRunDatabases`, and realpath containment checks.
- `persistence/langgraph-checkpointer.ts` & `persistence/ledger-archive.ts` — LangGraph SQLite checkpointer and model-usage ledger snapshot archiving.
- `persistence/run-retention.ts`, `persistence/run-cleanup.ts`, `persistence/run-compaction.ts` & `persistence/run-archive.ts` — Pure retention classification, merged-worktree removal, `VACUUM INTO` SQLite compaction, and atomic `.archive/` staging.
- `persistence/quality-records.ts` — `runtimeStore.quality`: immutable task revisions,
  selected-current index, closure lifecycle, registered candidate worktrees, charged
  execution/review reservations, and evidence receipts. `quality-corrections.ts`
  owns answer-consumption CAS and whole-correction publication; `quality-budget.ts`,
  `quality-invocations.ts`, and `quality-storage.ts` are bounded collaborators.

## Quality Record API

Schema 15's additive quality tables are installed on both new and existing
stores without rewriting legacy records or changing legacy hash projections.
New wire records are closed-schema validated. Structured identity hashes use the
canonical contract hash; adapter reports and artifact byte hashes remain
engine-observed raw-byte hashes.

`saveAuthorization` durably preserves the approved optional `qualityPlan` in the
same transaction as the authorization row, keyed by its approved policy hash.
`getAuthorization` restores and validates that exact plan after reopen; changing
its content without a new approved hash is rejected. Legacy absence stays omitted.

`saveTaskPlan` preserves the validated immutable v2 wire projection, including
policy, adapter bindings and obligations. `taskPlans.getImmutableTaskPlan(runId)`
reads that projection. `getTaskPlan` retains its v2 identity while hydrating the
runtime task view from eligible current quality revisions; mutable task state
does not enter its immutable plan hash. Re-saving changed v2 planning content
under the same run is rejected, and an existing v2 plan cannot downgrade to v1.

- Persist completed revisions with `quality.saveTaskRevision(record)`; select with
  `selectTaskRevision(runId, taskId, executionRevision)`. Historical rows are
  immutable after completion. Before completion, the same revision may advance
  through materializing/executing/verifying without changing its identity or
  parent provenance; lifecycle snapshots remain recorded. Verifying may capture
  its target tree and patch together before receipts arrive; those captured
  hashes cannot change on completion. `getTaskRevision` reads that exact revision.
  `listRevisionSelections` exposes raw persisted index provenance, including
  ineligible entries, without granting completion trust.
  `getCurrentTaskRevision` and `listCurrentTaskRevisions` return no
  eligible selection while any correction remains incomplete.
- `registerWorktree` records an engine-chosen contained run-relative path,
  registry identity, kind, owner and source/binding hashes before dispatch.
  Task paths use `worktree`/`worktrees/`; non-task checkpoints additionally permit
  `checkpoint-worktrees/<engine-safe-id>`. Symlink traversal is rejected.
- `initializeBudget`, `reserveBudget`, and `chargeBudget` preserve charged work
  across failures. Reservations precede dispatch; identical operation replay is
  free, changed content is refused. Actual overruns stay charged and prohibit
  subsequent dispatch. `interruptInvocations` marks unfinished dispatches and
  their reservations interrupted without treating them as successful.
- `reserveInvocation`, `startInvocation`, and `completeInvocation` persist the
  evidence lifecycle; completion atomically stores receipt/report/observations.
  `getEvidenceCompletionByReceiptHash` returns only non-invalidated evidence.
- `saveVerificationReceipt` records ordinary deterministic task verification,
  including enabling tasks without acceptance obligations. It requires an intact
  content-addressed execution artifact and binds the returned receipt hash to the
  exact task, execution revision and target tree; success is never fabricated
  from an absent host evidence report.
- Freeze the machine-selected pending interrupt through `bindInterrupt`, then
  consume a validated answer through `consumeAnswer`. It checks interrupt,
  candidate binding, expected current revisions, findings and budget hash in one
  transaction. Correction approval invalidates affected eligibility, preserving
  historical records and budgets. Staged revisions cannot win the current index.
  `getConsumedAnswer(runId, interruptId)` returns the exact hash-checked durable
  answer for interrupted application. A resolved quality interrupt may remain
  referenced only while its consumed answer is being recovered; it is not a new
  unanswered operator request.
  Advance durable correction states before side effects. `completeCorrection`
  checks every affected staged revision and rebuilt closure, then swaps all
  current selections and closes the correction atomically.
  `saveStagedClosure(correctionId, record)` validates correction-local evidence
  while exposing only verifying/reviewing status until atomic publication.
  Published revisions retain their `correctionId`; later closures may use them
  only while the completed correction's committed selection remains current.
  Unrelated active staging never acquires that provenance.
  Interrupted/failed corrections may restart at materializing, never at completed.

Registered task/enabling/slice/final worktrees participate in retention presence
and individual Git cleanup, including nested checkpoint containers. Registered
checkpoint snapshots are excluded from archive task-patch discovery. For quality
plans, `unlanded.patch` is reconstructed from every current selected task delta
in frozen integration order with raw-byte patch hashes and current parent-revision
provenance. A supplied final tree and any matching persisted final closure must
agree with the reconstruction. A null final tree before a final snapshot exists
still permits a coherent selected-closure archive; missing
or inconsistent selections fail closed rather than falling back to stale task
worktrees. Compaction retains all quality records; only LangGraph checkpoint
tables are dropped.

## Core Invariants

1. **Machine-Local Authoritative State vs Git-Tracked Projections (`run-paths.ts`):**
   - Live run state defaults to `<stateDir>/<run-id>/` (or `AGENT_SDLC_STATE_DIR` within the repository root) and is gitignored.
   - `docs/specs/runs/<run-id>/` (`intent.md`, `decisions.md`, `status.json`, `candidate-learnings.json`) is a read-only compatibility projection, never the authoritative state store.
   - Store schema `14` adds nullable `run_authorizations.preparation_policy_hash` (migration `migrations/upgrades-v14.ts`); existing rows are not rewritten and read back without a preparation binding.
   - `recordDiagnostic()` in `runtime-store.ts` writes diagnostic rows and `FALSE_ECONOMY_DETECTED` events in a single atomic SQLite transaction; replay mismatches fail closed with `STORE_RECONCILIATION_FAILED`.

2. **Two-Tier Run Retention & Compaction (`prune-runs`):**
   `agent-sdlc prune-runs [--dry-run] [--json]` sweeps recorded runs under `<stateDir>/<run-id>`:
   - **Merged-worktree cleanup (< 7 days, `run-cleanup.ts`, `workflow/landed-check.ts`):** Runs in `DONE` or `READY_FOR_GIT_APPROVAL` updated less than 7 days ago whose changed paths match `main` (`git diff-tree` blob comparison against `git ls-tree main`) have their detached worktrees (`worktree`, `worktrees/<task-id>`, `worktrees/integration`) removed via `removeWorktree(..., { force: true })` and `git worktree prune` while preserving `runtime.sqlite`, `artifacts/`, and the model-usage ledger.
   - **7-day archive compaction ($\ge 7$ days, `run-compaction.ts`, `run-archive.ts`):** Runs in any state with `now - runs.updated_at >= 7d` are staged into `<stateDir>/.archive/<run-id>.partial/`, compacted via `VACUUM INTO` with `checkpoints` and `checkpoint_writes` dropped, verified via `PRAGMA integrity_check` and exact retained row counts, bundled with `artifacts/`, `ledger.json`, and `unlanded.patch` (for unlanded `READY_FOR_GIT_APPROVAL` or `DONE` runs), atomically renamed to `<stateDir>/.archive/<run-id>/`, and appended to `<stateDir>/.archive/index.jsonl` with per-role `provider`, `estimated`, and `tokenDetails` totals before live worktrees and folders are removed.

3. **Archive Analytics & Auto-Prune Trigger (`cli/auto-prune.ts`):**
   - `scripts/critic-trends-sources.ts`, `workflow/fleet.ts`, and `scripts/trace-summary.ts` read both live and archived run stores via `listRunDatabases`. `resume` and `status` reject archived run IDs with `INVALID_INPUT` naming `<stateDir>/.archive/<run-id>`.
   - After the host verification script records a canonical `OK` result on `main` in the primary checkout (when `CI` is unset and `AGENT_SDLC_AUTO_PRUNE !== '0'`), `auto-prune.ts` spawns a detached `prune-runs` sweep guarded by `<stateDir>/.archive/sweep.lock` and logging to `<stateDir>/.archive/sweep.log`.
