Status: draft, not approved. Follows `retired/host-residual-engine-code.md`. Findings come from an audit of engine `main` and host `48756c30` on 2026-11-09; verify each claim before implementing.

## Goal

Remove the leftovers of the engine/host split: an oversize engine test helper, adapter-protocol code no host uses, and one-off migration scripts in the host.

## Findings

1. **Oversize engine file.** `testing/test-support.mjs` is 963 lines and 28,786 bytes, against the 500-line and 20,480-byte ceiling. Its importers include `testing/crash-fixture-runner.mjs`, `testing/graph-fixtures.mjs` and `testing/recovery-fixtures.mjs`. No exemption was found.
2. **Orphaned adapter-protocol code (engine).** `acceptance/conformance.mjs` and `acceptance/reference-adapter.mjs` are imported only by `acceptance/conformance.spec.mjs`. `spawnEvidence` in `host/evidence-transport.ts` is used only by specs (`evidence-process-boundary`, `evidence-source`, `evidence-transport`). S3 removed the registration kind these served.
3. **One-off host scripts.** No references outside retired specs (the two `refactor-*` scripts have none at all): `tools/apply-phase1-archive-readmes.sh`, `archive-legacy-phase2.sh`, `archive-retired-decorators-phase2.sh`, `apply-retired-decorator-archive-readmes.sh`, `migrate-result-imports.mjs`, `refactor-fail-to-err.mjs`, `refactor-result-static-to-standalone.mjs`, `tools/codemods/add-js-extensions.mjs` and `tools/templates/validate-esm.mjs`.
4. **Misplaced host spec.** About 370 lines of `tools/agent-status-validate.spec.mjs` test the engine's validator, which has no spec of its own.
5. **Near the ceiling (engine).** `execution/minimal-executor.ts` (498), `execution/task-executor.spec.mjs` (500), `execution/tool-read.spec.mjs` (500), `policy/contracts/runtime-vocabulary.ts` (499) and about 20 more files are at 480 or more lines. Not in scope; listed so the next feature splits them first.

## Slices

Each slice is its own commit per repo with user approval and the full done bar in the repo it touches.

### S1. Split `testing/test-support.mjs`
Split by fixture family into files each at most 500 lines and 20,480 bytes. Update importers. No assertion changes. Repoint `navigability-support.mjs` scan roots at this repo's layout and drop the `testing/` exemption; update `navigability-gate.spec.mjs` fixtures to match. Gate: unit tests and `reliability replay` pass with the same test count, and the repointed gate passes on the real tree.

### S2. Remove the orphaned adapter-protocol code
Delete `acceptance/conformance.mjs`, `reference-adapter.mjs` and their spec; delete `spawnEvidence` and the specs that exist only for it. Remove the README rows in `acceptance/README.md` and `host/README.md`. Before deleting, confirm each spec asserts only adapter-process behaviour; port anything that does not. Check `testing/qualification/cases.json` for cases pointing at the deleted specs.

### S3. Delete host one-off scripts
Delete the nine scripts in finding 3 after confirming no reference in `package.json`, hooks, CI workflows, `tools/templates`, or handbook docs. Gate: the host's canonical `agent:preflight` passes at the new HEAD.

### S4. Move the validator spec to the engine
Port the validator cases (see Resolved questions) to an engine spec. Trim the host spec to its drift checks and host-data cases. The `agent:status-validate` shim stays. Gate: host preflight passes.

## Acceptance criteria

- **AC-01.** Every tracked engine source, spec and doc file other than `docs/specs/retired/` is at most 500 lines and 20,480 bytes, or has a documented exemption in the navigability gate.
- **AC-02.** No engine file imports `conformance.mjs` or `reference-adapter.mjs`, and `spawnEvidence` has no references.
- **AC-03.** No test is removed without an equivalent engine spec or a recorded reason that it covered only removed behaviour.
- **AC-04.** The host has none of the scripts in finding 3, and no host file references them outside `docs/specs/retired/`.
- **AC-05.** The neutrality guard passes with no new exemptions. The unit test count only drops by the specs deleted in S2 and S4.
- **AC-06.** `commandSha256` for the host's commands is unchanged, and no live canary is needed, because no admitted code path changes.

## Resolved questions

- **Why does `test-support.mjs` pass the navigability gate?** It does not. `testing/navigability-support.mjs` scans only `packages/engine` and `packages/model-usage`, the old monorepo layout, so it finds nothing in this standalone repo. It also exempts everything under `testing/`. The ceiling in `AGENTS.md` is currently unenforced here. S1 therefore also repoints the scan roots at this repo's layout and removes the `testing/` exemption, so the gate enforces the ceiling it documents. Only `test-support.mjs` exceeds it among tracked non-retired files (checked by line and byte count), so no other file needs a baseline exception.
- **Are `tools/codemods` and `tools/templates` live?** No. Each holds one file (`add-js-extensions.mjs`, `validate-esm.mjs`), both from the commit "Prepare monorepo wide ESM upgrade". The `validate-esm.mjs` hits in `apps/*/package.json` point at each app's own `scripts/validate-esm.mjs`, not at `tools/templates`. Add both to the S3 deletion list, subject to the reference check.
- **Is `reference-adapter.mjs` a public example?** No. `package.json` `exports` lists only `agent-status-validate` and `auto-prune`, and no doc outside `acceptance/README.md` mentions it. That README row already says no host uses it. Delete in S2.
- **Does the engine cover the validator spec?** No. The engine has no spec of `validateStatus` semantics; the CLI specs only call it. `tools/agent-status-validate.spec.mjs` (564 lines) has two parts: lines 49 to 415 test the engine validator (phase and lane enums, retry budget, monotonic revision, transitions, orchestrated projections, CLI exit codes), and lines 416 onward are host drift checks for handbook, skill and path references. S4 ports the first part to an engine `agent-status-validate.spec.mjs`. The host keeps the drift checks and the two cases that read host run directories ("validates example run status.json", "validates mature 2026-08-21 run status.json"). Those tests are not deleted until the engine copies pass.

## Risks

- Deleting an orphaned spec can hide a still-valid assertion. Mitigation: AC-03.
- Splitting `test-support.mjs` can change import side effects or ordering. Mitigation: the same-count gate in S1.
