# Single-config host onboarding and runner-agnostic evidence

Status: draft for approval. Owner: engine maintainers. Supersedes `optional-integration-toolkit.md` (see "Carried forward"). Follows the retired `host-tooling-boundary.md`, which was only partly executed. Evidence base: a read-only audit of fitness-app `tools/acceptance-evidence/` and `tools/lib/` (host `5bb5cb43`, engine `c7658e0`), and live canary runs 11 to 15.

## Goal

A new host enables the engine by committing one `.agents/sdlc-host.json`, the data files it names, and ordinary package scripts. It writes no engine-specific code. The engine contains no code that knows a test runner, package manager, bundler or framework.

## Boundary rule

> The host owns deterministic QA and exposes it as commands. The engine owns orchestration, trust and evidence. The engine runs host commands and consumes neutral artifacts. It never parses a runner's private output.

This extends what the engine already does for `verify.argv`, `commandPolicy` and `verificationPreparation`: the host names argv arrays, the engine runs them under its own limits. Acceptance evidence becomes one more command with a stated output contract, instead of a hash-pinned adapter program speaking the engine's wire protocol.

## Feasibility judgement

Feasible, because the engine stops carrying runner adapters. The burden moves to the host's own test scripts. Limits:

1. **Policy and data stay host-owned.** The case corpus, obligations, quality baselines, architecture rules, thresholds and the canary spec describe the host's product. The engine ships schemas and a `scaffold` command that proposes drafts. It never invents them.
2. **The host author is trusted to mean the command. The implementer is not allowed to change the bytes that run.** A host that commits a script writing any report it likes gets the same trust `verify.argv` already grants. The engine does not try to recreate today's adapter trust (a hash-pinned program whose stdout the evidence port accepts only on exit 0 with every selected case passed). It holds the implementer to the approved bytes and checks the report's shape. See "Trust model".
3. **Isolation depends on the toolchain.** The sandbox bind list and the runtime closure come from host data. The engine verifies and materializes what the host lists. It refuses what it cannot verify.

| Tier | Host contents | Applies to |
|---|---|---|
| A | `sdlc-host.json`, data files, package scripts that write the closed JUnit subset to `{reportPath}` | any runner or wrapper that can emit it (`node:test` does) |
| B | Tier A plus a small wrapper that writes the `case-report` JSON | runners that cannot emit the subset |

No tier has the host write an engine adapter. fitness-app should reach Tier A for acceptance evidence. Its quality gate (`tools/quality/`) and verify plumbing (`affected-packages.sh`, `verify-pool*.sh`) stay host-owned.

## Boundary model

| Concern | Owner | Interface |
|---|---|---|
| Run orchestration, state graph, envelope, admission, critics, experiment budget, governor, ledger, persistence | Engine | none, internal |
| Sandbox (no network, no install, bounded writes), hydration of pinned files, owned child processes, timeouts | Engine | host config: binds, limits, file lists |
| Running a command and reading its report | Engine | `commands` config and the neutral report formats below |
| Parsing neutral report formats (JUnit XML, case-report JSON) | Engine | closed schemas |
| Cross-checking a report against the corpus and obligations | Engine | corpus schema |
| Which tests exist, which cases map to which `@case` tag, runner config, reporter flags, server and port management, pretest steps | Host | package scripts and runner config |
| Runtime closure contents (`runtime.sources.json`) | Host data, engine verifies and materializes | closure schema |
| Quality policy, verify and preflight scripts, monorepo tooling | Host | `verify`, `commandPolicy`, `qualityGate` |

## The command interface

`acceptanceEvidence.commands` is a closed map. Each entry:

```json
{
  "id": "unit",
  "argv": ["pnpm", "run", "test:ac:unit", "--", "{reportPath}"],
  "cwd": "apps/frontends/fitnessapp-pwa-frontend",
  "timeoutMs": 600000,
  "pins": ["package.json", "vitest.canary.config.ts"]
}
```

- `argv` is a no-shell array. `argv[0]` is resolved by the supervisor, outside the sandbox, to a realpath, hashed as `acceptance/registrations.mjs` does for adapters, and passed absolute into `namespaceArgv`. The command namespace gets a fixed `PATH` of `<closure>/usr/bin` plus the directory of the pinned `node`, and a `/bin` link into the closure. The current `namespaceArgv` provides neither, and its `PATH` is `/nonexistent`. **Default invocation is `node <script>`** (for example `node --test`, or a runner's JS entry), which needs nothing but the pinned node. `pnpm run <script>` additionally needs `pnpm`, `sh` and every `#!/usr/bin/env node` shim in the closure. It is allowed only when `runtime.sources.json` lists them. H3 spikes this and records which form fitness-app can use.
- Placeholders `{reportPath}` and `{baseSha}` are substituted inside a whole argv element or a `key=value` value (`--outputFile={reportPath}`), by plain string replacement on one token. Any other placeholder fails validation. The report directory is always mounted at the fixed path `/report`, so a runner config may hardcode `/report/<id>.xml` instead. The engine sets no environment variable a runner would have to read.
- `pins` lists files and scripts whose SHA-256 joins the admission record. An entry is `{ "file": path }` or `{ "script": { "file": "package.json", "name": "test:ac:unit" } }`. A script pin hashes `scripts[name]` and its `pre`/`post` hooks, not the whole file, so a task may edit dependencies. Pins are verified in the worktree before and after the run. Drift fails with `PINNED_FILE_MODIFIED`, which reaches the operator as a question. There is no snapshot overlay. Runner config files, the corpus and the sentinel file are pinned whole and must lie outside the write scope.
- `pretest` is a list of the same objects, run in order before `unit` and `browser`. It replaces the host `pretest.mjs`.
- Selection is by tag, not by argv. The command runs the host's tagged acceptance suite. The engine filters the report to the task's cases.
- Server, port and browser lifecycle belong to the runner config (for example a `webServer` entry). The engine has no port setting.
- `retries` (default 0) declares the runner's retry count. It is a host-pinned fact.

## Neutral report formats

The engine parses exactly two closed formats. The spec names no runner.

1. **`junit`**: a closed JUnit subset. Elements: `testsuites`, `testsuite` (nesting allowed), `testcase` (attributes `name`, optional `classname`, `file`, `time`; `testcase` may be a direct child of `testsuites`), children `failure`, `error`, `skipped`, `properties`/`property`, and capped `system-out`/`system-err`. Any other element is rejected. Comments are ignored.
2. **`case-report`**: an engine-defined closed JSON schema with the same fields. Tier B wrappers emit it.

Identity follows the engine's existing convention: the testcase `name` carries the corpus `@case AC-nn.m` tag (`acceptance/primitives.mjs` `titleMatches`). The `@ac` tag is for criterion citations and is not an identity. Neither `classname` nor `file` is required, because some runners emit a constant `classname` and no `file`. With `retries: 0`, a repeated identity fails closed. With `retries: n`, up to `n+1` rows with one identity are attempts, the last wins and the count is recorded. More rows fail.

Pass predicate, one definition:

- Every corpus-selected case is present once after attempt collapse and reports `passed`. `skipped`, `todo` and `only` count as not passed.
- The exit status is zero exactly when the unfiltered report has no `failed` or `error` row. The exit code is reconciled with the unfiltered report, then discharge is judged on the selected cases alone: a non-zero exit caused only by unselected failing cases (work-in-progress tests of later tasks) does not fail a checkpoint, and a non-zero exit with no failing row, or exit 0 with one, is a contradiction.
- A missing report, unknown element, oversized file or symlinked path fails.

Failure text comes from the report's message fields, so the repair loop needs no runner code.

## Trust model

Design statement: the host author is trusted to mean the command. The implementer is not allowed to change the bytes that run. The steps below enforce the second half.

1. **Hash pins.** The `argv[0]` realpath and hash, the pins and the closure are recorded in admission and verified before and after the run. Drift fails closed.
2. **Sandboxed.** No network, no install. Writes only to `/report` and scratch. Default binds are the package `cwd`, the closure and the corpus files, never the whole host root, so an archived report cannot carry secrets from the rest of the tree.
3. **Engine-read report.** The engine reads the file with the regular-file, `O_NOFOLLOW` and size-cap rules. Stdout is never evidence.
4. **Corpus cross-check** and the pass predicate above.
5. **Write-scope exclusion** for the corpus, sentinel file, runner configs and whole-file pins.
6. **Report freshness.** `/report` is emptied before the command starts. A report not created inside the run window fails. This catches stale and implementer-written reports, not a lying script.
7. **Sentinel tripwire, admission only.** The host may declare a separate `sentinel` command, a script holding a planted failing case, which the engine runs once at admission and requires to exit non-zero with exactly that case failed. It catches an always-green reporter. It is not evidence that a runner executed the product cases, and it never runs in the live suite, so the host's acceptance script stays an ordinary command that exits 0 on success.

If reliability suffers, the fallback is the executable adapter kind, loadable until H5c.

## Minimal host config

A Tier A host's evidence block is `1.5.0`'s required fields minus the three that become optional, plus `commands`:

```json
"acceptanceEvidence": {
  "canaryId": "canary-v1", "slug": "my-canary",
  "evidenceDir": "tools/.acceptance-evidence/canary-v1",
  "runtimeDir": "tools/acceptance-evidence/runtime",
  "caseManifest": "tools/acceptance-evidence/corpus.json",
  "runtimeSources": "tools/acceptance-evidence/runtime.sources.json",
  "package": { "root": "apps/web" },
  "sandbox": { "readOnlyBinds": [] },
  "commands": {
    "unit": { "argv": ["node", "--test", "--test-reporter=junit", "--test-reporter-destination={reportPath}"] }
  }
}
```

`helpersDir`, `nodeExecutable` and `runners` become optional. `helpersDir` is bound only when set. Every sandbox, including task-verification recipes, also binds `runtimeDir` read-only, so a runtime-vendored browser needs no helpers mount. `nodeExecutable` defaults to the realpath of the running engine's node. `cwd` defaults to `package.root` and must lie inside it. `timeoutMs` defaults to the global evidence limit. `pins` default to the script pin implied by a `pnpm run` argv, or none for `node <file>` plus the files the corpus names. H3 may derive `evidenceDir` and `runtimeDir` from `stateDir` if `config.mjs` can do so without a literal. If not, they stay explicit.

The host removes `evidenceAdapters` (3 KB in fitness-app), `bundleFiles`, hash pins, qualification artifact paths and `runners`; the engine derives them into admission.

## What the engine keeps

Admission, its pins, the experiment budget and governor, run authorization, the sandbox, closure verify and materialize, frozen workspace bootstrap verification, the conformance suite for remaining executable registrations, and the closed report parsers. It gains the command evidence kind.

## Disposition of audited files

| Host file(s) | Disposition |
|---|---|
| `qualify.mjs`, `offline-receipt.{mjs,spec}` | Delete. Engine `qualification.mjs` and `offline-receipt.mjs` replace them. `qualify.mjs` already imports a missing `./supervisor.mjs`. |
| `runtime.mjs` | Delete after the adapters go. Engine `runtime-inventory.mjs` replaces it. |
| `protocol.mjs` | Delete after the adapters go. Its constants (`PACKAGE`, `OUTPUT`, `RUNTIME`, `NODE`) become config. Engine `primitives.mjs` covers the helpers. |
| `unit-adapter.mjs`, `browser-adapter.mjs`, `adapter.spec` | Delete. The host adds a JUnit reporter to its vitest and playwright scripts. The host keeps `case-inventory.spec`. |
| `pretest.mjs` | Delete. Becomes `pretest` commands that call package scripts. |
| `corpus.json`, `canary.*.json`, `runtime.sources.json`, `runtime/` | Keep (host data and config). |
| `lib/verify-bootstrap.{sh,mjs}` | Replace with a call to an engine CLI command that verifies the frozen bootstrap. The host `verify-*.sh` files source a one-line shim. |
| `lib/verify-vitest-cache.mjs` | Host runner glue. Decouple from `protocol.mjs`, or drop if the cache hook is no longer needed. Decide in H0. |
| `lib/atomic-file-state.*` | Not an engine matter. It re-exports the governor package for host telemetry. Import the governor directly. |
| `lib/affected-packages.sh`, `verify-pool*.sh`, `verify-pool-deps.mjs`, `preflight-command.sh` | Keep in the host. These are deterministic QA and the pnpm-monorepo toolkit question is resolved: the engine ships no monorepo toolkit. The host may publish them as a template. |

## Config contract

`sdlc-host.json` `1.6.0` adds a closed `acceptanceEvidence.commands` block and makes `runners`, `nodeExecutable` and `helpersDir` optional (the `1.5.0` schema requires them). A profile setting both `runners` and `commands` for one layer fails validation. `1.5.0` profiles load unchanged until H5c. A missing `acceptanceEvidence` block disables the path with a typed error, as `acceptance/config.mjs` already does.

**Command evidence is a first-class mode of `host/evidence-port.ts`, not a hidden adapter.** `AdapterRegistrationSchema` becomes a union on `kind`: `executable` (today's) and `command`. A command registration carries `commandSha256` (argv, pins, resolved `argv[0]` hash) and has no `bundleFiles`, `executableSha256` or `qualificationArtifact`. For that kind `executeEvidence` replaces `spawnEvidence` plus `JSON.parse(stdout)` with a brokered spawn that returns `{ exitCode, reportBytes }`. The closed parser and pass predicate run in the engine child, inside the sandbox, and synthesize the `EvidenceReport`, which then passes the existing `validateEvidenceReportForRequest` and artifact checks. The supervisor handler only builds the namespace, spawns and returns bytes. Both stages check the registration, so `verifyEvidenceRegistration` gets a `command` branch checking `commandSha256` and pins instead of an executable.

## Qualification decision (for the approver)

Admission requires a passed `offlineQualificationReceipt`. For the command kind this is a new `commandQualificationReceipt`, produced offline from engine-owned fixtures: parser accept and reject cases, the pass predicate, and the admission-time sentinel run. Runs 11 to 15 exercised the adapter path, and `qualification.mjs` still returns `blocked`. Those runs are not evidence that a command reaches READY. The H4 fixture host and the H5 canaries are. The adapter path's four-field gate stays closed.

## Slices

Each slice is its own commit with user approval, a full done bar, and no timing regression against the 1,764 s ceiling.

| Slice | Change | Gate |
|---|---|---|
| H0 | Inventory every engine read of a host literal. Read the adapter bodies. Decide `verify-vitest-cache`. | Neutrality guard covers the list. |
| H1 | Delete `qualify`, `offline-receipt` from the host. | Host specs and conformance green. |
| H2 | Closed report parsers, the pass predicate, freshness rules, and the `command` registration kind with its `evidence-port.ts` branch. | Specs fail on a missing, duplicate-identity, skipped, stale, pre-written or exit-contradicting report, and accept `node:test` shapes (top-level `testcase`, nested `testsuite`) and collapsed retries. |
| H3 | Profile `1.6.0`, supervisor handler, `argv[0]` resolution and pin, sandbox `PATH` and `/bin`, script pins with `PINNED_FILE_MODIFIED`, placeholder validation, escape specs (`../`, absolute, symlink, placeholder abuse), `commandQualificationReceipt`. Spike `pnpm run` in the sandbox. | New escape specs fail on the old code. |
| H4 | Fixture host (Tier A) using `node:test` writing the JUnit subset to `{reportPath}`, reaching READY from config and data only. | The real test of the goal. |
| H5a | fitness-app unit evidence on `commands`, beside the adapter. Regenerate admission. One canary to READY, 7/7. | Timing measured against the adapter path. |
| H5b | fitness-app browser evidence on `commands`, beside the adapter. Shows a `webServer` runs under the sysroot and `--unshare-net`. One canary to READY. | Same. |
| H5c | Delete the adapters, `protocol`, `runtime`, `pretest` from the host. | Canary 7/7 on the deleted layout. |
| H6 | Engine CLI for frozen-bootstrap verification. Replace the host shim target. | Host verify scripts green. |
| H7 | `scaffold` command. | Fixture host generated from it. |

## Acceptance criteria

- **AC-01.** A fixture host with only `sdlc-host.json`, data files and package scripts completes a command-evidence run and an offline replay.
- **AC-02.** After H5c the fitness-app canary reaches READY with 7/7 invariants. No host file under `tools/acceptance-evidence/` other than data files remains.
- **AC-03.** No engine file contains a fitness-app, vitest or playwright literal outside `*.spec.mjs` rejection assertions. The neutrality guard enforces it.
- **AC-04.** Each rule in "Neutral report formats" has a spec: missing report, duplicate identity, collapsed retry, skipped case, zero cases, exit-code contradiction, oversized file, symlinked path, unknown element.
- **AC-05.** Sandbox config and placeholder escapes are rejected with typed errors.
- **AC-06.** A modified pinned file or script fails with `PINNED_FILE_MODIFIED`. A task that edits other `package.json` fields still passes. Pin drift, a dirty live tree, `downloadsAllowed: true`, a missing binding, or a corpus, sentinel or runner config file inside the write scope fails admission and writes no passing receipt.
- **AC-07.** A missing `acceptanceEvidence` block disables the path with a typed error.
- **AC-08.** A pre-existing report file or a report created outside the run window fails with a typed error. At admission, a sentinel that passes or fails the wrong case fails the receipt.
- **AC-09.** `argv[0]` is resolved by the supervisor and pinned by realpath and hash. A `node` command runs under the sandbox `PATH` with `/bin` present. `pnpm run` works only when the closure lists `pnpm`, `sh` and its shims, and otherwise fails with a typed error.
- **AC-10.** A profile with both `runners` and `commands` for one layer fails validation. A `1.5.0` profile still loads.
- **AC-11.** A `command` registration needs no `bundleFiles`, `executableSha256` or `qualificationArtifact`, and `executable` registrations still validate.

## Carried forward from the superseded draft

Kept: the closure schema, the execution manifest and admission bindings, experiment control only when observed, the literal scan with its spec exemption, the file ceilings, and the failure defenses. Dropped: engine-owned `vitest` and `playwright` capabilities, `evidenceCapabilities`, the installed-checkout qualify step, `evidenceInstallHash` and `agent-sdlc evidence qualify`, which only existed to trust engine code inside the sandbox.

## Risks

- **Re-pinning.** Each slice regenerates admission and needs a human receipt approval.
- **Sandbox toolchain.** `pnpm run` in the sandbox needs `pnpm`, `sh` and shims in the closure. If H3 shows that is impractical, Tier A means `node <script>` rather than npm scripts. That weakens the npm-scripts goal, and the spec records it rather than hiding it.
- **Report detail.** The closed JUnit subset omits some detail the adapters carry. Ambiguous identity fails closed. H2 measures how often.
- **Trust reduction.** The engine no longer selects tests or parses runner output itself. This is the chosen direction, to be pulled back if reliability suffers. Pull-back triggers over the H5 canaries: a false pass found by an offline mutation score, an admission sentinel miss, or a failure rate above the current 1 in 5. The executable kind stays loadable until H5c, then is deprecated until a later spec.
- **Parity and timing.** Measure the unexplained 9 to 10 s versus 19 to 20 s adapter timing in H5a.
- **Overreach.** If H4 needs engine code that knows a runner, the Tier A claim is false and the spec records the real tier.
