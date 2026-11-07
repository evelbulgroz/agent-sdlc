# acceptance

Host-neutral acceptance-evidence primitives, driven by the `acceptanceEvidence` block of `.agents/sdlc-host.json` (`1.5.0`; see `host/README.md`). Plain `.mjs`, copied into `dist/acceptance` by the build. Migration of the prior host's modules is incremental; see `docs/specs/drafts/host-tooling-boundary.md`.

| File | Contents |
|---|---|
| `config.mjs` | `acceptanceConfig(profile, root)`: resolves the block into frozen constants. Fails closed when the block is absent. Pure and import-free so it runs from source and from `dist` (the caller passes the profile from `loadHostProfile`). Fails closed when the block is absent. |
| `primitives.mjs` | Dependency-free helpers safe to import inside the sandbox: `relativePath`, `regularFile`, `verifyFile`, `argumentsFor`, `titleMatches`, `selectionGrep`, `normalizedCase`, `runnerOutcome`, hashing and JSON writers. |
| `process.mjs` | `executeOwned` (process-group ownership, time and output bounds) and `launchSupervised` (bubblewrap launcher with mount and environment validation). |
| `sandbox.mjs` | `namespaceArgv(config, argv, opts)`: bubblewrap argv built only from configured binds. Every bind must be a repository-relative name whose real path stays under its base; writable paths must live under the owned evidence directory. |
| `contracts.mjs` | Wire-contract loading from the pinned runtime copy, request/report helpers, and `caseSelections` bound to the configured package root. |
| `experiment-budget.mjs`, `experiment-config.mjs` | Budget ceilings and validators; `buildExperiment(roles, runId)` takes the run id from the caller. |
| `role-definitions.mjs`, `governor-resolution.mjs`, `prompt-fit.mjs` | Freeze the resolved roles, the governor policy and critic prompt fit. Engine modules load through `engineModule`, not `AGENT_SDLC_PATH`. |
| `experiment-ledger.mjs`, `experiment-governor.mjs`, `experiment-broker.mjs` | Frozen-budget SQLite ledger (reserve/settle/recover, active-time clock), the all-role governor wrapper, and the token-authenticated socket broker with its child-side remote ledger. |
| `evidence-broker.mjs`, `prepare-files.mjs` | Frozen-adapter broker (takes `stateDir`) and verified parallel file preparation. |
| `bin-shims.mjs`, `recipes.mjs`, `preflight-bridge.mjs` | `.bin` shims, frozen command-recipe validation and the credential-free preflight runner. The node path, package root, package manager and preflight argv are passed in from `acceptanceConfig`. |
| `readiness.mjs` | `readiness(root, config)` and `candidates(config)`: per-binding state of the standing admission inputs (missing, unpassed, present, no-producer) plus HEAD and dirty tree. |
| `admission.mjs` | `verifyAdmission(root, config, manifest)`, `assembleManifest`, `bindingRecords`, `unexpectedDirtyEntries`. Identity, package and path scope come from config and `admissionIdentity`; one qualified adapter per configured runner is required; run artifacts are tolerated under `runsDir`. |
| `admission-proposal.mjs` | `buildProposal(root, config, …)`: assembles the BLOCKED admission manifest from the records, engine-owned artifact names and the profile; approval receipts stay operator-authored. Identity strings come from `admissionIdentity`. |
| `artifacts.mjs` | Engine-owned, unversioned artifact names under `evidenceDir/<canaryId>/` (`artifact(config, name)`) and the model-usage state directory. Not configurable. |
| `live-records.mjs` | `shellInvocations`, `scenarioRecords` and `verifyScenarioBindings`: the exact guarded shell argv set, orchestrator scope (state, review and runs dirs from the profile; credentials from `canary.providerCredentials`) and scenario-to-authorization binding. |
| `admission-records.mjs` | `buildAdmissionRecords` and its six record builders (engine build, route prices, allowed commands, artifact ownership, semantic packets, control receipts). Node, package, paths, state dir and task verification come from config; the control specs are supplied by the caller. The engine CLI wrapper is deferred. |
| `registrations.mjs` | `buildRegistrations(root, config, …)` (one adapter registration per configured runner: argv, bundle files, config, capabilities and timeout from the runner) and `validateRegistrations`. The engine CLI wrapper is deferred. |
| `canary-execution.mjs` | `buildCaseMap`, `buildCanaryExecution`, `assertCanaryExecutionCurrent`. Adapter bundle files come from each runner's `bundleFiles`; runner config and project from `runners.<name>.config` and `.project`. The engine CLI wrapper is deferred. |
| `run-authorization.mjs` | `loadObligations` (validates the host obligations file against the configured canary files and runners), `allowedPaths`, `buildQualityPlan`, `buildAuthorization(root, config, …)`. Run id and repository id come from the caller and profile. |

Specs: `acceptance-core.spec.mjs`. Bind escapes (`../`, absolute, symlink) are refused twice: by the profile loader and by `namespaceArgv` itself.

Not yet moved: admission, authorization, qualification, supervisor, governor and live-run modules (S2b, S2c). Several of them hold host logic beyond path literals (canary file lists, pretest generation), so they need extra config keys or stay in the host.
