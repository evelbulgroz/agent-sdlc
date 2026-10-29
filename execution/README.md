# Task Execution & Acceptance Coverage (`execution/`)

Inner-loop implementer execution (`--executor minimal`), allowlisted workspace tools, path containment guards, execution-backed acceptance-criteria (`@ac`) coverage, and failure trace capture.

## Key Files & Entrypoints

- `execution/minimal-executor.ts` — The sole implementer executor (`GovernedWorkingSetWorker`: capped at 150 calls, 60 minutes, and 3 verification attempts).
- `execution/minimal-prompt.ts` & `execution/minimal-verification.ts` — Compact working-set prompt assembly, two-call `AUDIT_REQUIRED` completion gate, and post-done verification runner.
- `execution/task-executor.ts` — Task-level orchestration inside isolated worktrees (`task-worktree-preparation.ts`, `task-verification-plan.ts`, `task-acceptance-evidence.ts`, `task-quality-gate.ts`, `task-tree-delta.ts`, `task-scope.ts`).
- `execution/tools.ts` — Allowlisted tool dispatcher (`tool-read.ts`, `tool-search.ts`, `tool-mutations.ts`, `tool-commands.ts`, `tool-path-guards.ts`, `read-window.ts`).
- `execution/ac-coverage.ts` — Deterministic `@ac AC-NN` and `@case AC-NN.N` test citation and execution-evidence verifier (`ac-citations.ts`, `ac-worktree-coverage.ts`, `ac-author-feedback.ts`, `test-execution-evidence.ts`, `coverage-advisory.ts`).
- `execution/pipeline-executor.ts` & `execution/pipeline-deterministic-roles.ts` — Post-implement (`cleaner`, `hardener`) and pre-review (`architect`) role pipeline runner.
- `execution/local-api-signals.ts` — Repository-local API misuse guards and diagnostic emitters.

## Core Invariants

1. **Boundary-Governed Minimal Executor (`minimal-executor.ts`):**
   - `minimal` is the only valid executor (`--executor minimal` or `AGENT_SDLC_EXECUTOR=minimal`; omitting both defaults to `minimal`, while `controlled` or any other value fails closed with `INVALID_INPUT` before run creation).
   - Follows *"Loose in the Middle, Tight at the Boundaries"*: the model receives discrete tool schemas and raw secret-redacted `stdout`/`stderr` diagnostics without regex error interceptors or synthetic micro-turn state machines.
   - Maintains a compact working-set prompt (collapsing superseded `read_file` outputs and summarizing authored file hashes), preserves `toolCalls` across outer verification attempts, and enforces a two-call `AUDIT_REQUIRED` completion gate before running task verification, acceptance-evidence checks, and authored-path diff validation.
   - Calls `governor.assertCanReserve` prior to each model dispatch. Honours `AGENT_SDLC_PREFERRED_ROUTES` and `AGENT_SDLC_MAX_ROUTE_FAILOVERS=0`.

2. **Strict Read/Write Path Containment (`tools.ts`, `tool-path-guards.ts`):**
   - Package tasks may read within `targetPackage` for local patterns, but mutations (`write_file`, `replace_in_file`, `replace_snapshot_range`, `delete_file`) are strictly confined to the task's exact authored paths under `allowedPathPrefixes` with `realpath` traversal defenses.
   - Model tools cannot edit `pnpm-lock.yaml` directly; declared dependency mutations must edit the authorized `package.json`, after which `task-executor.ts` (`checkAndRefreshManifest`) refreshes and stages `pnpm-lock.yaml`.
   - When an authored test file is identified, an allowlisted targeted test command runs as a mandatory intermediate gate before the full declared task verification command.

3. **Execution-Backed Acceptance Criteria & Human Intent Oracles (`ac-coverage.ts`):**
   - Every frozen `AC-NN` (and `Cases: AC-NN.1; AC-NN.2` sub-oracle) must be cited by an asserting test (`@ac AC-NN` on the test or enclosing `describe(...)`, plus `@case AC-NN.N` for cases, including `it.each` / `test.each` rows) that executes and passes in machine-readable JSON or TAP test runner output after the latest mutation.
   - **Human-Owned Intent Oracles (`*.oracle.spec.ts(x)`):** Pre-existing oracle files in `baseCommitSha` and oracles frozen on `oracleSnapshot` after implementation are immutable; any edit or deletion escalates immediately with 0 autonomous repairs (`isOraclePath`).

4. **Failure Traces (`non-progress-trace`):**
   - Terminal implementer failures write a redacted `non-progress-trace` artifact (up to 256 KiB) referenced at `error.metadata.traceArtifact`, capturing `failureClass`, `runCounters`, `wasteSummary`, `failureFingerprint`, and per-step actions, schema restrictions, and diagnostics.
   - Inspect traces via `agent-sdlc-trace --run <run-id> [--json]` or `--fingerprints [--json]`.
