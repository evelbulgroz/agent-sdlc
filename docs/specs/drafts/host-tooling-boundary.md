# Host tooling boundary and config contract

Status: draft for approval. Owner: engine maintainers. Evidence base: `files/inventory/host-tooling-inventory.md` (fitness-app `b7b2c1ea`, engine `d752329`). Step 2 of the plan to make a second-host test meaningful.

## Goal

Move the generic acceptance-evidence and SDLC process tooling out of the reference host into this package, so that a host consists of configuration, a case manifest and its own quality policy. A second host can then be onboarded without copying or editing engine-grade code.

## Non-goals

- No change to the run authorization envelope, the critic protocol, admission semantics, or the evidence wire contract.
- No move of host quality policy (`tools/quality/`) or fitness-app product scripts.
- No weakening of any pin, hash or invariant. Pins change owner and path, not strength.
- No second-host run in this effort. That follows when the boundary is proven.

## Principles

1. **Mechanism in the engine, policy in the host.** A file moves when it contains no host literal after parameterization. Rules, thresholds and case lists stay in the host.
2. **One config surface.** The engine reads `.agents/sdlc-host.json` and files it names. Nothing else crosses the boundary. Hosts do not import engine internals, and the engine does not import host files.
3. **Fail closed on missing config.** A missing or malformed `acceptanceEvidence` block disables the acceptance-evidence path with a typed error. It never falls back to fitness-app defaults.
4. **Same behaviour first.** Each move is a refactor that must leave the 4-task canary at 7/7 with no timing regression before any new capability is added.
5. **Package ceilings apply to moved files.** Every file stays at 500 lines and 20,480 bytes. No relative import leaves the package root.

## The boundary

| Owner | Contents |
|---|---|
| Engine (new module) | admission, experiment budget and governor, supervisor, recipe and evidence brokers, bin shims, prepare-files, preflight bridge, live records and live-run, offline receipt, prompt-fit, governor resolution, role definitions, readiness, qualify, runtime and pretest, the pnpm verify-bootstrap chain, `atomic-file-state`, telemetry and status validators, plus their specs |
| Engine (new capability) | an adapter conformance suite and a reference adapter (fixture host); no runner knowledge |
| Host (adapters) | `unit-adapter`, `browser-adapter`, their specs, and the vitest and playwright specifics of `canary-execution` and `registrations`; hash-pinned as today |
| Host (config and data) | `.agents/sdlc-host.json` and its `acceptanceEvidence` block, the case manifest, the runner config files, `runtime.sources.json`, the canary spec and task plan, `canary-v1/` evidence (gitignored) |
| Host (policy) | everything in `tools/quality/`, security config, product scripts, CI, hooks, one-off migration scripts |
| Deleted | `canonical-workspace.mjs` and its spec (dead per `docs/backlog.md`) |

## Config contract: `sdlc-host.json` `1.5.0`

`1.5.0` adds one optional block. Profiles at `1.4.0` still load unchanged, and decode with `acceptanceEvidence` absent. The block is closed: unknown keys fail validation.

```json
{
  "schemaVersion": "1.5.0",
  "acceptanceEvidence": {
    "canaryId": "canary-v1",
    "slug": "healthy",
    "evidenceDir": "tools/.acceptance-evidence",
    "caseManifest": "tools/acceptance-evidence/cases.json",
    "runtimeSources": "tools/acceptance-evidence/runtime.sources.json",
    "package": { "root": "apps/frontends/example-pwa", "openApiPath": "apps/services/api-gateway/openapi/api-gateway.openapi.json" },
    "sandbox": { "readOnlyBinds": ["src", "public", "e2e", "package.json", "index.html", "tsconfig.json"] },
    "runners": {
      "unit": { "plugin": "vitest", "config": "vitest.canary.config.ts" },
      "browser": { "plugin": "playwright", "config": "playwright.canary.config.ts", "project": "chromium" }
    }
  }
}
```

Mapping from today's literals:

| Literal today | Becomes |
|---|---|
| `PACKAGE` in `protocol.mjs` | `package.root` |
| api-gateway OpenAPI path | `package.openApiPath` (optional) |
| bind list in `protocol.mjs` | `sandbox.readOnlyBinds` |
| `CASES` in `run-authorization.mjs` | `caseManifest` (same tuple fields, JSON) |
| `vitest.canary.config.ts`, `playwright.canary.config.ts` | `runners.*.config` |
| `fitness-app-canary-admission-v1`, `repositoryId`, `experimentId` | derived from `profileId` and `canaryId` |
| `fitness-canary-healthy` run slug | `slug` (with the date prefix as today) |
| adapter id `fitness-app-<kind>` | `<profileId>-<kind>` |

`agent-sdlc host check` validates the block, resolves every named path inside the repository, and refuses symlink escapes with the existing path-containment guards.

## Adapter command interface (decided 2026-11-07)

The engine has no runner knowledge and no test-runner dependency. The host supplies adapter commands; the engine runs them under the existing frozen-adapter rules (absolute `argv[0]` plus `executableSha256`, hashed `bundleFiles`, qualification artifact, sandbox) and validates only the wire-contract result.

`runners` therefore has no `plugin` field. Each entry names an adapter command:

```json
"runners": {
  "unit": { "argv": ["/abs/node", "tools/acceptance-evidence/unit-adapter.mjs"], "bundleFiles": ["vitest.canary.config.ts"] },
  "browser": { "argv": ["/abs/node", "tools/acceptance-evidence/browser-adapter.mjs"], "bundleFiles": ["playwright.canary.config.ts"] }
}
```

- The engine ships `acceptance/conformance.spec.mjs`, run against any adapter, and a trivial reference adapter in the fixture host. They define what an adapter must emit and refuse.
- Trust rests on the pins, the sandbox, schema validation, `@ac` citation checks and the invariant checker, not on engine-owned parsers. A bad pinned adapter is a host fault and is auditable.
- A host edit to an adapter still forces a manifest rebuild and admission regeneration, as today.

## Pins after the move

- Engine-owned files are already covered by the engine commit that admission pins. They leave the host `execution.json` list, which keeps only host-owned files: adapters, the case manifest, runner configs, runtime sources and lockfile-derived dependency manifests.
- Symlink aliases and relative names still fail closed, as the frozen executable rule requires today.
- Consequence: host adapter or config edits force regeneration as now; an engine change forces it as today. Slices that touch only engine files still require regeneration, so S2 to S4 are verified against the fixture host and admission is regenerated at S6.

## Migration slices

Each slice ends with the done bar (`build`, `typecheck`, `test:unit`, `reliability replay`), the relocated specs green, and a recorded line and byte check. Commits and pushes need your approval each time.

| Slice | Content | Gate |
|---|---|---|
| S0 | Delete dead `canonical-workspace.mjs` and spec; remove `learn.mjs` if the native store is a superset (diff first) | host specs green; no references remain |
| S1 | Add `acceptanceEvidence` schema, `1.5.0` loader, legacy `1.4.0` decoding, `host check` | schema and loader specs, including a negative spec per closed key |
| S2 | Move generic modules with literals replaced by config; host `protocol.mjs` shrinks to a config reader | relocated specs plus the fixture host (S5) |
| S3 | Adapter conformance suite and reference adapter | suite passes the reference adapter and fails seeded bad adapters |
| S4 | Admission literals from `profileId` and `canaryId`; regenerate admission | `admission verify` plus the S6 canary |
| S5 | Fixture host in the engine repo with a one-file canary so the evidence path runs without fitness-app | engine suite passes standalone |
| S6 | Strip fitness-app to config and data; rebuild manifest; regenerate admission | one 4-task canary: `READY_FOR_GIT_APPROVAL`, 7/7, run time within 10% of 1,470 s |

S5 can start after S1 and is the safety net for S2 to S4. If S6 fails, revert the host commit; the engine slices stay.

## Risks

- **Pin churn.** Admission regeneration is mechanical but costs about 15 minutes each time. S2 to S4 should be developed against the fixture host, with admission regenerated once, at S6.
- **Hidden coupling.** The inventory counts text hits, not behaviour. The relocated specs and the fixture host are the check. Any spec that needs fitness-app data stays in the host and is listed in the S6 note.
- **Sandbox bind list.** `protocol.mjs` builds a bubblewrap argv from PWA file names. Making it config-driven touches the isolation boundary. It needs a negative spec for an escape attempt (`../`, absolute path, symlink) before S2 merges.
- **Size ceilings.** `experiment-governor` (429 lines), `qualify` (305) and `supervisor` (314) are under the line cap. Byte counts must be checked per file before the move.
- **Timing.** The recent run-time gains came from worker pools and native realpath in these files. A move must not change them; S6 compares span totals against run 11.

## Acceptance

- `grep` for fitness-app literals in the moved modules returns nothing, and `host-neutrality.spec.mjs` covers the new module with no new exemptions.
- fitness-app `tools/acceptance-evidence/` holds only data files and a short README.
- A second host needs `sdlc-host.json`, a case manifest and runner configs. That is the test for the second-host step.

## Decisions (2026-11-07)

- Same package, new `acceptance/` module.
- Bump to `1.5.0` now with an optional `acceptanceEvidence` block.
- `learn.mjs`: diff against the native store, then remove in S0.
- S6 timing tolerance: 20% of run 11 (1,470 s).
- Runner plugins: rejected. Hosts supply adapter commands; the engine has no runner knowledge (see Adapter command interface).
- Rollback: every slice is its own commit with a green done bar, so any regression is reverted by one `git revert`. Engine and host commits stay separate.

## Open questions (original wording)

1. Same package or sibling? This draft proposes the same package under a new `acceptance/` module. A sibling package gives a lighter engine install but needs a stable export surface and its own release cycle, while the governor release is still pending.
2. Is `1.5.0` the right version bump, or should this wait to batch with other schema changes?
3. Should `learn.mjs` be removed in S0, or kept as a host adapter for a transition?
4. Is the bundled-plugin rule acceptable, or does a second host need host-supplied runner code in the near term?
5. Is the 10% timing tolerance for S6 right?
