# Host Profile & Workspace Adapters (`host/`)

Host-repository configuration loader (`.agents/sdlc-host.json`), progressive verification gates, evidence-adapter registrations, workspace package discovery, worktree hydration dispatch, role-command allowlisting, and host verification execution.

## Key Files & Entrypoints

- `host/host-profile.ts` — Closed `1.4.0` schema validator and loader for `.agents/sdlc-host.json`, with explicit legacy decoding for `1.3.0` and `1.2.0`.
- `host/verify-config.ts` — Progressive 3-tier `verify` schema (`VerifySchema`, `HostVerifyConfig`, `DEFAULT_VERIFY_ARGV`, `DEFAULT_VERIFY_REQUIRE`, `DEFAULT_VERIFY_HEAD_FIELD`, and `resolveHostVerifyConfig`).
- `host/verify-runner.ts` — Shared host verification command runner supporting both exit-code mode and structured JSON receipt mode (`resultPath`).
- `host/workspace.ts` — Adapter-aware workspace package discovery (`discoverWorkspace`).
- `host/learnings.ts` — Native project learnings store, validator, weighted scorer, and `inferRecallScopes` driven by `profile.learnings`.
- `host/default-adapter.ts` — Default host adapter (`hydrateWorktree`, `validateCommandAllowlist`, `scanWorkspacePackages`).
- `host/learnings.ts` — Native project learnings store, validator, weighted scorer, and `inferRecallScopes` driven by `profile.learnings`.
- `host/verification-preparation-schema.ts` & `host/verification-preparation.ts` — Optional `verificationPreparation` prerequisite-build schema, deterministic selection, policy/selection hashing, and command-policy validation.
- `host/script.ts` — Portable `script` host adapter (explicit `commands`, `hydration`, and `workspace.directories`).

## Core Invariants

1. **Closed Host Profile Contract (`host-profile.ts`, `verify-config.ts`):**
   - `.agents/sdlc-host.json` (`schemaVersion: "1.4.0"`) declares `repositoryId` (bound into every `RunAuthorizationEnvelope`), the active adapter (`default` or `script`), progressive `verify` gate configuration, declarative hydration, workspace layout, policy/architecture/qualityGate rules, learnings scope inference, and optional 3-layer prompt/rubric composition (`prompts.preset`, `prompts.roleAddendaDir`, `prompts.rubricAddendaDir`, `prompts.pathScopedRules`). Optional `evidenceAdapters` bind versioned normalized case-level evidence protocols to explicit host argv, hashed adapter/configuration files, supported layers/capabilities, qualification evidence, and finite execution limits; the engine validates receipts without runner-specific report parsing.
   - **Single-directory defaults (`1.3.0` and `1.4.0`):** In profiles at either version, `stateDir`, `reviewDir`, `specDraftDir`, and `runsDir` are optional. When omitted, `loadHostProfile()` defaults `stateDir` to `".agent-sdlc"`, `reviewDir` to `"<stateDir>/reviews"` (`".agent-sdlc/reviews"`), and `specDraftDir` to `"<stateDir>/specs/drafts"`. When `runsDir` is omitted, `runsRootDir(rootDir)` defaults to `liveRunRoot(rootDir)` (`<stateDir>`), co-locating run projections inside `<stateDir>/<run-id>/` and copying them into `<stateDir>/.archive/<run-id>/` during `prune-runs` archival. Setting `runsDir` (e.g. `"docs/specs/runs"`) enables an opt-in separate compatibility projection directory. Legacy `schemaVersion: "1.2.0"` profiles continue to require explicit `stateDir`, `reviewDir`, and `specDraftDir` fields and resolve `runsRootDir` to `docs/specs/runs`.
   - **Secret paths (`policy.secretPaths`):** Optional list of host paths treated as secrets: an exact path or directory prefix (`vault/`), or a file-name suffix with a leading `*` (`*.security.config.ts`). They are excluded from review excerpts and contained-path inputs, flagged as irreversible in decisions, and listed in the PR checklist line. Built-in exclusions (`.env*`, keys/certs, build output) always apply; no host-specific path is baked in.
   - **Reversible decisions (`policy.reversibleDecisions`):** Optional list of `{ id, name, category, matcher, decision, assumption, rationale }` rules (`matcher` is a case-insensitive regex source) that auto-resolve spec questions. When present it replaces the neutral default, which has a single rule answering "how do we verify" from `verify.argv`. Hosts put their own handbook/convention references in `rationale`.
   - **Command policy (`commandPolicy`, `command-policy.ts`):** Optional block `{ allowedVerbs?, repositoryScripts?, contractGateScripts? }`. `allowedVerbs` replaces the default verbs (`test`, `build`, `lint`, `typecheck`, `build:contracts`, `check:contract-drift`) accepted after `pnpm --filter <pkg> [run]`. `repositoryScripts` are exact `pnpm run ...` argv lists role commands may run unfiltered; `pnpm run test:unit` and `verify.argv` are always accepted. `contractGateScripts` are appended to contract-producing tasks' verification commands and are implicitly allowlisted. The engine no longer bakes in `agent:*` or `quality:changed`; hosts that run them must declare them (clean break, no deprecation window). This block is distinct from the script adapter's `commands` argv list.
   - **Repository scopes (`workspace.repositoryScopes`):** Path prefixes or exact files (e.g. `docs`, `.agents`, `package.json`) whose touched surfaces map to a repository-scope task verified by `pnpm run test:unit` rather than a workspace package. The engine no longer assumes any scope, and no longer fabricates fallback workspace packages when discovery finds none; surfaces outside packages, scopes, and `allowedPathRoots` fail with `TASK_PLAN_INVALID`.
   - **Engine location (`engine.selfRoot`):** Optional host-relative directory (default `.`) where the engine is embedded or vendored. It prefixes the logical names of the canary's bounded planning files and locates the host reliability corpus and the auto-prune CLI; a host without an embedded engine uses the installed package under the same logical names. Logical names changed from the former hardcoded `` prefix, so `boundedPlanningHash` changes once and existing canary qualifications must be re-run.
   - **Verification preparation (`verificationPreparation`):** Optional `{ builds: [{ id, targetPackages, packagePath, argv, outputPathPrefixes, dependsOn? }] }` (`1.3.0` only). Builds whose `targetPackages` contain a task's target package, plus their transitive `dependsOn`, run in topological order (ties by `id`) in the isolated worktree before **every** consumer verification invocation, including repairs, resumes, integration preflight, and committed-tree verification. They run even when the hydration cache is `CACHED` and `dist/` exists: installation caching is not build freshness. Each `argv` must already pass the command policy above (`pnpm --filter <pkg> <verb>` scoped to its own `packagePath`, or an exact `repositoryScripts` entry); `outputPathPrefixes` are package-relative generated outputs. Duplicate ids, unresolved or cyclic dependencies, traversal, absolute or package-wide outputs, and non-workspace packages are rejected. Builds grant execution only: prerequisite packages are never added to authored-source scope, and a build that changes undeclared source fails. Hosts without the section keep their previous verification behaviour.
   - **Staging a preparation-policy change:** The policy is hashed into the run authorization (`preparationPolicyHash`) and re-read from the execution worktree before each build. Commit a separately approved host-profile change to the branch that will be the run's `baseCommitSha` *before* authorizing a dependent run; an uncommitted edit in another checkout does not satisfy the binding, and changing the policy mid-run stops with `AUTHORIZATION_INVALID` until the run is reauthorized.
   - `start [--root <dir>]` validates `.agents/sdlc-host.json` before creating a run directory or SQLite row.
   - Validate a host profile standalone via `agent-sdlc host check [--root <dir>] [--json]`, which returns `{ profileId, adapter }`.

2. **Client Onboarding & `.gitignore` Guidance:**
   - Minimal new-client onboarding requires only `.agents/sdlc-host.json` (`schemaVersion: "1.4.0"`) and adding `.agent-sdlc/` to the repository's `.gitignore` so machine-local SQLite databases, worktrees, critic reports, and archived runs are never committed. Evidence adapters are optional until a host explicitly qualifies and authorizes them.
   - Creating `.agents/workflows/` or `.agents/review-rubrics/` is optional; `roles/defaults/` and `review/defaults/` provide built-in workflow, role, and prompt/rubric defaults (see [`../roles/README.md`](../roles/README.md) and [`../prompts/README.md`](../prompts/README.md)).

3. **Package Closure & Adapter Isolation (`learnings.ts`, `script.ts`):**
   - The package is self-contained: no TypeScript module resolves relative imports outside the package root.
   - Project learnings loading, validation, scoring, and scope inference execute natively inside `host/learnings.ts` using `.agents/sdlc-host.json`.

## Progressive 3-Tier Verification Gate (`verify-config.ts`, `verify-runner.ts`)

### Frozen evidence executable qualification

Evidence adapter execution (including receipt reuse) requires canonical absolute
`argv[0]` and `executableSha256`, the SHA-256 of that regular executable's exact
bytes. Symlink aliases, relative names/PATH discovery, missing hashes and changed
executable bytes fail closed. For an interpreter, qualify its canonical absolute
binary separately from the adapter script: the script belongs in `bundleFiles`,
and its dependencies/configuration belong in their respective hashed lists.
All these values enter the frozen adapter binding, authorization and v2 plan hash.
Hosts must qualify the exact offline deployment binary before approving a run;
the engine never discovers or substitutes one. Structural historical registrations
may omit the additive field so their hashes remain readable unchanged, but cannot
execute or reuse evidence until explicitly requalified and reapproved. Legacy
`verify.argv` execution is unchanged.

Execution and reuse also require `qualificationArtifact: {path, sha256}` whose
hash equals `qualificationArtifactHash`. Its regular JSON receipt must be
`{schemaVersion, kind, status:"passed", liveQualified:false, providerOperations:0,
[sourceCommitSha, inventorySha256]}`. The optional SHAs are retained provenance, not
checked against the run base (a committed receipt cannot name its own commit). Blocked,
live-claiming, provider-using, malformed or missing receipts fail with `unqualified-evidence-adapter`. This
proves provider-free offline qualification only, never semantic adequacy.

Large frozen closures can use optional `dependencyManifest: {path, sha256}`.
Its repository-relative regular JSON file has the closed shape
`{schemaVersion:"1.0.0", files:[{path,sha256}]}`: 1–100,000 unique paths,
at most 20 MiB. The engine verifies its exact bytes and every listed regular file
before/after execution and on receipt reuse, rejecting symlinked parents too.
The approved manifest-backed registration grants frozen read inputs outside model
edit scope; it never broadens authorized writes. Inline registrations retain
their existing hashes and path-scope checks; no stored-data migration is needed.

On Linux, evidence commands run in a detached process group. Success, timeout and
error cleanup kill remaining group members and wait until they are no longer
running before source observation; cleanup failure produces incomplete evidence.
This is lifecycle containment, **not a sandbox**: a descendant calling `setsid`
can escape the group. Host qualification must exclude such behavior or provide
external containment (for example cgroups); process groups alone do not guarantee
containment of hostile programs.

Host repositories configure their deterministic verification gate across three progressive tiers in `.agents/sdlc-host.json` (`schemaVersion: "1.4.0"`):

| Tier | Configuration in `.agents/sdlc-host.json` (`1.3.0`) | Execution & Evidence Behavior |
|---|---|---|
| **Tier 1: Conventional Default (`npm test`)** | Omit `verify` entirely (also used by `loadHostProfileOrFallback` when no profile exists). | Normalizes to `{ argv: ["npm", "test"] }`. Runs `npm test` in the worktree and passes on exit code `0`. |
| **Tier 2: Custom Exit-Code Command (`verify.argv`)** | `"verify": { "argv": ["pnpm", "run", "check"] }` or `["pnpm", "run", "verify", "--", "{baseSha}"]` (0 or 1 discrete `{baseSha}` token; no `resultPath`). | Substitutes `{baseSha}` if present, executes `verify.argv`, and passes on exit code `0`. |
| **Tier 3: Receipt-Backed Gate (`verify.resultPath`)** | `"verify": { "argv": ["pnpm", "run", "verify:receipt", "--", "--base", "{baseSha}"], "resultPath": ".verify-receipt.json" }` (`require` defaults to `{ status: "OK", canonical: true }`; `headField` defaults to `"gitHeadSha"`). | Requires exit code `0` **and** a structured JSON receipt at `resultPath` matching `require.status`, `require.canonical`, `base`, and `headField`. |

- **Validation guardrails:** Specifying `require` or `headField` without `resultPath`, including partial `{baseSha}` substrings (e.g. `--base={baseSha}`), or including more than one `{baseSha}` token fails closed with `HOST_PROFILE_INVALID`. Legacy `schemaVersion: "1.2.0"` profiles continue requiring explicit `verify`, `{baseSha}`, `resultPath`, `require`, and `headField`.
- **Per-token command allowlisting (`execution/tool-commands.ts`):** `validateHostCommand` permits the host profile's configured `verify.argv` by matching `[command, ...args]` element-by-element—where each `{baseSha}` slot must match `/^(?:[0-9a-f]{7,40}|HEAD)$/` per token and every literal token must match exactly—without adding `npm` to the general command allowlist (rejecting `npm run build` or `npm test --watch`).

### Trust Model Trade-off: Exit-Code Self-Attestation vs. Receipt Mode

- **Exit-code mode (Tiers 1 & 2, `resultPath` omitted):** When the verification process exits `0`, `host/verify-runner.ts` synthesizes a canonical `preflightResult` (`{ status: "OK", canonical: true, exitCode: 0, base: resolvedBaseSha, gitHeadSha: resolvedExpectedHead }`) so `review/verifier.ts` binds a `PreflightBindingRecord` identically across all tiers. Because this receipt is **runner self-attested from exit code `0` alone**, a worktree-controlled test script that exits `0` early or skips suites will satisfy the gate.
- **Receipt mode (Tier 3, `resultPath` configured):** `verify-runner.ts` never synthesizes a receipt when `resultPath` is configured; the gate script itself must emit a JSON file on disk proving full canonical execution against the expected `base` and `gitHeadSha`.

### Case Study: Graduating to a Class-Aware `verify:receipt` Script

As a repository grows from a single package into a multi-package workspace, running every suite unconditionally on every task becomes either too slow or too easy to bypass. A Tier 3 `verify:receipt` script solves both problems through four design mechanisms:

1. **Diff-driven change classification (`--base {baseSha}`):** Passing `{baseSha}` in `verify.argv` lets `verify:receipt` diff `{baseSha}...HEAD` (plus untracked/staged worktree files) and classify the change (e.g. Class A scoped package code vs. Class B root/tooling/lockfile changes vs. docs-only) so it runs targeted quality and verification gates for Class A and full workspace gates for Class B.
2. **Skip-flag defense (`PARTIAL` vs. `OK` and `canonical: true`):** Developer convenience flags (such as `--skip-verify` or `--skip-product-smoke`) are useful during interactive debugging but unsafe as an autonomous done bar. When any skip flag is active, `verify:receipt` writes `"status": "PARTIAL"`, `"canonical": false`, and exits `2`—which `verify-runner.ts` rejects because `require` enforces `{ status: "OK", canonical: true }`.
3. **Fail-closed `EXIT` trap against stale receipts:** At startup, `verify:receipt` removes any prior receipt file and registers a shell `EXIT` trap (`trap on_exit EXIT`). If any lint, typecheck, test, or smoke gate exits non-zero—or if the script is interrupted—the `EXIT` trap writes `"status": "FAIL"` and `"canonical": false` to `resultPath`, preventing a stale `"status": "OK"` receipt from an earlier pass from masquerading as fresh evidence.
4. **Cryptographic `gitHeadSha` and `base` binding:** On completion, `verify:receipt` writes the resolved `--base` SHA to `base` and `git rev-parse HEAD` to `gitHeadSha` (`headField`). `verify-runner.ts` and `verifier.ts` verify that `base` matches the authorized `baseCommitSha` and `gitHeadSha` matches the worktree base (pre-commit) or committed `HEAD` (post-commit) before sealing `PreflightBindingRecord`.

## Migrating a host from earlier engine versions

The engine no longer carries host-specific defaults. Hosts that relied on them must declare the matching profile fields (clean break, no deprecation window):

| Previously implicit | Declare in `.agents/sdlc-host.json` |
|---------------------|--------------------------------------|
| Verification script (`agent:preflight`) | `verify.argv` (+ `verify.resultPath` for receipt-backed gates) |
| Hydration/setup scripts and package builds | `hydration.steps` |
| Allowed `pnpm run` scripts, contract gate script | `commandPolicy` |
| Workspace packages, `docs/`, `.agents/`, `tools/` scopes | `workspace.*`, `workspace.repositoryScopes` |
| Engine vendored at `packages/agent-sdlc` | `engine.selfRoot` |
| `security-config/`, `*.security.config.ts` exclusions | `policy.secretPaths` |
| State directory `tools/.agent-sdlc` | `stateDir` |
| Monorepo convention auto-decisions (Jest/Vitest, ESM, preflight class) | `policy.reversibleDecisions` |
| Frontend/backend path-scoped addenda | `prompts.pathScopedRules` + host-owned addenda files |
