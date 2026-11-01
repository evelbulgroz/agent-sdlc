# Intent

## Goal

Ensure consumer verification executes against compiled workspace dependencies built from the current candidate source, not merely against artifacts that exist in a hydrated worktree. Separate dependency installation caching from deterministic build preparation immediately before verification, and bind the preparation policy to operator authorization and the selected build plan to the frozen task plan.

The immediate user is an operator running sequential shared-package changes followed by consumer tasks. The concrete blocked delivery is fitness-app's Entity identity/date-isolation migration, run `2026-11-01-sdlc-75463593`, paused at SPEC_APPROVED before authorization. Its consumers import compiled ddd-base and fitnessapp-base entrypoints; a passing consumer test against stale compiled dependencies cannot establish that the accepted upstream change works.

Current source evidence: workflow/hydration.ts fingerprints lockfile and selected manifests and returns CACHED before running hydration steps when that fingerprint matches; hydration-steps.ts conditionalBuilds skip on file existence. execution/task-worktree-preparation.ts and workflow/nodes/workspace.ts hydrate worktrees. execution/task-verification-plan.ts appends the changed package's own build after its verification command, but no general upstream build-preparation gate exists. Final verification runs through review/verifier.ts (host/verify-runner.ts) from workflow/preflight-gate.ts and again from workflow/nodes/commit.ts (committed-tree verification).

This is a demonstrated structural gap, not a reproduced stale-test result; it concerns source-only mutation, resumed/reused worktrees, and upstream artifacts at verification time. The narrowest wedge is an explicit, optional host-declared prerequisite-build plan that always executes when applicable before consumer verification. Retain installation caching, add preparation evidence, and require reauthorization when the approved preparation policy changes. Prefer unconditional rebuilding over source-aware build caching in this slice.

## Non-goals

- Do not implement source-aware build caching, remote caching, incremental build scheduling, or a generalized build system.
- Do not reinstall dependencies on source-only changes.
- Do not fix Entity, change fitness-app host configuration, resume its paused run, or automatically authorize any existing run.
- Do not redesign task DAG reconciliation, critic routing, model usage accounting, Git delivery, or product verification gates.
- Do not automatically discover/authorize build commands, broaden writable source scope, weaken or extend command policy, or authorize publication/branch/commit/push/PR operations.
- Do not replace existing hydration setup, contract-generation commands, target-package typechecking, acceptance-evidence collection, or final canonical verification.
- Do not add dependencies or mutate test assertions/quality baselines to accommodate the new gate.

## Owning context

agent-sdlc: host configuration, run authorization/planning, persistence of authorization records, and deterministic task/final verification execution. One standalone engine package, not a fitness-app task.

## Touched surfaces

- host/host-profile.ts
- host/verification-preparation-schema.ts (new)
- host/verification-preparation.ts (new)
- host/verification-preparation.spec.mjs
- host/command-policy.ts
- host/hydration.spec.mjs
- policy/authorization.ts
- policy/authorization.spec.mjs
- policy/contracts/run-authorization-schema.ts
- policy/contracts/run-authorization-schema.spec.mjs
- persistence/generation-records.ts
- persistence/store-integrity.ts
- persistence/store-migrations.ts
- workflow/hydration.ts
- workflow/hydration.spec.mjs
- workflow/nodes/authorization.ts
- workflow/nodes/planning.ts
- workflow/nodes/workspace.ts
- workflow/nodes/reconcile.ts
- workflow/nodes/commit.ts
- workflow/preflight-gate.ts
- review/verifier.ts
- execution/verification-preparation.ts (new)
- execution/verification-preparation.spec.mjs
- execution/minimal-verification.ts
- execution/minimal-executor.ts
- execution/tool-commands.ts
- execution/tools.ts
- execution/task-executor.ts
- cli/status-preparation.ts (new)
- cli/status-projection.ts
- host/README.md, workflow/README.md, execution/README.md, policy/README.md, persistence/README.md

## Invariants and constraints

- HOLD SCOPE: installation-cache semantics, authorization-bound prerequisite builds, verification ordering, evidence, failure/resume behavior, and directly dependent schemas/persistence/tests/docs only.
- Before implementation, inspect target-repository guidance and decompose this draft into bounded sequential tasks. Confirm whether execution/task-quality-gate.ts runs consumer verification; if so, stop for approval. New modules above are planned collaborators, not existing APIs.
- Sizing: host-profile.ts, status-projection.ts and task-executor.ts are near the 500-line/20,480-byte ceilings. New schema, validation, selection, execution and projection logic lives in the new modules; these three files receive imports and call sites only. If a call site does not fit task-executor.ts, the first task extracts an existing concern from it without behavior change.
- Introduce an optional host section verificationPreparation with a closed builds list. Each record has id, targetPackages, packagePath, argv, outputPathPrefixes, dependsOn: targetPackages are exact task target-package paths; packagePath is the workspace package built; argv is an explicit array; outputPathPrefixes are generated outputs relative to that package; dependsOn references build ids.
- Reject duplicate ids, unresolved or cyclic dependencies, empty argv/targets/outputs, non-workspace package paths, path traversal, absolute output paths, and argv not accepted by the existing resolveCommandPolicy (`pnpm --filter <pkg> <allowed verb>` or an exact repositoryScripts entry) before worktree mutation. Preparation introduces no allowlist of its own.
- Selection: for a task, select matching records and their transitive prerequisites in deterministic topological order, stable id order for independent records. Final integration and committed-tree verification select the union for all delivered tasks. No match means no new commands. If a selected record builds the task's own target package, the existing appended self-build is kept after verification and the preparation build runs before it; both are recorded, neither is silently deduplicated.
- Keep installation fingerprinting restricted to installation inputs; call its cache an installation/hydration cache, not compiled-artifact freshness evidence. The gate sits outside hydrateWorktree's CACHED early return and executes even when node_modules, hydration markers, and declared dist files exist.
- Run selected builds before every targeted/full/acceptance test or typecheck invocation that consumes them, including repair/resume, integration preflight (review/verifier.ts via preflight-gate.ts) and committed-tree verification (commit.ts). Build execution is outside model discretion; preparation commands do not trigger their own gate.
- Model-invoked commands (run_allowlisted_command) are exploratory, never evidence: after validation and before the first such command, run the task's selected builds; before later ones rebuild only when the candidate digest changed. A failure returns non-terminal command output without running the command. Such evidence is marked exploratory and kept out of status.
- Rebuild unconditionally for each applicable verification invocation. Grouping is allowed only when no source mutation or restart can occur between successful preparation and the grouped commands. Never reuse a previous process's success marker to skip a build.
- Each build uses the existing role-command timeout and maxBuffer options in minimal-verification.ts unless a per-record override is separately approved; a timeout is a preparation failure.
- Source writes may not race preparation or verification in the same worktree. Evidence binds to the current worktree/task/candidate revision; a detected intervening mutation invalidates it and requires fresh preparation before verification can count.
- Two-stage binding, because authorization precedes planning (prepare_authorization → plan_tasks → plan critic → prepare_workspace): (1) authorization binds a preparationPolicyHash over the normalized full verificationPreparation section (all records, argv, package/output scope, dependsOn), folded into approvedPlanPolicyHash; (2) plan_tasks derives per-task and final selections and ordering from that policy and freezes their digest as runtime-state preparationSelectionHash in the same transition (taskPlanHash stays equal to the stored plan hash, which HITL and reliability records rely on). Validate the effective worktree policy against (1) and recomputed selections against (2) before execution and on resume; never execute a changed policy or selection under an old binding.
- Folding into approvedPlanPolicyHash changes plan-critic attempt keys (review/critic-budget.ts planAttemptKey) for runs with preparation. Acceptable for new runs; a resumed run whose recomputed hash differs stops for reauthorization rather than reusing critic budget under a different key.
- Bindings are mandatory when the host declares a nonempty verificationPreparation. Hosts without it keep their behavior, and their approvedPlanPolicyHash input is unchanged (hash field omitted, not null-hashed), so existing envelopes still validate. Legacy authorization without a binding is acceptable only when no preparation is declared; otherwise stop for explicit reauthorization.
- Persist the binding: add a nullable column to run_authorizations via a new versioned step in persistence/store-migrations.ts, read/write it in generation-records.ts, and include it in store-integrity.ts checks. Never rewrite past rows or evidence.
- Build outputs are generated-artifact permissions, not permission to edit dependency source. Preparation runs only in isolated execution/integration worktrees, never the operator checkout. Allow declared outputs and documented build housekeeping; enforce authored-source containment and refuse undeclared source modifications.
- The run may grant execution for declared preparation packages without adding them to model-authored source scope. Reject permission mismatches rather than broadening a command or write allowlist.
- Record durable preparation evidence: preparation policy hash, selection hash, run/task/worktree identity, candidate binding, ordered argv, exit status, timestamps. Verify declared outputs exist after success; existence is a postcondition, not freshness evidence. No secrets or unrestricted environment data in evidence.
- Candidate bindings exclude generated outputs and installation artifacts, so permitted dist writes do not invalidate their own evidence. computeWorktreeDigest currently covers task scope paths only; the preparation binding must additionally cover source/config inputs of selected prerequisite packages without changing the digest existing callers receive. Check containment against the pre-build snapshot: existing authorized edits are not violations; new undeclared source changes caused by preparation are.
- If any prerequisite fails, times out, is interrupted, violates containment, or lacks required output, stop that verification invocation before consumer commands. Failed/skipped preparation cannot produce passing task evidence or canonical completion. Preserve diagnostics and existing repair/continuation limits.
- Host configuration is read from the actual execution worktree and compared with the approved binding. An uncommitted change in another checkout does not satisfy the prerequisite; document how an operator stages a separately approved host-policy update before authorizing a dependent run.
- Keep native type stripping, explicit .ts imports, and the existing error taxonomy.

## Public contract impact

Additive opt-in host section verificationPreparation and explicit generated-build output permissions. Run authorization gains an optional preparationPolicyHash; runtime state gains an optional frozen preparationSelectionHash. Status/evidence projections expose preparation success/failure and provenance via existing persistence. No new raw start/authorize/resume path: the operator shell remains the lifecycle boundary. Hosts without the section keep existing verification behavior and are not newly promised build freshness.

For fitness-app, a subsequent separately approved host update must declare ordered ddd-base and fitnessapp-base builds for relevant targets and their dist outputs. Existing Entity-run approval does not authorize that change. Resume/authorize must establish a compatible binding through the operator path or stop for reauthorization; never silently rewrite the approved spec or base commit.

## Acceptance criteria

1. AC-01: Preparation configuration produces a bounded deterministic build plan. Given a host declaring build-base and build-consumer where build-consumer depends on build-base and only the consumer target selects them. Then the engine selects and validates the dependency closure and outputs base-before-consumer argv and artifact scopes before execution. Cases: AC-01.1: matching target selects ordered dependency closure; AC-01.2: unrelated target selects no builds; AC-01.3: duplicate ids or unresolved dependencies are rejected; AC-01.4: cycles are rejected; AC-01.5: traversal or output scope escaping package is rejected; AC-01.6: argv rejected by resolveCommandPolicy is rejected.
2. AC-02: Authorization and plan freeze bind the preparation policy and selection without widening authored-source scope. Given a run whose host declares two workspace build records and a compatible envelope. Then only those commands and outputs can be used and any policy or selection change requires reauthorization before execution. Cases: AC-02.1: identical normalized policy validates; AC-02.2: changed argv or output scope fails authorization validation; AC-02.3: changed selection or ordering fails task-plan validation; AC-02.4: legacy envelope with declared preparation fails closed; AC-02.5: no-preparation legacy host and persisted envelope retain behavior and hash; AC-02.6: prerequisite-package source writes remain forbidden; AC-02.7: binding round-trips through run_authorizations persistence and migration.
3. AC-03: Consumer verification observes current compiled upstream behavior despite cached installation. Given an isolated fixture with unchanged manifests/lockfile, an upstream source-only mutation changing exported behavior, and stale dist present. Then required builds run in order before verification and the consumer observes the changed behavior. Cases: AC-03.1: initial consumer task after upstream mutation; AC-03.2: source-only repair before repeated targeted verification; AC-03.3: resumed reused worktree with matching hydration marker; AC-03.4: full declared verification after targeted verification; AC-03.5: acceptance-evidence verification; AC-03.6: reconciled integration preflight verification; AC-03.7: committed-tree verification; AC-03.8: model command rebuilds first and when stale.
4. AC-04: Unsuccessful preparation prevents passing verification evidence. Given an applicable prerequisite that cannot establish its postconditions. Then consumer commands do not run, durable diagnostics identify the failed command, and the verification cannot count as successful. Cases: AC-04.1: nonzero build exit; AC-04.2: timeout; AC-04.3: interruption before completion; AC-04.4: successful exit with missing declared output; AC-04.5: undeclared source modification; AC-04.6: candidate mutation invalidates earlier preparation evidence.
5. AC-05: Preparation evidence is current and installation caching remains independent. Given repeated verification of the same task, a restart, and a host without preparation. Then configured builds rerun with correctly bound ordered evidence while cached installation is reused and unconfigured hosts run no new commands. Cases: AC-05.1: repeated verification records new build evidence without reinstalling; AC-05.2: restart does not skip builds using previous success evidence; AC-05.3: status/evidence identifies policy, selection and candidate binding; AC-05.4: host without preparation keeps previous command behavior; AC-05.5: effective worktree policy differing from approved policy stops before command execution.

## Failure defenses

- Reproduce the stale-artifact scenario with an isolated temporary two-package fixture and real compiled-module import; command-order mocks alone do not prove AC-03, and tests must assert the consumer observes changed upstream behavior.
- Exercise normal, source-mutating repair, restart, full-verification convergence, acceptance evidence, integration preflight and committed-tree paths. A hook wired only into worktree creation is insufficient.
- Reject installation markers and dist existence as preparation-success evidence; a matching installation fingerprint is compatible with stale artifacts by design.
- Keep plans finite and cycle-free, commands argv-based, artifacts/source writes contained. No shell-evaluated compound commands or broad dependency-source permissions.
- Validate policy and selection bindings before commands, including on resume. Never silently use the root checkout's latest policy instead of the approved worktree policy.
- Interrupted builds have no success evidence; resume rebuilds even with partial dist.
- Use unique temporary fixtures with deterministic cleanup; never use operator data or the paused fitness-app run.

## Verification plan

- Before implementation, inspect repository/AGENTS guidance and relevant tests, then create a sequential task manifest of at most three authored paths per task (expect roughly ten tasks): optional task-executor extraction, host schema/validation, selection, authorization binding, persistence migration, plan-freeze binding, execution gate/evidence, task call sites, final/committed verifier call sites, status projection, docs. Approve schema changes and call sites before worktree creation.
- New tests cite @ac AC-NN in titles; each Cases entry has a distinct asserting test citing @case AC-NN.N, with regression coverage in existing hydration, authorization, persistence, task-verification and minimal-verification suites.
- AC-01: host/verification-preparation.spec.mjs, host/hydration.spec.mjs. AC-02: policy/authorization.spec.mjs, policy/contracts/run-authorization-schema.spec.mjs, existing persistence and planning suites.
- AC-03/AC-04: execution/verification-preparation.spec.mjs with a real compiled two-package fixture and controlled failing/interrupted runners; invocation paths in minimal-verification, task-verification-plan, preflight-gate and commit node suites.
- AC-05: workflow/hydration.spec.mjs and preparation/status suites, checking installation calls separately from build calls and evidence separately from artifact presence.
- During implementation, run the smallest Node test selectors for affected .spec.mjs files and pnpm run typecheck after schema/API changes; no new dependencies.
- Done bar: pnpm run build && pnpm run typecheck && pnpm run test:unit && node cli/cli.ts reliability replay.
- No engine run is started while drafting. Validate the draft and manifest through the operator-shell brief/check path before scheduling implementation.
- After acceptance, validate a separately approved fitness-app preparation policy and compatible binding before continuing Entity run 2026-11-01-sdlc-75463593; its pause remains until then.

## Unresolved questions

_None_

## Assumptions

- RUNTIME_SCHEMA_VERSION stays 1.0.0; preparationPolicyHash is optional so persisted envelopes stay valid.
- verificationPreparation is additive under host profile 1.3.0; no version bump.
- Correctness is favored over repeated build cost.
- Explicit host records determine selection; no inference.
- Preparation evidence may reuse the candidate/tree digest mechanism, extended to selected prerequisite inputs, not merely HEAD or manifests.
- Hydration may still do first-pass builds; only the new gate gives the guarantee.
- No other process mutates an execution worktree during preparation/verification.
- Saving this draft approves no implementation, commit, publication, or host-policy change.
