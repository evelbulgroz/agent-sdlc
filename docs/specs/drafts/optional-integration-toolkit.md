
# Optional host integration toolkit

**Status:** Superseded by `single-config-host-onboarding.md` (implemented; now in `docs/specs/retired/`). Kept for reference.
**Type:** Reference.

## Approval gate

This draft does not treat the fitness-app canary as qualified. No qualification receipt was observed. The host file `tools/acceptance-evidence/README.md`, inspected on 2026-11-02, still says the tooling is not live-qualified. `qualify.mjs` returns `blocked`.

Implementation approval stays closed until an attached record supplies all four of these:

- engine commit
- corpus hash
- manifest hash
- whether experiment control was observed and is in v1

Until those values are in the record, the scope table is a candidate inventory of the host spike. It is not an observed-behavior list, and AC-01 through AC-06 are not approvable. A behavior the record does not show stays out of protocol `1.0.0`.

## Intent

After that gate opens, ship the observed mechanics as capabilities of the existing per-machine engine install. A host enables a capability with committed configuration. It does not take a library dependency, vendor toolkit source, or import engine modules.

The recommended deployment is one machine install plus `.agents/sdlc-host.json`. Client repositories do not declare this package. A per-project library, including a host import of an integration entry, is outside this design. A separate package waits on a release cycle this install cannot serve.

Moving the host spike `tools/acceptance-evidence/*.mjs` into the engine leaves the extraction debt in place and fails this spec. Engine wire, checkpoint, resolution, and quality-gate contracts stay authoritative.

## Candidate scope

| Candidate behavior | Current host module | Machine capability |
|---|---|---|
| Request and report framing, path and regular-file checks | `protocol.mjs` | `evidence` wire handling |
| Owned child process | `protocol.mjs` `executeOwned` | `evidence` process handling |
| Case selection by file and `caseKey` | `protocol.mjs` `caseSelections` | `evidence` case map |
| Vitest and Playwright report normalization | `unit-adapter.mjs`, `browser-adapter.mjs` | capabilities `vitest` and `playwright` |
| Closure inventory, materialize, verify | `runtime.mjs` | `agent-sdlc evidence inventory/materialize` |
| Fail-closed admission checks | `admission.mjs` | `agent-sdlc evidence admit` |
| Shared clock, reservation, uncertain charge | `experiment-governor.mjs` | `evidence` experiment control |

Experiment control is in v1 only when the attached record says the shared clock, cross-run reservation, uncertain full charge, and deadline stop were observed. Otherwise the command rejects that configuration.

The host keeps configuration and product inputs: repository id, package prefix, allowed paths, `stateDir`, case map, runner config paths, loopback host and port, worker count, server-reuse policy, preparation commands for product checks, corpus and canary plan while an experiment needs them, and the application's runner-closure inventory.

These stay engine core, checked in this revision:

- `executeEvidence` in `host/evidence-port.ts` spawns through `spawnEvidence` in `host/evidence-transport.ts`: absolute `argv[0]`, no shell, detached process group on Linux.
- `readEvidenceFile` and `verifyEvidenceRegistration` in `host/evidence-files.ts`: `realpath` must equal the path, `lstat` must not be a symlink, open uses `O_NOFOLLOW`, and `executableSha256` must match.
- `hydrateCheckpointWorktree` in `workflow/checkpoint-hydration.ts` calls the override's `prepare`, then rehashes every listed file with `readEvidenceFile`. It does not copy. A changed hash or a symlink fails. There is no install fallback.
- `RunAuthorizationEnvelope` remains the approval boundary. Task plan, QA, reconciliation, and the Git-approval boundary stay where they are.

The host `noInstallRunner` hardcodes the frontend package and `tools/.agent-sdlc`. The capability's `prepare` receives `stateDir`, package names, and the destination from the approved binding.

## Placement and snapshot

Source lives in `evidence/` and ships through the same clone-and-`pnpm link --global` install as `agent-sdlc`. The operator surface is `agent-sdlc evidence`. `package.json` `exports` gain no key. Hosts do not import the implementation.

`evidence/` uses both package ceilings, with no exemption: at most 500 lines and at most 20,480 bytes per file. The byte ceiling binds when it is reached first.

The capability may import `QualityPolicySchema` and `AdapterRegistrationSchema` from `policy/contracts/quality-schema.ts`, and `sha256` from `policy/contracts/primitives.ts`. It must not import the `policy/contracts.ts` barrel, `workflow/`, `cli/` orchestration, `execution/`, `persistence/`, or `adapters/model-governor.ts`. Host files must not import those contract modules either. One schema implementation serves the engine and the capability.

`pnpm link --global` installs a symlink. That symlink is only the process the operator launched. Qualify resolves it once and stores the real checkout:

1. `nodePath = realpath(process.execPath)`. `lstat(nodePath)` must be a regular file. Hash those bytes with `hashEvidenceBytes`.
2. `script = realpath(process.argv[1])`. `lstat(script)` must be a regular file.
3. Walk ancestors of `script`. A symlink ancestor fails. The first directory whose `package.json` name is `@evelbulgroz/agent-sdlc` is `installRoot`.
4. A path segment `.pnpm`, or a realpath inside the pnpm content-addressable store, fails. The linked git checkout is the accepted root. `git -C installRoot rev-parse HEAD` must succeed and become `engineCommit`.
5. Hash the closed relative list in `evidence/capability-files.json` through `readEvidenceFile`. A symlink in that list fails. The global shim path is not stored and is not an argv entry.

Snapshot copy, used by `prepare`, reads each source with `readEvidenceFile` and writes a new file with `O_NOFOLLOW` and `wx`. It does not copy a symlink and does not create one. `hydrateCheckpointWorktree` then rehashes the worktree files. Registration `argv[0]` is `nodePath`. `argv[1]` is the worktree copy of the capability script, listed in `bundleFiles`. Later changes to the global symlink are not followed.

`AGENT_SDLC_PATH` may still locate the checkout for existing hooks. Loading `$AGENT_SDLC_PATH/**/*.ts` fails qualification.

## Debt the interfaces replace

Inspected on 2026-11-02 under the fitness-app worktree `tools/acceptance-evidence/`. These literals and imports must not appear under `evidence/` except inside a `*.spec.mjs` assertion that expects rejection.

- `protocol.mjs` exports the fitness-app package, `tools/.acceptance-evidence/canary-v1`, `tools/acceptance-evidence/runtime`, and a home-directory Node path.
- `admission.mjs` requires repository id `fitness-app`, that Node path, one package, and three disposable test paths.
- `browser-adapter.mjs` fixes `127.0.0.1:4173`.
- `supervisor.mjs` joins `tools/.agent-sdlc`.
- `runtime.sources.json` lists absolute host, cache, font, and engine-checkout paths, and copies engine `.ts` sources plus zod.
- `engineContracts()` imports `$AGENT_SDLC_PATH/policy/contracts.ts`.
- `manifestVersion: fitness-app-canary-admission-v1` in the [admission proposal](fitness-app-canary-admission-proposal.md) is a host tool input. v1 has no decoder for it.

Published exports stay `./agent-status-validate` and `./auto-prune`.

## Host configuration

`host/host-profile.ts` sets `HOST_PROFILE_SCHEMA_VERSION` to `1.4.0`, previous `1.3.0`, and legacy `1.2.0`. `evidenceAdapters` is accepted only at `1.4.0`. The README onboarding example still shows `1.3.0`; the loader's current version is `1.4.0`.

`evidenceCapabilities` needs a new closed version, `1.5.0`. Decoders for `1.2.0`, `1.3.0`, and `1.4.0` stay as they are. A profile without the section does not select a capability. Approving the `1.5.0` schema is part of implementation approval and stays behind the qualification gate.

```text
evidenceCapabilities:
  schemaVersion: "1.0.0"
  capabilities: [{
    capabilityId: "vitest" | "playwright"
    protocolVersion: "1.0.0"
    packagePrefix: RelPath
    caseMap: RelPath
    runnerConfig: RelPath
    preparationCommands: string[][]
    browser: { host, port, workers, reuseExistingServer } | absent
    advertise: { layer, capabilities }
  }]
```

`preparationCommands` are argv arrays with no shell. `browser` is required for `playwright` and rejected for `vitest`. `reuseExistingServer: true` is rejected in protocol `1.0.0`. The committed section has no absolute machine path and no byte hash.

## Install record and trust

`qualify` writes no file. It prints canonical JSON: `installRoot`, `engineCommit`, `nodeExecutable` `{ path, sha256 }`, and the capability file hashes. The operator may store that JSON at `~/.config/agent-sdlc/evidence-install.json`. The path is a convention, not a trust root.

The operator binds `sha256` of those exact bytes into the `RunAuthorizationEnvelope` as `evidenceInstallHash` before a run. `admit` and spawn recompute the hash from the path named in the envelope. A mismatch, a missing hash, or a git-tracked copy of the record fails closed. Model write scope and `allowedPathPrefixes` exclude that path and `~/.config`.

A same-user process that can write the operator's home can also write this file. This spec does not claim otherwise. The fail-closed behavior covers an unapproved or drifted record and writes outside the authorized prefixes. It is the same local limit the envelope store already has. Critical rule 3 stays on the envelope: no approved hash, no capability execution.

## Execution manifest `1.0.0`

Schema id `integration-execution-manifest`. Closed object. `manifestHash` is `sha256` of the object without that field. `sha256(request)` remains the request hash used by `host/evidence-port.ts`.

Required fields: `schemaVersion` `"1.0.0"`, `manifestId`, `admission` `"BLOCKED"` or `"APPROVED"`, `repositoryId`, `hostRoot` equal to the invocation root realpath, `integrationBaseCommit`, `contract` `{ name, command: "evidence", protocolVersion, engineCommit }`, `nodeExecutable` copied from the approved install record, `downloadsAllowed: false`, `installationCommands: []`, `bindings` as `{ path, sha256, schemaVersion }`, `authorizationHashes`, `evidenceInstallHash`, and `manifestHash`.

The verifier parses `qualityPolicy` with the allowed `QualityPolicySchema` import and registrations with `AdapterRegistrationSchema`. A live check requires a clean worktree and `HEAD` equal to `integrationBaseCommit`. It does not compare identity fields with fitness-app literals.

`admission: APPROVED` requires bindings `qualityPolicy`, `runtimeInventory`, `adapterRegistrations`, `evidenceCapabilities`, `offlineQualificationReceipt`, `implementationApprovalReceipt`, and `liveApprovalReceipt`. `experimentControl` is required only when the approval record puts it in v1, and rejected otherwise. `fitness-app-canary-admission-v1` does not parse. The verifier writes no passing receipt of its own.

## Runtime closure, cases, and experiment control

Schema `integration-runtime-closure` `1.0.0` is host configuration: `allowedSourceRoots`, `entries` `{ source, destination, sha256, mode, provenance, license }`, optional `generatedFiles`, and `qualified`. Inventory hashes regular files. A source symlink may be followed only when its target stays inside `allowedSourceRoots`. Materialize uses the snapshot write above. An engine `.ts` source is rejected. The schema has no Chromium, Vitest, Vite, pnpm, or Node-layout fields. This install does not bundle the host's runners.

`CaseMapEntry` `1.0.0` is closed: `file`, `caseKey`, `kind`, `runnerTitle`, `capabilities`, optional `parameterId`. `packagePrefix` comes from the profile. Zero matches, multiple matches, a file outside the prefix, or a missing capability fails. `vitest` and `playwright` parse those runners' documents into the closed report. Hosts do not supply a parser.

Owned children use the evidence-port spawn rules. Limits come from the registration and the capability config. `setsid` escape remains outside the helper.

Schema `integration-experiment-control` `1.0.0`, when in v1, requires finite caps with no numeric default: `physicalCalls`, `inputTokens`, `outputTokens`, `costMicrousd`, `maxElapsedMs`, per-scenario subcaps, per-role prompt, completion, attempt, retry, and failover caps, and `maxAttemptCostMicrousd`. The canary ceilings are document values. The ledger keeps one configuration row, rejects a changed hash or clock rollback, and leaves an unprovable charge at the reserved amount. Recovery marks active rows `uncertain`. Linux `/proc` may identify the owner. Other platforms fail closed. The command calls the run's existing governor methods and does not construct `RepositoryModelGovernor`.

## Public contract and later host adoption

Additive CLI: `agent-sdlc evidence inventory`, `materialize`, `qualify`, and `admit`. Profile `1.5.0` is proposed and not yet approved. Exports and `bin` stay unchanged. `evidence/README.md` documents the commands, the profile section, and the install-record convention. Wire schema versions stay on their current objects. Generated `AdapterRegistration` values remain what the evidence port executes.

A later fitness-app approval deletes `tools/acceptance-evidence/` implementation modules, adds `evidenceCapabilities`, commits the case map, runner configs, and inventory, and expresses pretest as `preparationCommands`. The operator stores the qualify stdout and approves its hash. No package dependency and no decoder for the old manifest are added. Engine tests pass without that host edit.

## Non-goals

- A per-project library, a new package name, or a host dependency on this package.
- A public import surface, or a claim that `~/.config` authenticates itself.
- Bundling Chromium, Vitest, Playwright, or a host pretest.
- A second hash function, a copied zod schema, or a `policy/contracts.ts` barrel import.
- A decoder for the host-local admission manifest.
- Weaker citation rules, weaker baselines, a merged canary, or default rollout.
- Host edits, provider spend, installation, download, or a Git action under this draft.
- PATH rediscovery of the global shim during an admitted run.

## Acceptance criteria

1. AC-01: The admitted argv is the snapshotted real install. Given a global shim that is a symlink to a checkout of regular capability files, when qualify and admit run, then `installRoot` is that checkout, `argv[0]` is the real Node file, `argv[1]` is a regular worktree file, and the worktree hashes match. Given a realpath under `.pnpm`, qualify fails. Given a changed shim after admit, the run still uses the approved bytes.
2. AC-02: Host identity is configuration. Given a profile whose repository id, package prefix, port, and case map differ from the fitness-app spike, when admit runs, then it accepts that profile. Given the old manifest version or a committed absolute machine path, admit fails. The literal scan covers `evidence/` except `evidence/**/*.spec.mjs`. Those specs may quote `fitness-app`, `fitnessapp`, `/home/ulrik`, and `127.0.0.1:4173` only as rejected inputs, never as default paths.
3. AC-03: The host does not import engine source. Given an engine `.ts` closure entry, or a host import of this package or `policy/contracts.ts`, inventory or admit fails. A request hashed by the capability and by `host/evidence-port.ts` matches.
4. AC-04: Incomplete admission fails closed. A missing binding, hash drift, dirty live tree, `downloadsAllowed: true`, unknown capability, missing `evidenceInstallHash`, or unpriced in-v1 control fails and writes no passing receipt.
5. AC-05: Experiment caps come from the committed document. Two role rows narrow to their own values. Unprovable governor usage keeps the full reserved charge and the same deadline.
6. AC-06: Another repository enables the capability by configuration. Given a fixture whose `package.json` does not depend on this package, with its own prefix and case map, the named capability validates a report. The fixture contains no adapter implementation.

## Failure defenses

- Unknown versions, unknown fields, unknown capability ids, and symlink paths fail before copy or spawn.
- Live admit refuses a dirty tree, a mismatched base SHA, and an install hash that differs from the envelope.
- Snapshot writes use exclusive create.
- Recovery cannot release an active or uncertain reservation.
- The AC-02 scan uses the stated exemption and no other.
- `evidence/` files are checked against both size ceilings.
- A behavior missing from the attached record is not part of protocol `1.0.0`.

## Verification plan

- Colocated `evidence/**/*.spec.mjs` tests cite AC-01 through AC-06, including a symlinked shim, a `.pnpm` realpath, and a post-admit shim change.
- Run `pnpm run build`, `pnpm run typecheck`, `pnpm run test:unit`, and `node cli/cli.ts reliability replay`.
- `testing/package-shape.spec.mjs` still expects only `./agent-status-validate` and `./auto-prune`.
- A source scan asserts `evidence/` does not import `workflow/`, `cli/`, `execution/`, `persistence/`, `adapters/model-governor.ts`, or `policy/contracts.ts`.
- This package done bar does not run the fitness-app, a provider, or a live canary.

## Assumptions

- One machine install serves every host on that machine. A second consumer is more committed configuration.
- Linux/WSL is the qualified platform for process groups and `/proc` owner checks.
- The operator can store qualify output and approve its hash outside model write scope.

## Unresolved questions

- The qualification record is not attached. Engine commit, corpus hash, manifest hash, and experiment-control inclusion are undefined.
- The fitness-app adoption change is a later approval.
- Profile `1.5.0` stays a proposal until that record is attached and this draft is approved for implementation.
