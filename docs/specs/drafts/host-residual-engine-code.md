Status: draft for approval, revised after two independent reviews (each claim below was checked against engine `ae2d205` and host `f9efbba1`). Owner: engine maintainers. Follows `single-config-host-onboarding.md` (retired, implemented H0 to H7).

## Goal

Finish moving engine-shaped code out of the fitness-app host, so the host holds only config, data and product tooling. Remove the engine's unused executable-adapter registration path.

## Boundary rule

The engine owns logic that does not name a host. The host owns paths, tokens, rule files and policy as data. A host script that remains is a shim: argument forwarding, no logic.

## Findings

Engine-shaped code still in the host:

- `tools/agent-telemetry-record.mjs` (555 lines) and its spec. Generic run telemetry: run selection (`--run` > `AGENT_RUN_DIR` > `AGENT_RUN_ID`), containment under the runs directory, lockfile serialization, idempotent append, atomic replace, corruption recovery, snapshot export. It writes gitignored `tools/.telemetry/<slug>.json`. `agent-preflight.sh` pipes a JSON payload to it, discards stdout and ignores failure.
- `tools/agent-run-init.sh` (141 lines). It copies the `_example` run templates, writes `status.json` with git metadata and an owner id, and validates through the engine's validator. The status schema, owner id and validator are engine concepts, and the logic is bash with an inline Python heredoc.
- `tools/learn-check-graduations.mjs` (350 lines) and its spec. The engine already owns the store: `host/learnings.ts` reads `.learnings.jsonl` (or `learnings.filePath`) and `VALID_GRADUATION_TARGETS` is `test, semgrep, depcruise, handbook, skill`. The checker's logic is generic, but its matching is host-specific: it requires the `fitnessapp` identifier prefix and fixed rule-file paths (`tools/quality/semgrep/rules.yml`, `tools/quality/dependency-cruiser.cjs`).
- `tools/lib/atomic-file-state.spec.mjs` (235 lines) tests code in `model-usage-govenor`.

Host-owned, not in scope: quality gates, rule files, verify and turbo scripts, product scripts, `tools/acceptance-evidence/` data, the gate list in `agent-preflight.sh`, `.learnings.jsonl`, and the `_example` run templates.

Engine legacy, unused by the fitness-app `1.6.0` profile (no `runners`, no `evidenceAdapters`): the adapter registration built by `acceptance/registrations.mjs` (`bundleFiles`, `qualificationArtifact`, `executableSha256` on the registration), `acceptance/qualification.mjs` (imported only by its own spec), `profile.acceptanceEvidence.runners`, `evidence-broker.mjs` `runAdapter`, and the non-command branches in `host/evidence-port.ts` and `host/evidence-files.ts`.

**Live and must stay:** `acceptance/recipes.mjs` and `supervisor-recipes.mjs` (task-verification recipes, wired into the supervisor, `recipe-child.mjs` and the `commandBridge` that canary commands use, and required at admission through `taskLintRecipe`), and `commandBindingHash(argv, executableSha256, pins, pretest)` in `host/command-evidence.ts`, where `executableSha256` is the hash of the resolved `argv[0]`. Neither belongs to the adapter path.

## Slices

Each slice is its own commit per repo with user approval and a full done bar in each repo it touches. S1 touches three repos (engine, host, `model-usage-govenor`).

### S1. Telemetry and run init

- **Telemetry commands.** `agent-sdlc telemetry record [--run <slug>] [--stdin] [--root <dir>]` and `agent-sdlc telemetry export --slug <slug>`. Flags only: `parseArguments` rejects positional arguments, so `<slug>` is `--slug`, and `telemetry` joins the two-word command list. It prints nothing to stdout on success and has no progress sink, so preflight can discard its output.
- **Write location.** A new optional profile block `telemetry: { dir }`, repository-relative and contained, default `<stateDir>/telemetry`. The engine carries no literal `tools/.telemetry`. The host sets `dir` to `tools/.telemetry`, which it already gitignores. A write outside a gitignored path is out of contract: the spec for the default asserts a clean tree after a record.
- **Runs directory.** From the profile `specDraftDir` sibling convention already used by the engine for runs; the exact field is the one `start.ts` resolves, reused rather than duplicated.
- **Size.** The 555-line module is split before landing (selector and containment, lock and atomic write, export), each file within 500 lines and 20,480 bytes.
- **`run init`.** `agent-sdlc run init --slug <slug> [--owner <id>] [--orchestrated]`, with the script's kebab-case grammar, atomic create and cleanup on failure, git metadata, and validation. Templates come from the host `<runsDir>/_example`, falling back to bundled defaults in `run-templates/`, which the `build` script copies into `dist/`. `--orchestrated` only sets `activeOwner` to `orchestrator:agent-sdlc`. It writes no `orchestration` object, because the validator requires `retry.source: runtime.sqlite` and a full projection whenever one is present. `run init` is for manual run folders. It is not a prerequisite for `agent-sdlc start`, which fails with `RUN_ALREADY_EXISTS` on an existing `<date>-<slug>` folder.
- **Host.** `agent:telemetry`, `agent:run-init` and `agent-preflight.sh` call the engine. Delete the recorder, its spec and `agent-run-init.sh`. Move `atomic-file-state.spec.mjs` to `model-usage-govenor`.

Gate: ported specs cover selector precedence, containment, concurrent appends, the idempotent key, corruption recovery, export grammar, and for `run init` the slug grammar, an existing folder, a failed validation leaving no folder, and the orchestrated owner. Host preflight is canonical and green, and telemetry failure still never fails preflight.

### S2. Learnings graduations

- **Command.** `agent-sdlc learnings graduations [--advisory]`, reading entries through `resolveLearningStorePath` and `loadLearningStore` like the other `learnings` subcommands. The JSONL store is kept as is. Nothing is migrated or dropped.
- **Profile.** The schema bump to `1.7.0` moves here, so S2 and S3 do not mutate `1.6.0` in place. Under `learnings`, a closed `graduations` block: `identifierPrefix` (the match token, `fitnessapp` for the host), `semgrepRules` and `dependencyCruiserConfig` (contained, repository-relative file paths), and `testGlobs`, `handbookDirs` and `skillDirs` (contained directories or globs). Every field is optional, and a graduation target whose source is unset reports no match. Validation reuses `validateContainedRelativePath`. `1.6.0` profiles load unchanged.
- **Neutrality.** The engine carries no `fitnessapp` literal. The prefix and every path come from the profile, so AC-05 holds with no new exemption.
- **Host.** `check:learnings-graduations` and `quality-static-gates.mjs` call the engine. Delete the checker and its spec. The host profile gains the `graduations` block.

Gate: ported specs for rule extraction (comments excluded), prefix matching, each target, enforcement and `--advisory` exits, and a profile with an unset source. Host quality gates green.

### S3. Remove the executable adapter path

- Remove `acceptance/qualification.mjs` and its spec, `acceptance/registrations.mjs` adapter registration building, `evidence-broker.mjs` `runAdapter`, the executable branches in `host/evidence-port.ts` and `host/evidence-files.ts`, `profile.acceptanceEvidence.runners` (so `bundleFiles` leaves the schema), and `ExecutableRegistration`. `AdapterRegistrationSchema` collapses to the command registration.
- `canary-execution.mjs` `pinnedFiles` and the `registrations` CLI call stop reading `runners`.
- Fixtures that build executable registrations are rewritten to command registrations. The audit lists these specs, each of which must keep its assertions: `quality-status`, `quality-records`, `quality-authorization`, `run-archive-quality`, `run-authorization-schema`, `quality-schema`, `quality-planning`, `critic-input-packing`, `final-quality-checkpoint`, `planning`, `graph-plan-critic`, `node-helpers`, `preflight-gate`, `quality-gate-integration`, and `testing/task-quality-fixture.mjs`.
- A profile with `runners` fails with a typed error naming the migration. `1.6.0` profiles without `runners` load unchanged.
- `recipes.mjs`, `supervisor-recipes.mjs` and `commandBindingHash` are untouched, so `commandSha256` does not change and no pin is invalidated.

Gate: neutrality guard and typecheck green, then one live canary to READY on the host with a regenerated, human-approved admission.

## Acceptance criteria

- **AC-01.** After S1 and S2 the host has no script over 50 lines that implements telemetry, run-init or graduation logic. Remaining `agent:*` entries only forward to the engine.
- **AC-02.** The engine has a spec for every behaviour a removed host spec covered. No spec is deleted without a ported equivalent.
- **AC-03.** `agent-preflight.sh` still records telemetry with the same exit code and output line, and a telemetry failure never fails preflight. A record leaves the worktree clean.
- **AC-04.** After S3, no engine source file mentions `bundleFiles`, `qualificationArtifact` or `ExecutableRegistration` outside a rejection spec. `executableSha256` stays where it is the resolved-`argv[0]` hash (`commandBindingHash`, runtime and recipe pins). Specs, the retired docs and migration notes are exempt, as in the neutrality guard.
- **AC-05.** The neutrality guard passes with no new exemptions, and no engine file contains a `fitnessapp` literal outside specs.
- **AC-06.** `commandSha256` for the host's existing commands is unchanged by S3.
- **AC-07.** Every new or split engine file is at most 500 lines and 20,480 bytes.

## Open questions

- **Learnings content.** The 25 host entries are about 90% host-specific (`conditioning`, `import`, `ddd-base`, frontend scopes, with host file paths). About 5 look like agent-behaviour lessons that may be engine-wide. They stay in the host. Promoting them to engine role prompts is a separate step after someone reads them.

## Risks

- **Preflight coupling.** Preflight calls telemetry on every run. A slower or failing engine call must stay non-fatal and within the preflight time budget.
- **Template drift.** Bundled run templates can diverge from a host's `_example`. The host copy wins when present, and a spec pins the fallback.
- **Fixture churn in S3.** About 15 specs build executable registrations. A rewrite that loosens an assertion is a masking risk, so each rewrite is reviewed against its original.
- **Re-pinning.** S3 changes admission schemas, so the host admission is regenerated and needs a human receipt approval before the live canary.
