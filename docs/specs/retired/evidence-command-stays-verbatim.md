# Intent

Status: retired 2026-11-24 (implemented on `f09b7e6`). This file is no longer a `check-spec` goal.

## Goal

Task acceptance evidence runs the argv the host profile registered for that evidence command. The engine does not append a spec path or `--reporter=json` to a package `test` script when that script is not the registered command. A `posttest` script never receives those appended arguments.

`execution/task-verification-plan.ts` `resolveAcceptanceEvidenceCommand` appends `--reporter=json` when the targeted script matches `vitest`. The historic transport run used `pnpm test` while `package.json` `test` was a Vitest command joined with `&& node --test`. The appended spec path and reporter reached `node --test` and the run halted with `ERR_MODULE_NOT_FOUND`. The profile already had `productEvidence.commands.unit`.

## Non-goals

- Do not remove `--reporter=json` from a targeted script that is one Vitest invocation and is not the registered unit command.
- Do not change the host allowlist format.
- Do not make `posttest` part of the evidence command.
- Do not raise the packing ceiling.

## Owning context

`execution/task-verification-plan.ts` in agent-sdlc.

## Touched surfaces

- execution/task-verification-plan.ts
- execution/task-verification-plan.spec.mjs
- execution/task-acceptance-evidence.ts

## Invariants and constraints

- When `productEvidence.commands.unit.argv` is non-empty, `resolveAcceptanceEvidenceCommand` returns that argv with no added token. `{reportPath}` stays as written.
- With no registered unit argv, a targeted script whose text contains `vitest` and does not contain `&&` still gains `--reporter=json` on that command only.
- Arguments are appended only to that one command, never to a `posttest` script.
- A package `test` script that is not the registered command is not rewritten.
- The registered command must already be on the host command allowlist.

## Public contract impact

None. This changes how the engine builds an evidence argv. Package `test` scripts and product HTTP stay unchanged.

## Acceptance criteria

1. AC-01: the registered unit argv is used verbatim. Given a profile whose unit command is `pnpm run test:unit` and a package `test` script that contains `vitest`. Then the evidence argv is the registered command and does not gain a spec path or `--reporter=json`. Cases: AC-01.1: registered argv is unchanged; AC-01.2: the package `test` script is not the command that runs.
2. AC-02: a compound test script does not receive the reporter. Given a `test` script of `vitest run && node --test scripts/evidence.spec.mjs` and a task that targets that script. Then the built argv does not append `--reporter=json` or a spec path after the `&&` segment. Cases: AC-02.1: no reporter appended; AC-02.2: no spec path appended.
3. AC-03: a single Vitest script may still request JSON. Given no registered unit argv and a targeted script of one Vitest command with no `&&`. Then the argv for that command ends with `--reporter=json` and the same token is not added to any other script. Cases: AC-03.1: the Vitest command gains the reporter; AC-03.2: `posttest` is absent from the argv.

## Failure defenses

- A task verification command that is not on the host allowlist is rejected before spawn.
- An empty registered argv is rejected.
- Appending to a shell string that contains `&&` is a failed build, not a spawn.

## Verification plan

- `execution/task-verification-plan.spec.mjs` proves AC-01, AC-02, and AC-03.
- Engine check: `pnpm test:unit` in this package.

## Unresolved questions

_None_

## Assumptions

- The transport-3 halt is the motivating case. The fitness-app `posttest` split stays a host workaround until this goal lands.
