# Intent

Status: draft, written 2026-11-09. Not approved for implementation. An engine run waits until the operator approves one priority and a task plan for that priority. The headings match `workflow/specification.ts`.

## Goal

The operator asked to audit this repository for plain JavaScript source files that would benefit either human or agent developers, and either the engine or a host, if those files gained strippable TypeScript type annotations, and to record the result as a prioritized list a spec can carry.

This draft is that list. A file qualifies when it is still plain JavaScript, when a human or an agent must get a structural contract right while editing or calling it, and when that contract serves the engine, a host, or both. The annotation form is the one this package already runs: Node.js type stripping on `>= 22.18`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, and explicit `.ts` extensions on relative imports. `tsconfig.json` includes `**/*.ts` only. `allowJs` and `checkJs` stay false.

Production modules outside `acceptance/` and the test helpers are already TypeScript. The gap is `acceptance/*.mjs` (41 modules, about 3,400 lines, no `@param` or `@typedef`) and the test helpers that already import `.ts`. Hosts run `node $AGENT_SDLC_PATH/acceptance/cli.mjs`. The same host block is already `AcceptanceEvidenceConfig` in `host/acceptance-evidence-schema.ts`, and command registrations are already `CommandRegistration` in `policy/contracts/quality-evidence-schema.ts`. The `.mjs` modules re-read those shapes with untyped parameters, so a bad field fails at admission or canary time.

## Non-goals

- Colocated `*.spec.mjs` stay JavaScript. That is 329 files and about 59,000 lines. `pnpm run test:unit` keeps the glob `**/*.spec.mjs`.
- The Tier A host fixture stays plain JavaScript: `testing/fixture-host-tier-a/pkg/cases.test.mjs`, `testing/fixture-host-tier-a/pkg/sentinel.test.mjs`, and `testing/fixture-host/verify.mjs`.
- Qualification oracles stay plain JavaScript: `testing/qualification/mutation-oracle-core.mjs`, `testing/qualification/round-half-away-oracle.mjs`, and `testing/qualification/wrap-index-oracle.mjs`.
- Pins stay plain JavaScript: `testing/no-network-preload.mjs`, `testing/fixture-monorepo-root.mjs`, `testing/use-fixture-monorepo.mjs`, and the re-export barrel `testing/test-support.mjs`.
- `testing/navigability-support.mjs` keeps its JSDoc. Touch it only to count renamed acceptance files.
- `testing/legacy-store-schemas.mjs` stays plain JavaScript. It is 449 lines and 15,464 bytes, and annotations would cross 20,480 bytes. `testing/crash-fixture-runner.mjs` stays plain JavaScript.
- `dist/**` and `tools/.agent-sdlc/**` stay out of scope.
- `allowJs` and `checkJs` stay off. Selected files are renamed to `.ts` so the existing include picks them up.
- Sandbox-imported modules gain no new runtime dependency: `acceptance/primitives.mjs`, `acceptance/config.mjs`, `acceptance/sandbox.mjs`, and `acceptance/report-formats.mjs`. Annotations and `import type` only. The local Zod parse already in `report-formats.mjs` stays.
- Emitted JSON, thrown messages, command names, and fail-closed checks stay as they are. A type error that the current object does not match an existing schema stops the slice for a report. The slice does not reshape the object to silence the error.
- `package.json` `exports` stay `./agent-status-validate` and `./auto-prune`.

## Owning context

`acceptance/` for priorities P0, P1, and P2. `testing/` and `host/evidence-port-fixture.mjs` for P3. The build copy is the `acceptance` `cpSync` in `package.json`. Typecheck is `tsconfig.json`. Emit is `tsconfig.build.json`.

## Touched surfaces

Implement in this order. A later priority uses types from an earlier one.

P0, the host contract the engine already types elsewhere:

- `acceptance/config.mjs`. `acceptanceConfig` takes the loaded profile slice (`AcceptanceEvidenceConfig` via `import type`) and returns a new frozen `AcceptanceConfig`. It does not return `AcceptanceEvidenceConfig`, because the resolver flattens paths, node, and repository fields.
- `acceptance/report-formats.mjs`. Export the case-row type, the outcome union, the format union (`junit`, `case-report`), and the `EvidenceReportError` code union. `CaseReportSchema` stays the runtime parse.
- `acceptance/command-evidence.mjs`, `acceptance/command-qualification.mjs`, and `acceptance/command-admission.mjs`. Registration values are typed as `CommandRegistration`.
- `acceptance/run-authorization.mjs` and `acceptance/contracts.mjs`. `import type` from the contract module. `engineModule('policy/contracts')` stays the runtime load.
- `acceptance/cli.mjs`. Handler context `{ root, config, argv }` and the `COMMANDS` name union.

P1, admission and canary artifacts:

- `acceptance/admission.mjs`, `acceptance/admission-proposal.mjs`, `acceptance/admission-records.mjs`, `acceptance/artifacts.mjs`, `acceptance/readiness.mjs`, `acceptance/registrations.mjs`, and `acceptance/regenerate.mjs`. Manifest, proposal, the six admission records, the artifact-name union, and the readiness state union (`missing`, `unpassed`, `present`, `no-producer`).
- `acceptance/experiment-budget.mjs`, `acceptance/experiment-config.mjs`, `acceptance/experiment-ledger.mjs`, `acceptance/experiment-governor.mjs`, and `acceptance/experiment-broker.mjs`. One `ExperimentConfiguration` type, owned by the budget module or a sibling file, covers validators, the ledger, the governor, and broker messages.
- `acceptance/runtime-inventory.mjs`, `acceptance/workspace-bootstrap.mjs`, `acceptance/supervisor-runner.mjs`, and `acceptance/prepare-files.mjs`. Inventory and bootstrap records (`path`, `sha256`, ELF interpreter, copy jobs).
- `acceptance/sandbox.mjs`, `acceptance/process.mjs`, `acceptance/supervisor.mjs`, `acceptance/supervisor-recipes.mjs`, `acceptance/live-run.mjs`, `acceptance/live-records.mjs`, and `acceptance/recipe-child.mjs`. Binds, owned-process options, guarded argv, and scenario bindings. `recipe-child` carries the parent message type.

P2, thin once P0 types exist. Annotate with the caller:

- `acceptance/primitives.mjs`, `acceptance/offline-receipt.mjs`, `acceptance/canary-execution.mjs`, `acceptance/preflight-bridge.mjs`, `acceptance/recipes.mjs`, `acceptance/bin-shims.mjs`, `acceptance/prompt-fit.mjs`, `acceptance/role-definitions.mjs`, and `acceptance/governor-resolution.mjs`.

P3, engine test helpers. They benefit engine developers. They are not a host runtime. `tsconfig.build.json` already excludes `testing/**`. `host/evidence-port-fixture.mjs` is imported only by `host/command-port.spec.mjs` and `host/evidence-port.spec.mjs`.

- `testing/test-support-fixtures.mjs`, `testing/test-support-cli.mjs`, `testing/test-support-governors.mjs`, `testing/cli-test-support.mjs`, `testing/graph-fixtures.mjs`, and `testing/task-planner-fixtures.mjs`.
- `testing/continuation-fixtures.mjs`, `testing/task-quality-fixture.mjs`, `testing/quality-test-support.mjs`, and `testing/command-registration-fixture.mjs`.
- `host/evidence-port-fixture.mjs`.
- `testing/minimal-executor-fixtures.mjs`, `testing/task-executor-fixtures.mjs`, `testing/reliability-fixtures.mjs`, `testing/recovery-fixtures.mjs`, `testing/shell-driver-support.mjs`, `testing/host-card-fixtures.mjs`, and `testing/fake-model-governor.mjs`.

Also update, in the slice that renames the files they name:

- The `acceptance` `cpSync` in `package.json`. `tsc` already emits `dist/acceptance` from `**/*.ts`. Drop the source copy so `.ts` sources are not published beside the emit.
- `acceptance/README.md`, which tells hosts to run `node $AGENT_SDLC_PATH/acceptance/cli.mjs` and describes the tree as plain `.mjs`.
- The `new URL('./recipe-child.mjs')` string in `acceptance/supervisor-recipes.mjs`. `CONTROL_SPECS` in `acceptance/cli.mjs` keeps the `.spec.mjs` names.
- Spec import specifiers that follow a renamed module. Assertion text stays.

## Invariants and constraints

- Erasable syntax only. The source uses no enums, namespaces, or parameter properties.
- Each renamed file stays at or below 500 lines and 20,480 bytes. Measured free bytes on 2026-11-09: `runtime-inventory.mjs` 6,938, `workspace-bootstrap.mjs` 9,257, `cli.mjs` 9,880, `report-formats.mjs` 10,241, `experiment-ledger.mjs` 10,754. A shared alias file is the place for a type that would cross a ceiling.
- `import type` is erased. Sandbox children that re-enter these modules see no new runtime import from the annotations.
- Local `node acceptance/cli.ts` uses the existing type stripper. Published hosts run `dist/acceptance/cli.js`. `tsconfig.build.json` already sets `declaration` and `rewriteRelativeImportExtensions`.
- Acceptance specs stay `.mjs` and stay out of `dist`. The build exclude for `*.spec.mjs` remains.
- Priority order is the implementation order. Doing a later priority before its types exist is a change to this draft.
- Counts above exclude `node_modules`, `dist`, and `tools/.agent-sdlc`.

## Public contract impact

Command names and JSON artifact shapes stay. A host that runs the published package keeps a JavaScript entry at `dist/acceptance/cli.js`, with `dist/acceptance/cli.d.ts` beside it. A source checkout on Node.js `>= 22.18` runs `node acceptance/cli.ts`. No new `package.json` `exports` key. Hosts do not import these modules as a library. The type declarations are for a host `tsc` project and for engine agents editing the modules.

## Acceptance criteria

1. AC-01: The resolver is typed. Given a renamed acceptance/config.ts. Then acceptanceConfig accepts the loaded profile slice and returns frozen AcceptanceConfig.
2. AC-02: Report rows are typed. Given a renamed acceptance/report-formats.ts. Then callers see the row, outcome, format, and EvidenceReportError code types.
3. AC-03: Registrations keep their JSON. Given the command-evidence builder. Then its registration value is typed as CommandRegistration and the emitted object is unchanged.
4. AC-04: Authorization stays dynamically loaded. Given run-authorization.ts and contracts.ts. Then they import contract types by import type and still call engineModule for policy/contracts.
5. AC-05: The operator entry keeps its commands. Given acceptance/cli.ts. Then COMMANDS is a typed union and the command names are the names acceptance/README.md lists.
6. AC-06: Admission records are typed. Given the P1 admission modules. Then manifest, proposal, six records, artifact names, and readiness states typecheck.
7. AC-07: Experiment state shares one configuration type. Given the ledger, governor, and broker. Then each takes ExperimentConfiguration from the budget module or its sibling.
8. AC-08: Inventory annotations fit the ceiling. Given runtime-inventory.ts and workspace-bootstrap.ts. Then each file is at most 500 lines and 20480 bytes.
9. AC-09: Sandbox modules gain no runtime import. Given primitives, config, sandbox, and report-formats. Then their runtime import list is the list they had as mjs, plus report-formats keeping zod.
10. AC-10: P2 modules use the P0 types. Given the P2 file list. Then each parameter that is an AcceptanceConfig or a report row uses that type.
11. AC-11: Test helpers typecheck and stay unpublished. Given the P3 file list. Then pnpm run typecheck includes them and dist does not.
12. AC-12: Excluded files stay JavaScript. Given the non-goals list. Then each named pin, fixture, oracle, spec, and legacy schema still ends in mjs. Cases: AC-12.1: a colocated spec stays spec.mjs; AC-12.2: the tier A sentinel fixture stays test.mjs; AC-12.3: the three qualification oracles stay mjs.
13. AC-13: The published entry is emitted JavaScript. Given pnpm run build. Then dist/acceptance/cli.js and dist/acceptance/cli.d.ts exist and dist/acceptance contains no copied mjs program.
14. AC-14: The typecheck program stays TypeScript-only. Given tsconfig.json. Then allowJs is false and checkJs is false.
15. AC-15: Behavior specs stay green. Given the acceptance specs after import-specifier updates. Then pnpm run test:unit passes with the same assertions.

## Failure defenses

- A leftover `acceptance/cli.mjs` host instruction or a leftover `recipe-child.mjs` URL fails the acceptance specs and AC-05.
- An annotation that changes a thrown message or a JSON field fails the existing acceptance specs. Those specs change only their import specifiers.
- A file that crosses 500 lines or 20,480 bytes fails AC-08 for the tight files and the same measure for every other renamed file.
- A value import added to a sandbox-imported module fails AC-09.
- A builder object that does not match `CommandRegistration` stops that slice. The slice reports the mismatch and leaves the JSON alone.

## Verification plan

- For each approved priority, run `pnpm run build`, `pnpm run typecheck`, `pnpm run test:unit`, and `node cli/cli.ts reliability replay`.
- After P0, confirm `dist/acceptance/cli.js` and `dist/acceptance/cli.d.ts`, and confirm `dist/acceptance` has no program `.mjs`.
- After P0, confirm `acceptance/README.md` names `cli.ts` for a source checkout and `dist/acceptance/cli.js` for the published package.
- After P3, confirm `testing/**` is still excluded from `tsconfig.build.json` and that `host/evidence-port-fixture.ts` is imported only by the two host specs.
- Grep the non-goal paths and confirm they are still `.mjs`.

## Unresolved questions

_None_

## Assumptions

- The operator's request is the goal above. Benefit is judged for a human developer or an agent developer, and for the engine or a host. Files that serve neither side stay JavaScript.
- The 2026-11-09 counts are the baseline. An implementer remeasures a file before editing it.
- Node.js stays on `>= 22.18` with type stripping. `AcceptanceEvidenceConfig` and `CommandRegistration` stay the shared contracts.
- Operator approval of one priority is required before that priority is renamed. Approval of this draft does not approve a later priority.
- `host/evidence-port-fixture.mjs` has no production importer.
