# Spec: Remove all fitness-app host knowledge; make host metadata host-configured

Status: APPROVED (decisions: top-level `commands` block; clean break, no deprecation window)
Owner context: `@evelbulgroz/agent-sdlc` (standalone engine)

## 1. Goal

The engine must contain no knowledge of the former fitness-app host (its package layout, service names, scripts, security-config handling, quality/preflight commands, or `packages/agent-sdlc` monorepo location). Everything that varies per host is read from the host's `.agents/sdlc-host.json` (schema `1.3.0`, extended additively). With no host profile, the engine falls back to neutral single-package defaults.

The engine repo must validate itself (unit suite, `reliability replay`, hosted canary) using only its own profile and neutral test fixtures.

## 2. Background and current state

Already done (uncommitted): hydration is profile-driven (`workflow/hydration-steps.ts`); this repo's profile has no fitness-app blocks; `pnpm run test:unit` is an accepted unfiltered verification command; `allowedPathRoots` lists this repo's directories; the fitness-app host profile declares `setup:security-config` as a hydration step.

Remaining coupling found by survey:

| # | Area | Evidence (non-spec source) |
|---|------|----------------------------|
| A | Hardcoded command verbs | `execution/tool-commands.ts` (`agent:test-sdlc`, `agent:preflight`, `quality:changed`, `build:contracts`, `check:contract-drift`), `policy/contracts/planning-schema.ts` (`ALLOWED_TASK_VERBS`, `agent:test-sdlc`), `execution/task-verification-plan.ts`, `policy/task-planner/task-readiness.ts:295`, `policy/task-planner/workspace-packages.ts:298` |
| B | Invented fallback workspace | `policy/task-planner/workspace-packages.ts:121-135` fabricates `@example/*` packages when `packageRoots >= 3` and none found |
| C | Monorepo self-location | `packages/agent-sdlc` literals in `policy/canary-planning-files.ts`, `policy/reliability/canary.ts:149`, `policy/reliability/corpus.ts:137`, `cli/auto-prune.ts:96` |
| D | Secret/path exclusions | `security-config` in `review/agent-review.ts:42`, `policy/reversible-decisions.ts:46`, `adapters/github-pr.ts:261` |
| E | Preflight/handbook literals | `policy/reversible-decisions.ts:90-126` (`tools/agent-preflight.sh`, `docs/handbook/*`), `review/critic-input-packing.ts` done-bar wording |
| F | Hardcoded state dir | `tools/.agent-sdlc` in `persistence/run-paths.ts:79`, `execution/task-tree-delta.ts:123`, `cli/resume.ts:324`, `cli/shell-driver.ts:369`, `cli/human-result.ts:297`, `scripts/trace-skill-auditor.ts:113` (profile already has `stateDir`) |
| G | Prompt/rubric/docs | `.agents/workflows/prompts/{implementer,reviewer,specifier}.md`, `.agents/review-rubrics/{code,spec}.md`, `.agents/workflows/scoped/*.md`, `cli/commands/candidate-learning.ts:31` (example scopes), READMEs, `ARCHITECTURE.md` |
| H | Tests and fixtures | ~144 `*.spec.mjs`/fixture files carry fitness-app literals; 73 tests currently fail because they treat this repo's profile as the fitness-app profile |

## 3. Design

### 3.1 Host-config additions (additive, schema `1.3.0` optional fields)

- `verify.argv` (exists): the single repository-level verification command. Replaces `agent:preflight`/`agent:test-sdlc` as a special case.
- `commandPolicy.allowedVerbs?: string[]`, `commandPolicy.repositoryScripts?: string[][]` and `commandPolicy.contractGateScripts?: string[][]` (named `commandPolicy` because `commands` is already the script adapter's argv list) (exact unfiltered `pnpm run ...` argv lists). Defaults: verbs `test, build, lint, typecheck, build:contracts, check:contract-drift` (the contract verbs move out with Slice 2's contract-producer cleanup); unfiltered scripts: `pnpm run test:unit` and the profile's `verify.argv` only.
- `workspace.repositoryScopes?: string[]` (paths mapped to the repository scope instead of a package; today hardcoded `docs`, `.agents`, `tools`).
- `policy.secretPaths?: string[]` (path prefixes and suffix globs excluded from review/PR; default `.env*` only).
- `policy.reversibleDecisions?: {...}` overrides (classification command, style/testing doc pointers); defaults neutral wording with no file paths.
- `engine.selfRoot?: string` (relative dir containing the engine when it is vendored; default `.`). Replaces `packages/agent-sdlc` probes.
- `stateDir` is the only source of state paths (no `tools/.agent-sdlc` literal in engine code; neutral default `.agent-sdlc`).
- `prompts.exampleScopes` removed in favour of `learnings.scopes` (exists).

### 3.2 Neutral defaults

No profile or empty blocks: single-package repo rooted at `.`, verify `["npm","test"]`, no hydration beyond install, no high-risk paths, no secrets beyond `.env*`.

### 3.3 Host migration

Each host adds only the blocks it needs. The fitness-app profile gains `commands`, `workspace.repositoryScopes`, `policy.secretPaths: ["security-config", "*.security.config.ts"]`, and keeps its `verify`, `hydration`, `policy`, `architecture`. A `host check` warning (not error) lists engine-deprecated fields that are now ignored.

## 4. Slicing plan

Each slice is independently mergeable, leaves `pnpm run build && pnpm run typecheck && pnpm run test:unit && node cli/cli.ts reliability replay` green, and stays within the 500-line / 20,480-byte file ceilings (new modules instead of growing near-limit files such as `workflow/hydration.ts`, 13 KB).

### Slice 0: Test isolation harness (prerequisite, unblocks all others)
- Add `testing/host-root-fixtures.mjs`: builds a temp host root (git-initialised) with a caller-supplied profile and optional file tree; replaces use of `REPOSITORY_ROOT`'s profile in specs.
- Add a neutral `testing/fixture-monorepo/` profile (generic names: `app-a`, `lib-core`) as the replacement for fitness-app literals.
- Migrate the 73 currently failing specs, in batches by directory (`policy/task-planner`, `workflow/graph*`, `execution/task-executor*`, `cli/*`, `review/*`, `roles/*`), to the harness. Rename literals mechanically (`apps/services/conditioning` -> `fixture-monorepo` paths); do not weaken assertions.
- Done when: full unit suite passes with this repo's clean profile. Test: no spec reads fitness-app names (see Slice 8 guard).

### Slice 1: Command policy from config (A)
- New `host/command-policy.ts` additions: resolve allowed verbs and repository scripts from `commandPolicy.*`, defaulting to `verify.argv`.
- Remove `agent:*` and `quality:changed` literals from `tool-commands.ts`, `planning-schema.ts`, `task-verification-plan.ts`, `task-readiness.ts`, `workspace-packages.ts`.
- Task-plan validation takes the resolved policy as a parameter.
- Tests: boundary cases (unknown verb rejected; configured script accepted; shell metacharacters still rejected; `--filter` containment unchanged; default profile accepts only `verify.argv`).

### Slice 2: Remove fabricated workspace (B) — DONE
- Delete the `fallbackPkgs` block; empty discovery yields an empty package map and a typed `TASK_PLAN_INVALID` pointing at `workspace.*`.
- `workspace.repositoryScopes` replaces hardcoded `docs/.agents/tools`.
- Tests: no-packages repo plans repository-scope tasks only; touched surface outside scopes fails closed.

### Slice 3: Engine self-location (C)
- Introduce `engine.selfRoot` (default `.`); update canary planning-file listing, canary hash bindings, reliability corpus lookup, auto-prune CLI discovery.
- Canary hashes must remain identical for this repo (add a pinned-hash regression test before the change, assert equal after).
- Tests: engine at `.` and engine vendored at `vendor/agent-sdlc` produce the same relative file list.

### Slice 4: Secret and path policy (D)
- `policy.secretPaths` drives `isSecretOrExcludedPath`, reversible-decision secret detection, and the PR template checkbox text (template uses the configured paths or omits the line).
- Tests: default excludes `.env*` only; configured paths excluded from review excerpts and PR body; no path mentioning `security-config` remains in engine source.

### Slice 5: State directory from profile only (F)
- Route all `tools/.agent-sdlc` literals through `resolveStateDir(rootDir)`; neutral default `.agent-sdlc`; update human-readable messages.
- Compatibility note: hosts that relied on the default must set `stateDir` (this repo and fitness-app already do).
- Tests: custom `stateDir` honoured by shell scratch dirs, resume worktree paths, PR-body message, trace auditor.

### Slice 6: Reversible-decision and preflight wording (E)
- Move preflight/handbook references into `policy.reversibleDecisions`; defaults reference only the profile's `verify.argv`.
- Critic done-bar text is composed from `verify.argv` (partially done).
- Tests: default decision text contains no file paths; override applied.

### Slice 7: Prompts, rubrics, scoped addenda, docs (G)
- Delete `.agents/workflows/scoped/{backend-services,frontend-pwa}.md`; strip handbook/frontend references from engine prompts and rubrics; replace `candidate-learning` example scopes with profile scopes.
- Update READMEs, `ARCHITECTURE.md`, `host/README.md` (new fields, migration table), and `docs/operator-shell-and-authorization.md`.
- Tests: existing living-docs and `host-docs` specs updated to the new fields; docs-drift check passes.

### Slice 8: Leak guard and canary qualification
- Add `testing/host-neutrality.spec.mjs`: fails if any non-fixture source, prompt, rubric, doc, or profile matches a denylist (`fitness`, `@example/`, `apps/services`, `apps/frontends`, `apps/e2e`, `security-config`, `agent:preflight`, `agent:test-sdlc`, `quality:changed`, `ddd-base`, `conditioning`, `packages/agent-sdlc`). Allowlist: this spec and the migration table in `host/README.md`.
- Draft the canary fixture (`docs/specs/drafts/canary.md` + `canary.tasks.json`: 1 vertical slice, 1 task, <= 2 ACs, <= 3 files under `scripts/` or `testing/`, `verificationCommand: ["pnpm","run","test:unit"]`), run `canary check`, then the hosted run to `READY_FOR_GIT_APPROVAL`; never merge the canary worktree. Requires operator approval for live model calls.

## 5. Acceptance criteria

- AC-01: With this repo's profile, `pnpm run test:unit` passes and no spec depends on fitness-app names or layout.
- AC-02: Allowed commands and repository scopes come only from the host profile; the default profile accepts only `verify.argv`.
- AC-03: Discovery never fabricates packages.
- AC-04: Engine paths (self location, state dir, secrets) are resolved from the profile; canary hash bindings for this repo are unchanged by Slice 3.
- AC-05: `host-neutrality.spec.mjs` passes with the denylist above.
- AC-06: The fitness-app profile validates (`host check --root <fitness-app>`) and a hydration dry run on it succeeds with the documented new fields.
- AC-07: `canary check` is `CANARY_ELIGIBLE` for the drafted fixture and a hosted canary reaches `READY_FOR_GIT_APPROVAL` with 0 rejected mutations and 0 semantic repairs.

## 6. Risks and open questions

- Slice 0 is the largest effort (about 144 files carry literals); batching by directory with the suite green after each batch limits risk.
- Changing the default `stateDir` affects any host without an explicit value; verify other hosts before release.
- Canary hash bindings change whenever planning files change (Slices 1-3); requalify after Slice 3.
- Decided: a new top-level `commandPolicy` block in the host profile (`commands` is taken by the script adapter).
- Decided: clean break. The `agent:*` and `quality:changed` verbs are removed with no deprecation window.

## 7. Host configuration impact

Hosts on the global install must, before upgrading: set `stateDir`, declare `verify.argv`, declare `commands` for any unfiltered scripts they run (e.g. `agent:preflight`, `quality:changed`), declare `policy.secretPaths`, and keep `hydration` steps explicit. Pin the engine version until the slices they depend on are released.
