# Fitness-app canary implementation scope and admission manifest

**Type:** Reference. **Status:** Proposed; admission BLOCKED.

Companion to the [canary specification](fitness-app-acceptance-evidence-canary.md).
Proposed paths, command interfaces and manifest; no implementation, installation,
worktree, provider or Git approval is granted.

Completion requires the implementation's base, hashes, qualification, prompt fit
and priced routes. Nulls block approval. New commands below do not exist yet.

## 1. Exact implementation paths

Paths are relative to `/home/ulrik/version-control/projects/fitness-app`.
The observed host baseline remains
`a888010f17b4df6c646e19b5f169c23fbdef5b5d`; it is not the integration base.
Use the existing frontend package, abbreviated P in this document:
`apps/frontends/fitnessapp-pwa-frontend`.

| Paths | Purpose |
|---|---|
| `.agents/sdlc-host.json` | Register qualified adapters in profile 1.4.0; preserve legacy behavior and existing host policies |
| `.agents/workflows/roles/critic-reviewer.json` | Host override: two physical attempts, one retry, zero failovers; preserve other role fields |
| `tools/acceptance-evidence/unit-adapter.mjs` | Vitest request validation, exact selection and report normalization |
| `tools/acceptance-evidence/browser-adapter.mjs` | Playwright selection, native capability reporting and owned-server cleanup |
| `tools/acceptance-evidence/protocol.mjs` | Shared strict engine-wire validation and canonical identity/hash helpers |
| `tools/acceptance-evidence/pretest.mjs` | Frozen equivalent of gateway-client freshness and a11y ESLint checks |
| `tools/acceptance-evidence/runtime.mjs` | Offline closure materialization, safe import resolution, file hashing and verification |
| `tools/acceptance-evidence/qualify.mjs` | Provider-free corpus and process/containment probes |
| `tools/acceptance-evidence/admission.mjs` | Assemble and verify admission artifacts; fail closed on missing values |
| `tools/acceptance-evidence/experiment-governor.mjs` | Shared all-role reservations, split token limits, priced spend and durable reconciliation |
| `tools/acceptance-evidence/supervisor.mjs` | Persistent experiment deadline, owned-process shutdown and guarded CLI entrypoint |
| `tools/acceptance-evidence/adapter.spec.mjs` | Wire/normalization/identity and real-child cleanup regressions |
| `tools/acceptance-evidence/admission.spec.mjs` | Missing bindings, source drift, artifact limits and legacy-profile regressions |
| `tools/acceptance-evidence/experiment.spec.mjs` | Concurrent reservations, uncertain charges, multi-run caps, pause/restart/deadline regressions |
| `tools/acceptance-evidence/runtime.sources.json` | Audited installed source roots and provenance; no credentials |
| `tools/acceptance-evidence/corpus.json` | Citation-free independent expected outcomes and fixture recipes |
| `tools/acceptance-evidence/canary.plan.json` | Test-only task topology and stable case identities; no landed canary tests |
| `tools/acceptance-evidence/README.md` | Operator commands, packaging constraints and explicit approval boundaries |
| `P/vitest.canary.config.ts` | Dedicated config, no implicit retries, only frozen case files |
| `P/playwright.canary.config.ts` | Dedicated Chromium config, one worker, no retries/server reuse |
| `.gitignore` | Ignore only the generated runtime and evidence directories listed below |

Closed edit list; revise before adding files. Each file: <=500 lines/20,480 bytes.
Do not edit ordinary configs/scripts/tests, product code, dependency manifests,
lockfile, generated gateway client or baselines. Add no canary `@ac` citations.

Generated, protected, untracked paths:

| Prefix | Ownership |
|---|---|
| `tools/acceptance-evidence/runtime/` | Vendored regular-file runtime; immutable during execution |
| `tools/.acceptance-evidence/canary-v1/` | Manifests, prepared builds, reports, experiment ledger and stop evidence |

Runtime assets stay uncommitted. Finalize manifests after the integration commit
to avoid self-reference. Admission is a reviewed sidecar outside its own closure.
Prepared output binds the exact tree/config; revalidate before reuse.

### Disposable model-edit paths

Only these new files under P may be in a live envelope:

```text
src/test/acceptance-canary/fixtures.ts
src/test/acceptance-canary/session-sources.spec.tsx
e2e/acceptance-canary/session-sources.spec.ts
```

Use full paths in envelopes, not entire test directories or P. Only disposable
runs create these files/citations, under their approved specs/task plans.

Seed defects through disposable fixtures, not landed code. Prove native behavior
breaks, not an unrelated assertion. If impossible within these paths, seek scope
revision; do not silently allow product edits.

## 2. Packaging and preparation

Vendor installed dependencies offline. **Install/download list: empty.**
Missing runtime components require separate approval and provenance.
Approved extensions: authorization-bound `checkpointHydration` and hash-bound
`dependencyManifest` (`{path, sha256}`) registrations. The latter references closed
`{schemaVersion:"1.0.0",files:[{path,sha256}]}` JSON (20 MiB, 100,000 files maximum).
Verify every regular-file hash before/after execution and reuse; never truncate
the closure into inline admission limits. Frozen inputs grant read access only,
not model write scope. Preserve legacy behavior. No Git/provider approval implied.

Use the canonical Node executable observed during inspection:

```text
/home/ulrik/.local/opt/node-v22.23.4-linux-x64/bin/node
```

Qualify its bytes/mode/path; do not register `/home/ulrik/.local/bin/node`.

`runtime.mjs` must copy regular files from audited installed sources into a
self-contained namespace below `tools/acceptance-evidence/runtime/`. It may
resolve source symlinks during offline preparation only when the source inventory
explicitly permits their targets. Destination symlinks and runtime store/cache
lookups are forbidden. Preserve package resolution using real directories;
rewrites, if needed, are part of the frozen, inspected generated bundle.

Inventory includes Vitest, Playwright, Chromium, Vite, TypeScript, ESLint/plugins,
OpenAPI generator, React/application dependencies, fonts/native libraries,
runner configs, fixture/setup inputs, frontend build inputs and every executed
helper. Record source versions/licenses and destination hashes. Audit native
loader/library paths, browser subprocesses and runtime file access; a copied
Chromium binary alone is not a qualified browser closure. No silent reliance on
host shared libraries outside the approved executable/runtime exceptions.

The existing gateway check selects `node_modules/.bin/openapi-typescript`, then
can fall back to PATH. Do not run that unresolved path in a qualified adapter.
`pretest.mjs` must preserve the same OpenAPI regeneration byte comparison and
index-file existence check using the frozen generator, plus the same a11y ESLint
scope/configuration. Validate equivalence against the existing check offline.
It must not rewrite the generated client. Copying/checking the backend OpenAPI
input is read-only and does not authorize backend edits.

Use a pinned loopback address `127.0.0.1:4173`, strict port acquisition and no
server reuse. Collision blocks; never stop an existing server. A browser adapter
owns build/server/browser teardown within its 300-second timeout. Subsequent
invocations may reuse prepared output only if candidate/preparation hashes match.
Launch browser with its explicit vendored executable path, not auto-discovery.

## 3. Exact proposed command interfaces

Cwd is host root. Recheck cleanliness/HEAD first. `NODE` means the canonical path
above; substitute it literally in approved argv. Adapter dispatch uses no shell.

Provider-free implementation/qualification commands:

```bash
git status --porcelain=v1
git rev-parse HEAD

NODE --test tools/acceptance-evidence/adapter.spec.mjs \
  tools/acceptance-evidence/admission.spec.mjs \
  tools/acceptance-evidence/experiment.spec.mjs

NODE tools/acceptance-evidence/runtime.mjs inventory \
  --sources tools/acceptance-evidence/runtime.sources.json \
  --output tools/.acceptance-evidence/canary-v1/runtime.inventory.json

NODE tools/acceptance-evidence/runtime.mjs materialize \
  --inventory tools/.acceptance-evidence/canary-v1/runtime.inventory.json \
  --destination tools/acceptance-evidence/runtime

NODE tools/acceptance-evidence/qualify.mjs \
  --corpus tools/acceptance-evidence/corpus.json \
  --inventory tools/.acceptance-evidence/canary-v1/runtime.inventory.json \
  --output tools/.acceptance-evidence/canary-v1/offline-qualification.json

pnpm run agent:preflight

NODE tools/acceptance-evidence/admission.mjs assemble \
  --proposal tools/.acceptance-evidence/canary-v1/proposal.json \
  --output tools/.acceptance-evidence/canary-v1/admission.json

NODE tools/acceptance-evidence/admission.mjs verify \
  --manifest tools/.acceptance-evidence/canary-v1/admission.json
```

`inventory` writes only its output; review its hash before `materialize` creates
the runtime. Reject unexpected bytes, runtime discovery and downloads. Qualify
with the same hashed Node/vendored binaries; no hidden `pnpm exec` resolution.
Canonical preflight keeps the host toolchain; record its closure/argv separately.
Adapter qualification does not qualify preflight.

Adapter registrations use precisely:

```json
{
  "unitArgv": [
    "/home/ulrik/.local/opt/node-v22.23.4-linux-x64/bin/node",
    "tools/acceptance-evidence/unit-adapter.mjs"
  ],
  "browserArgv": [
    "/home/ulrik/.local/opt/node-v22.23.4-linux-x64/bin/node",
    "tools/acceptance-evidence/browser-adapter.mjs"
  ]
}
```

Both consume the stdin request and return the engine report schema. Freeze child
argv/cwd/environment too. Config selection is fixed in adapter bytes, not
model-controlled. These two argv arrays alone do not qualify dependencies.

Proposed guarded live interfaces, **not allowed before separate live approval**:

```bash
NODE tools/acceptance-evidence/supervisor.mjs begin \
  --manifest tools/.acceptance-evidence/canary-v1/admission.json

NODE tools/acceptance-evidence/supervisor.mjs shell \
  --experiment tools/.acceptance-evidence/canary-v1/admission.json \
  --scenario healthy -- start

NODE tools/acceptance-evidence/supervisor.mjs shell \
  --experiment tools/.acceptance-evidence/canary-v1/admission.json \
  --scenario healthy -- watch
```

Map scenarios to frozen specs/plans/run IDs. Preserve shell brief confirmation,
authorization and explicit response files; `watch` follows continuations.
Every nested `runCliFn` must retain the guarded governor; never launch a default
unguarded CLI. Replacement runs need new admission. Preserve read-only status
and bounded cancellation after exhaustion.

## 4. Shared controller: implementation prerequisite

Use one dedicated governor `stateRoot` for the whole experiment. Freeze the full
resolved policy, not only a local-policy delta; local policy may only narrow.
Existing governor fields suitable for aggregate caps are:

```json
{
  "instance": {
    "maxPhysicalCalls": 80,
    "maxTotalTokens": 2080000,
    "maxCostMicrousd": 20000000,
    "maxConcurrentReservations": 1
  }
}
```

USD 20 is the approved proposed ceiling; live approval and enforcement proof
remain required. Freeze premium-unit limits; unknown pricing blocks admission.
All applicable profile/run limits must be no greater than the allocated subcaps.
Do not change committed governor defaults. Verify the dedicated ledger starts
empty and that instance caps actually span the participating run IDs.

The host `experiment-governor.mjs` wraps `RepositoryModelGovernor`, not provider
transports. It atomically reserves calls, separate input/output tokens and
worst-case priced spend before every logical dispatch, across every role/run.
It must expose/forward availability, assessment, execution and accounting APIs
required by the engine. Reservation assessment alone does not reserve anything.
Keep original run/operation IDs; do not alias IDs to fake shared accounting.
Finalize from terminal governor usage records, or debit the full reservation
when completion is unprovable. Never release an uncertain charge on restart.

Start one persistent 5,400,000-ms clock on first live action, including semantic
qualification. Pauses/restarts/new IDs never reset it. Gate model/evidence launches;
stop owned active work at deadline. Reconcile pending charges before restart
dispatch; reject clock/ledger rollback. A sleeping process alone is insufficient.

Clock/usage reservations, adapter resource controls, process shutdown and
artifact quotas require offline boundary probes and retained passing artifacts.
Process groups do not contain `setsid` escape. Admission must prove this frozen
closure excludes escape or bind a separately approved external containment unit.
No claim of hard remote-provider cancellation: reserve the whole in-flight
allowance and account for usage that may arrive after local termination.
Do not add raw provider calls or credentials to host helpers.

## 5. Frozen live manifest proposal

Store the eventual JSON as
`tools/.acceptance-evidence/canary-v1/admission.json`, outside model scope.
YAML below proposes the host tool's required inputs, not an engine wire schema.
Sidecars need path, byte hash and strict schema version, not bare paths.
Binding nulls require generated/approved records.

```yaml
manifestVersion: fitness-app-canary-admission-v1
admission: BLOCKED
experimentId: fitness-app-acceptance-evidence-v1
hostRoot: /home/ulrik/version-control/projects/fitness-app
repositoryId: fitness-app
engineCommit: 4f5c1040377c4f7db6db8efcb250e3e845743976
observedHostCommit: a888010f17b4df6c646e19b5f169c23fbdef5b5d
integrationBaseCommit: null
integrationPreflightReceipt: null
implementationApprovalReceipt: null
liveApprovalReceipt: null
installationCommands: []
downloadsAllowed: false
runtimePackaging: vendored-repository-relative-regular-files
nodeExecutable: /home/ulrik/.local/opt/node-v22.23.4-linux-x64/bin/node
bindings:
  engineBuildAndDependencies: null
  nodeExecutableSha256: null
  hostProfile: null
  runtimeInventory: null
  adapterRegistrations: null
  pretestEquivalenceReceipt: null
  canonicalPreflightClosure: null
  candidatePreparationManifests: null
  corpusAndExpectedOutcomes: null
  offlineQualificationReceipt: null
  semanticQualificationPackets: null
  caseIdentityMap: null
  approvedRunSpecsAndTaskPlans: null
  resolvedGovernorPolicyAndRoutes: null
  resolvedRoleDefinitions: null
  promptFitMeasurements: null
  routePricesAndReservationInventory: null
  controllerAndContainmentReceipts: null
  allowedCommandsAndEnvironment: null
  artifactOwnershipAndRetention: null
  runAuthorizations: null
shared:
  maxPhysicalCalls: 80
  maxInputTokens: 1600000
  maxOutputTokens: 480000
  maxCostMicrousd: 20000000
  maxElapsedMs: 5400000
  startsAt: null
  deadline: null
  governorStateRoot: tools/.acceptance-evidence/canary-v1/governor
  reservationLedger: tools/.acceptance-evidence/canary-v1/experiment.sqlite
  unknownUsage: charge-full-reservation
  concurrency: 1
qualityPolicy:
  schemaVersion: 1.0.0
  policyId: checkpoint-evidence-v1
  additionalCandidateReviews: 1
  followUpDispatches: 1
  testRetryPolicy: clean-success
  retrieval:
    maxPacketBytes: 24576
    maxPacketLines: 1000
    maxTotalBytesPerCandidate: 49152
    maxTotalLinesPerCandidate: 2000
  execution:
    maxInvocations: 48
    maxTotalDurationMs: 1800000
  review:
    maxLogicalDispatches: 12
    maxPhysicalCalls: 24
    maxInputTokens: 480000
    maxOutputTokens: 144000
criticLimits:
  maxPromptTokens: 20000
  maxCompletionTokens: 6000
  maxPhysicalAttempts: 2
  maxRetriesPerRoute: 1
  maxFailovers: 0
otherRoleLimits:
  maxPromptTokens: 20000
  maxCompletionTokens: 6000
  maxPhysicalAttempts: 1
  maxRetriesPerRoute: 0
  maxFailovers: 0
adapterLimits:
  unitTimeoutMs: 120000
  browserTimeoutMs: 300000
  maxReportBytes: 1048576
  maxArtifactBytes: 16777216
  maxArtifacts: 8
allowedPackages:
  - apps/frontends/fitnessapp-pwa-frontend
allowedPathPrefixes:
  - apps/frontends/fitnessapp-pwa-frontend/src/test/acceptance-canary/fixtures.ts
  - apps/frontends/fitnessapp-pwa-frontend/src/test/acceptance-canary/session-sources.spec.tsx
  - apps/frontends/fitnessapp-pwa-frontend/e2e/acceptance-canary/session-sources.spec.ts
allowedOperations:
  editIsolatedWorktree: true
  runAllowlistedCommands: true
  createDetachedWorktree: true
  createBranch: false
  createLocalCommits: false
  push: false
  openPullRequest: false
  merge: false
  deploy: false
targetBranch: null
maxSemanticRepairs: 2
correctionPreauthorized: false
internalSnapshotObjectsAllowed: true
stopOn:
  - quality-interrupt
  - deterministic-failure
  - resource-exhaustion
  - READY_FOR_GIT_APPROVAL
mergeCanary: false
```

Validate adapter registrations and run authorizations with their engine schemas.
Include qualified profiles, all file hashes, hashed argv, qualification, actual
run ID, approved spec/plan/preparation, approval times, expiry, model profile and
authorized quality plan. Never pass this aggregate manifest to `authorize`.

Freeze routes/models/vendors/prices, with a different-vendor critic for each
author context. Unknown/same-vendor review blocks. Provider availability grants
no approval. Full prompts for every role must fit without truncation.

### Shared suballocations and dispatch inventory

The following reservations sum exactly to the proposed shared ceiling. They are
caps, not a guarantee of reaching all observations. All rows reserve at most
20,000 input/6,000 output tokens per physical attempt. Monetary subcaps sum to
USD 20 and must pass route-specific worst-case pricing before admission.

| Scenario | Physical calls: non-QA + QA | Input/output tokens | USD |
|---|---|---|---|
| Semantic qualification | 0 + 16 | 320,000 / 96,000 | 4 |
| Healthy, with controlled restart | 12 + 12 | 480,000 / 144,000 | 6 |
| Picker defect | 12 + 4 | 320,000 / 96,000 | 4 |
| Focus defect | 12 + 4 | 320,000 / 96,000 | 4 |
| Failed-coverage restart | 8 + 0 | 160,000 / 48,000 | 2 |

Each run keeps S=2/R=1/F=1 and the engine's minimum 12 logical QA ceiling; the
shared controller imposes the stricter row allowance. Healthy QA's 12 physical
calls allow at most six two-attempt dispatches, not all twelve logical slots.
Picker/focus QA allow two such dispatches; coverage-negative must fail before
first QA. Qualification allows eight two-attempt reviews. Interruptions and
uncertain completions consume these same allocations.

Freeze an itemized dispatch inventory in the priced binding: each specifier,
planner, spec/plan critic, implementer step, QA, follow-up, possible retry and
optional correction must name its allowance. Non-QA rows are hard step budgets,
not twelve promised tasks or repairs. If the required graph cannot fit, narrow
the experiment or seek revised approval before launch. Do not borrow between rows
or refill on a new run ID. Correction is optional and fits remaining resources
only after a separate candidate-bound answer; otherwise it is explicitly untested.

Healthy restart observes a durable mechanical boundary. The separate coverage
negative restarts after recording failed coverage and proves QA never dispatches.
Both require one documented controlled restart, not an automatic retry loop.
Failure of either observation blocks qualification.

## 6. Completion rule

`admission.mjs verify` must reject unresolved bindings, missing approval, stale SHA/hash,
unpriced route, unrepresentable closure, oversized prompt, unqualified capability,
unproven controller, or inventory exceeding any cap. The pre-live manifest binds
expected outcomes and all permitted future actions; it does not fabricate future
semantic results. `begin` atomically seals start/deadline and authorized run IDs
in a linked activation record. Semantic qualification must pass before run start.
The first genuine blocker ends the relevant scenario without relaxing its gate.
Produce a final results manifest retaining failed/inconclusive observations.

The next approval can cover the closed implementation list and provider-free
commands only. Git establishment of the integration base, live spend/activation,
correction, delivery and host-main adoption remain distinct decisions.
