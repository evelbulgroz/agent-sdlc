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
- `host/evidence-port.ts` — Framework-neutral `executeEvidence(request, registration, context, spawn, store, callbacks?)` host-command boundary; `host/evidence-types.ts` defines injected collaborators, and `host/evidence-store.ts` adapts `runtimeStore.quality` lifecycle and budget transactions.

## Approved command evidence API

`executeEvidence` accepts the versioned contracts from `policy/contracts/quality-schema.ts`.
The engine supplies an authorized worktree registry id, target package, exact command
allowlist, frozen adapter binding hash, fresh absolute operation-artifact directory,
and `observeSource()` returning the actual Git tree, complete source digest, and
preparation hash. Source observation must include unauthorized untracked source;
exclude only explicitly approved generated outputs. Runtime environment inputs are
explicitly supplied through `context.environment`, never inherited.

`host/evidence-source.ts` provides `createEvidenceSourceObserver({worktreeDir,
sourceTreeSha, generatedOutputs, preparation, gitCli?})`. Its private Git index
captures tracked and all nonignored untracked regular-file bytes and executable
modes without touching the actual index or running host clean filters. Only exact
declared generated files/directory prefixes are excluded; their baseline tree
entries remain frozen. Use the initial observation's `treeSha` and `sourceHash`
when binding the request, rather than a delta tree containing mutable outputs.
Preparation is independently hashed from the frozen baseline/output declaration,
`preparation.configuration` (hydration, runtime version, environment), and the
verified byte hashes of `preparation.files`. Changed preparation inputs fail closed.
Evidence runs through the bounded command runner; synchronous `execCli` is for Git and preparation only.

The injected spawn receives exact argv with `shell: false`, one JSON stdin request,
and bounded stdout/stderr. The host returns exactly one JSON report; opaque unit or
browser raw reports belong in bounded, regular, non-symlink artifacts. The engine
verifies byte hashes for bundle/dependency/configuration inputs before and after
execution, exact case/file/obligation mappings, capability qualification, clean
attempt histories, report/artifact limits, and unchanged source/preparation.
Exit status or stderr alone is never acceptance evidence.
Set `context.executionDurationCeilingMs` to the remaining persisted execution-duration
budget. It must be a positive safe integer and can only narrow the frozen adapter
timeout; exhausted or malformed ceilings reject before reservation or spawn.

Create the persistence collaborator with `createEvidenceRecordStore(runtimeStore, request)`.
It reserves the execution budget and invocation atomically before spawn, then
atomically charges duration and publishes the invocation, engine-created receipt,
report and source observations. The caller initializes the finite policy budget
and registers the worktree with its matching candidate binding hash first.
Persistence failures propagate; missing completion cannot pass. Completed
matching successful operations reuse their durable receipt without respawning,
after current source, frozen inputs and artifacts are rechecked. Conflicting ids,
unfinished operations, and failed receipts cannot be replayed as success; any
authorized infrastructure retry needs a fresh charged operation with `retryOf`.

Task, slice and final callers retain checkpoint scheduling and QA responsibility:
only a `passed` receipt discharges the requested obligations. This API provides no
host adapter discovery, framework parsing, preparation bypass, or execution approval.
Offline qualification shapes are exercised in `host/evidence-port.spec.mjs`; no
real host adapters or browser dependencies are installed by the engine.

## Core Invariants

1. **Boundary-Governed Minimal Executor (`minimal-executor.ts`):**
   - `minimal` is the only valid executor (`--executor minimal` or `AGENT_SDLC_EXECUTOR=minimal`; omitting both defaults to `minimal`, while `controlled` or any other value fails closed with `INVALID_INPUT` before run creation).
   - Follows *"Loose in the Middle, Tight at the Boundaries"*: the model receives discrete tool schemas and raw secret-redacted `stdout`/`stderr` diagnostics without regex error interceptors or synthetic micro-turn state machines.
   - Maintains a compact working-set prompt (collapsing superseded `read_file` outputs and summarizing authored file hashes), preserves `toolCalls` across outer verification attempts, and requests an informational `AUDIT_REQUIRED` self-audit after verification and acceptance-evidence checks pass.
   - Missing authored files, failed verification, and failed acceptance/checkpoint evidence share the initial attempt plus at most two autonomous repair attempts. An `auditRequired` result cannot bypass that allowance. Human-approved corrections use their explicit one- or two-iteration cap instead; a clean, unchanged self-audit consumes no repair attempt and never replenishes either allowance.
   - Calls `governor.assertCanReserve` prior to each model dispatch. Honours `AGENT_SDLC_PREFERRED_ROUTES` and `AGENT_SDLC_MAX_ROUTE_FAILOVERS=0`.

2. **Strict Read/Write Path Containment (`tools.ts`, `tool-path-guards.ts`):**
   - Package tasks may read within `targetPackage` for local patterns, but mutations (`write_file`, `replace_in_file`, `replace_snapshot_range`, `delete_file`) are strictly confined to the task's exact authored paths under `allowedPathPrefixes` with `realpath` traversal defenses.
   - Model tools cannot edit `pnpm-lock.yaml` directly; declared dependency mutations must edit the authorized `package.json`, after which `task-executor.ts` (`checkAndRefreshManifest`) refreshes and stages `pnpm-lock.yaml`.
   - When an authored test file is identified, an allowlisted targeted test command runs as a mandatory intermediate gate before the full declared task verification command.

3. **Execution-Backed Acceptance Criteria & Human Intent Oracles (`ac-coverage.ts`):**
   - Every frozen `AC-NN` (and `Cases: AC-NN.1; AC-NN.2` sub-oracle) must be cited by an asserting test (`@ac AC-NN` on the test or enclosing `describe(...)`, plus `@case AC-NN.N` for cases, including `it.each` / `test.each` rows) that executes and passes in machine-readable JSON or TAP test runner output after the latest mutation. JSON reporters that name test files scope matching to the cited file (absolute reporter paths match worktree-relative citations on a path-segment boundary); TAP does not name files for passing tests, so it matches by title only and the bound report records `executionEvidenceMatching: 'title'`.
   - **Human-Owned Intent Oracles (`*.oracle.spec.ts(x)`):** Pre-existing oracle files in `baseCommitSha` and oracles frozen on `oracleSnapshot` after implementation are immutable; any edit or deletion escalates immediately with 0 autonomous repairs (`isOraclePath`).

4. **Verification Preparation Gate (`verification-preparation.ts`):**
   - `runVerification` calls the task's preparation hook before every verification invocation (declared commands and acceptance evidence form one group). The hook reads the host profile from the execution worktree, fails closed with `AUTHORIZATION_INVALID` when it differs from the authorized policy or the frozen selection, and runs the selected builds unconditionally with the role-command timeout.
   - Build failure, timeout, interruption, a missing declared output, or an undeclared source change stops verification before any consumer command (`reason: preparation-<reason>`) and counts as a failed attempt under the normal repair budget.
   - Evidence (policy and selection hashes, candidate source digest, ordered argv, exit status/signal, timestamps; no environment data) is written as a `verification-preparation` artifact plus a `VERIFICATION_PREPARED` event, and surfaces in `status.json` under `verification.preparation`. The candidate digest excludes declared outputs, so permitted `dist` writes do not invalidate it, and any later source change does.
   - Model-invoked `run_allowlisted_command` calls are exploratory: after allowlist validation, the task's builds run before the first such command and again only when the candidate digest changed (`exploratoryPreparationGuard`). A failed build is returned to the model as ordinary command output (the command does not run). These records carry `purpose: 'exploratory'`, are excluded from `status.json`, and never count as evidence.

5. **Failure Traces (`non-progress-trace`):**
   - Terminal implementer failures write a redacted `non-progress-trace` artifact (up to 256 KiB) referenced at `error.metadata.traceArtifact`, capturing `failureClass`, `runCounters`, `wasteSummary`, `failureFingerprint`, and per-step actions, schema restrictions, and diagnostics.
   - Inspect traces via `agent-sdlc-trace --run <run-id> [--json]` or `--fingerprints [--json]`.
