# Implementation progress: authorization-bound verification build preparation

Spec: `authorization-bound-verification-build-preparation.md` (same directory).
Implemented directly (not via the engine). Work in the increments below, in order; each must leave
`pnpm run typecheck` and the touched suites green. Update this file when an increment lands.

## Increments

1. [x] Host schema, validation, selection, hashing
   - `host/verification-preparation-schema.ts`: zod schema, structural checks (duplicate ids, unresolved deps,
     cycles, lexical path shape), `orderPreparationBuilds`, `preparationContainmentPaths`.
   - `host/verification-preparation.ts`: `normalizePreparationPolicy`, `computePreparationPolicyHash`
     (null when no builds), `selectPreparationPlan` (closure + topo order + `selectionHash`),
     `validatePreparationPolicy` (workspace membership + existing `validateCommandAllowlist`).
   - `host/host-profile.ts`: optional `verificationPreparation` under 1.3.0 (rejected on 1.2.0); symlink
     containment of packagePath/outputs. File is at 19,899 bytes: add nothing else here.
   - Tests: `host/verification-preparation.spec.mjs` (AC-01.1–AC-01.6).
2. [x] Authorization binding (`policy/authorization.ts`, `policy/contracts/run-authorization-schema.ts`)
   - Optional `preparationPolicyHash` (RUNTIME_SCHEMA_VERSION stays 1.0.0), present only when the host declares
     builds; folded into `approvedPlanPolicyHash` only then, so other hosts' hashes are unchanged (AC-02.5).
   - `validateAuthorizationEnvelope` → `assertPreparationBinding`: recomputes from the root profile; mismatch or
     missing binding fails closed with AUTHORIZATION_INVALID (AC-02.1/2/4/5). Semantic validation runs on create
     and validate.
   - Tests: `policy/authorization-preparation.spec.mjs` (new file; `authorization.spec.mjs` is at 378 lines).
3. [x] Persistence: STORE_SCHEMA_VERSION 13 → 14 (`policy/contracts/runtime-vocabulary.ts`).
   - `persistence/migrations/upgrades-v14.ts` adds nullable `run_authorizations.preparation_policy_hash`
     (skips a missing table); baseline schema has the column; `generation-records.ts` and
     `store-integrity.ts` read/write it.
   - Existing "current version is 13" assertions updated to 14 (the "too new" probe is now 15) in
     store-migrations, runtime-store, runtime-vocabulary, upgrades-v1-v7 and upgrades-v8-v13 specs.
   - Tests: `persistence/migrations/upgrades-v14.spec.mjs` (AC-02.7).
4. [x] Plan-freeze binding.
   - (Spec amended 2026-11-01, operator-confirmed.) The selection digest is NOT folded into `taskPlanHash`, because HITL plan-critic
     responses (`cli/hitl.ts:409`) and reliability records treat `taskPlanHash` as equal to the stored
     `plan.planPolicyHash`. Instead `plan_tasks` freezes a separate optional runtime-state field
     `preparationSelectionHash` (`policy/contracts/runtime-vocabulary.ts`) in the same TASK_PLAN_GENERATED
     transition. Same guarantee: absent for hosts without preparation.
   - `host/verification-preparation.ts`: `computePreparationSelectionBinding` (per-task + union + digest),
     `freezePreparationSelection` (re-checks the authorized policy hash first; profile from `runtime.rootDir`),
     `assertPreparationSelectionBinding` (for increments 5–7: recompute and fail closed on resume/drift).
   - Tests: `host/verification-preparation-binding.spec.mjs` (AC-02.3), runtime-vocabulary spec.
   - Not yet done: nothing calls `assertPreparationSelectionBinding`; the gate in increment 5 must, using the
     worktree's profile, `snapshot.preparationSelectionHash` and the stored task plan's tasks.
5. [x] Execution gate: `execution/verification-preparation.ts`.
   - `prepareForVerification({ execCli, worktreeDir, runId, taskId, authorizedPolicyHash, frozenSelectionHash,
     planTasks, scope: taskId | 'final', candidateRoots?, recordEvidence?, timeoutMs? })` is THE call-site API:
     loads the profile from the worktree, fails closed (AUTHORIZATION_INVALID) on policy/selection drift, runs the
     task's (or the union's) steps. `ok: false` ⇒ caller must not run consumer commands or count verification.
   - `runVerificationPreparation`: unconditional ordered builds, ROLE_COMMAND_TIMEOUT_MS/COMMAND_MAX_BUFFER_BYTES,
     reasons build-failed | timeout | interrupted | missing-output | source-modified; evidence (policy hash,
     selection hash, candidate digest, ordered argv, exit/signal, timestamps; no env) to `recordEvidence`.
   - Candidate digest covers selected packages + `candidateRoots`, excluding declared outputs, node_modules,
     .git, .agent-sdlc, .tmp and `*.tsbuildinfo`; it is separate from `computeWorktreeDigest` (unchanged).
   - Tests: `execution/verification-preparation.spec.mjs` (AC-03.1/2, AC-04.1–6, AC-05.2–5) with a real
     two-package fixture whose consumer imports the compiled base dist.
6. [x] Task call sites.
   - `runVerification` (`execution/minimal-verification.ts`) calls `input.prepareVerification?.()` before every
     invocation (all verification commands + acceptance evidence are one group: no mutation in between).
     Failure ⇒ `{ ok: false, reason: 'preparation-<reason>', terminal: false, evidence: null }`, no consumer
     command runs; the normal MINIMAL_MAX_ATTEMPTS repair budget applies. Drift throws AUTHORIZATION_INVALID.
   - `task-executor.ts` (now 498 lines; no headroom) builds the hook via `taskPreparationHook` and threads it
     through `executeMinimalTask` → `MinimalExecutorInput.prepareVerification`.
   - Evidence sink: artifact kind `verification-preparation` + new event type `VERIFICATION_PREPARED`
     (payload: taskId, status, evidenceArtifact, hashes, failure) for the status projection.
   - `task-verification-plan.ts` / `task-worktree-preparation.ts` needed no change.
   - Tests: `execution/minimal-verification-preparation.spec.mjs` (AC-03.2–5, AC-04.1, AC-05.3); shared fixture
     `testing/verification-preparation-fixture.mjs` (async-safe cleanup).
   - Model-invoked commands: resolved in increment 11.
7. [x] Final call sites.
   - `review/verifier.ts`: optional `prepare` on `executePreflightVerifier`/`executeCommittedPreflightVerifier`,
     run inside `runPreflightAndBind` immediately before `runHostVerify` (committed path: after the clean-tree
     and tree-SHA checks). Failure ⇒ FAIL with failedCommand `verification-preparation:<step>:<reason>`.
   - `finalPreparationHook` (scope 'final', taskId 'final', union selection, candidate roots = all tasks'
     pathPrefixes) wired in `workflow/preflight-gate.ts` and `workflow/nodes/commit.ts`.
   - `workflow/nodes/reconcile.ts` needed no change (it hydrates; verification happens in preflight-gate).
   - Tests: `review/verifier-preparation.spec.mjs` (AC-03.6, AC-03.7, AC-04.1 at final scope).
8. [x] Hydration independence regression: AC-05.1 test appended to `workflow/hydration.spec.mjs` (CACHED
   installation reused, both prerequisite builds re-run each time, fresh evidence per invocation).
9. [x] Status projection: `cli/status-preparation.ts` derives `verification.preparation` ({ policyHash,
   selectionHash, latest per task/final }) from VERIFICATION_PREPARED events; omitted for runs without preparation.
   `cli/status-document.ts` takes optional `preparation`; `cli/status-projection.ts` wiring (19,846 bytes).
   Tests: `cli/status-preparation.spec.mjs` (AC-05.3, AC-05.4).
10. [x] Docs: host (schema + operator staging of policy changes), workflow (hydration cache ≠ freshness; plan-freeze
    binding; final verification), execution (gate), policy (envelope field), persistence (schema 14) READMEs.
    Done bar (2026-11-01): build ✓, typecheck ✓, test:unit 1321 pass / 1 fail (pre-existing host-neutrality on
    `docs/backlog.md:7`) / 1 skipped, reliability replay PASSED 20/20.

11. [x] Exploratory preparation for model-invoked commands (operator-approved; spec amended, AC-03.8).
    - `exploratoryPreparationGuard` / `taskPreparationHooks` (`execution/verification-preparation.ts`): builds before
      the first `run_allowlisted_command`, then only when `isPreparationEvidenceCurrent` is false. Lazy rather than
      at task start: same effect for commands, no build if the model never runs one. (The model could still
      `read_file` a stale `dist/` before its first command.)
    - Plumbing: `task-executor.ts` passes `preparation: taskPreparationHooks(...)` (still 498 lines) →
      `MinimalExecutorInput.prepareExploratory` → `executeTool({ prepareCommand })` → `runCommandTool({ prepare })`,
      which runs it after allowlist validation; failure ⇒ exitCode 1 output, command not run, non-terminal.
      Policy drift throws inside the tool and reaches the model as a tool error; the counted gate still fails closed.
    - Evidence gains `purpose: 'verification' | 'exploratory'`; the status projection skips exploratory events.
    - Tests: `execution/exploratory-preparation.spec.mjs`, `cli/status-preparation.spec.mjs` (AC-03.8).

## Remaining before acceptance

- Increment 4 design (separate frozen `preparationSelectionHash`) confirmed by the operator; spec amended.
- Nothing is committed. The fitness-app host policy and the paused Entity run are untouched.

## Notes for whoever continues

- `host/verification-preparation.ts` imports `execution/tool-commands.ts`; `host-profile.ts` must only import the
  `-schema` module to avoid an import cycle.
- Preparation packages are granted execution only; never add them to `allowedPackages`/`allowedPathPrefixes`.
- Per-file ceilings: 500 lines and 20,480 bytes.
- Pre-existing, unrelated: `testing/host-neutrality.spec.mjs` fails on `docs/backlog.md:7` (from commit 8d7ffcb).
