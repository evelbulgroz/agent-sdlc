# Roles, Workflows, Cognitive Tiering & Compounding Memory (`roles/`)

Canonical workflow manifests, role and capability registries, built-in `roles/defaults/` fallback resolution, semantic cognitive routing parameters, upstream institutional memory recall, and closed-loop trace-driven prompt/skill learning (`scripts/`).

## Key Files & Entrypoints

- `roles/role-registry.ts` & `roles/role-executor.ts` — Workflow and role definition loader (`RoleRegistry`), built-in `roles/defaults/` fallback resolution, 3-layer prompt assembly (`roles/defaults/protocol/` + `roles/defaults/philosophy/` + optional `.agents/workflows/prompts/`), semantic routing tiering, and governed role execution.
- `roles/defaults/` — Built-in workflow manifest (`specification.json`), built-in role JSONs (`roles/specifier.json`, `roles/implementer.json`, `roles/reviewer.json`, `roles/critic-reviewer.json`), Layer 1 protocol prompts (`protocol/<roleId>.md`), and Layer 2 default engineering philosophy (`philosophy/<roleId>.md`).
- `roles/capability-registry.ts` — Role capabilities (`roles/capabilities/*`, including the `lean-tool-loop-v1` capability marker).
- `review/evaluator-registry.ts` — Role output validators and status evaluators mapped by `evaluatorId`.
- `roles/upstream-recall.ts` — High-confidence, scope- and role-matched learning recall prior to model dispatch.
- `scripts/trace-skill-auditor.ts` — On-demand governed semantic friction attribution (`agent-sdlc skills --run <run-id>`).
- `scripts/aggregate-critic-trends.ts` & `scripts/critic-trends-sources.ts` — Multi-run finding aggregation and 3-run ratchet graduation (`agent-sdlc-trends`).
- `scripts/trace-summary.ts` — Run trace and failure-fingerprint summarizer (`agent-sdlc-trace`).

## Workflow Manifests, Role Definitions & Override Resolution

New client repositories do not need workflow or role JSON files in `.agents/workflows/`. `RoleRegistry` (`roles/role-registry.ts`) resolves the default workflow manifest (`specification.json`) and built-in role definitions (`specifier`, `implementer`, `reviewer`, `critic-reviewer`) from `roles/defaults/` as the built-in source of truth, with optional per-file host overrides or additional pipeline roles in `.agents/workflows/*.json` and `.agents/workflows/roles/*.json` when present:

1. **Workflow Manifest (`specification.json`):**
   - `roles`: Allowlisted built-in role IDs in the default workflow (`specifier`, `implementer`, `reviewer`, `critic-reviewer`), extensible via `.agents/workflows/*.json`.
   - `pipelines`: Optional hook insertion points executed sequentially (`post_implement` in each task worktree, `pre_review` on the integrated tree, and `review` for semantic/critic review) when configured in a host workflow manifest.
   - `limits`: Global caps on interview rounds, batch questions, model operations, goal bytes, and artifact bytes.
2. **Role Definitions (`roles/<roleId>.json`):**
   - Bind `roleKind` (`mutation`, `analysis`, `review`), `capabilityId` (`roles/capability-registry.ts`), `evaluatorId` (`review/evaluator-registry.ts`), `modelProfile`, `promptFile`, and `requestedLimits`.
   - Optional deterministic pipeline roles configured by a host use `modelProfile: "agent-sdlc-deterministic"` with `0` prompt and completion token limits.
   - Role prompts resolve across `roles/defaults/protocol/<promptFile>`, `roles/defaults/philosophy/<promptFile>`, and optional host addenda in `prompts.roleAddendaDir` (default `.agents/workflows/prompts/<promptFile>`; see [`../prompts/README.md`](../prompts/README.md)).
3. **Security & Non-Executable Invariants (`role-registry.ts`):**
   - `rejectExecutableConfiguration()` rejects workflow or role JSONs declaring `command`, `commands`, `executable`, `script`, `shell`, `tool`, `tools`, `provider`, `apiKey`, `credential`, `transition`, or `approval`.
   - `rejectExecutablePrompt()` scans every prompt and addendum layer and throws `INVALID_CONTRACT` if any markdown contains executable code fences, child process calls, `curl`, `git commit/push`, or `rm -rf`.

## Core Invariants

1. **Semantic Cognitive Tiering (`role-registry.ts`, `role-executor.ts`):**
   - Roles declare semantic routing parameters (`routingStrategy`, `minQualityTier`, `phaseStrategies`, `phaseMinQualityTiers`) rather than hardcoded vendor or model IDs.
   - Reliability-first calibration sets `minQualityTier: 3` across active Agent SDLC profiles (`specifier`, `implementer`, `reviewer`, `critic-reviewer`, and `trace-attribution`).

2. **Compounding Institutional Memory (`upstream-recall.ts`):**
   - Before model dispatch, executors recall at most 3 high-confidence learnings matching the active package scope and role.
   - Candidate learnings from runs are staged in `runtime.sqlite` and projected to `<runsRoot>/<run-id>/candidate-learnings.json` (co-located inside `<stateDir>/<run-id>/` when `runsDir` is omitted).

3. **Closed-Loop Trace-Driven Skill Learning (`trace-skill-auditor.ts`, `aggregate-critic-trends.ts`):**
   - **Zero-token friction detection:** On transition to `READY_FOR_GIT_APPROVAL` or `DONE`, `finish-run.ts` checks `runtime.sqlite` for non-zero tool exits or QA critic `GAP`/`DIVERGENT` findings and records `PROMPT_FRICTION_DETECTED` without spending tokens.
   - **On-demand attribution (`agent-sdlc skills --run <run-id>`):** Runs outside the state graph under profile `trace-attribution`, classifying root causes via the **Ratchet Pattern** (`layer1` deterministic tooling/gates > `layer5` repo pitfalls > `layer3` role prompts) under closed key grammar `^[role] signal:category$` and syncing to `.agents/trace-findings/<run-id>.json`.
   - **3-Run Anti-Overfitting Floor & Ratchet Merge:** A finding reaches `RECOMMENDED` only after recurring in $\ge 3$ distinct runs, and resolves to `layer3` only if 100% of occurrences across runs attributed it to `layer3`.
   - **HITL Diff Application (`agent-sdlc skills --apply --key <key>`):** Verifies `RECOMMENDED` + `layer3` status (failing closed with `POLICY_VIOLATION` exit `70` otherwise), renders a unified diff against `.agents/workflows/prompts/<role>.md`, and records applied keys in `.agents/applied-skills.json`.
