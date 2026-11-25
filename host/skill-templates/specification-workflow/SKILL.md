---
name: specification-workflow
description: Turn a request into a repo-ready spec with acceptance criteria and, when the host declares productEvidence, a product obligations file. Use when authoring a spec that hands off to shell start --goal-file.
---

This file is the authoring contract for `docs/specs/drafts/<slug>.md` and for
the handoff to [`agent-sdlc-shell`](../agent-sdlc-shell/SKILL.md). Write the
markdown below. Do not open engine source to learn headings, completeness, or
acceptance-criteria grammar unless a live `--goal-file` start error
contradicts this skill.

Host-only rules (interview, architecture notes, the host verify command) may
be added in the host's copy of this skill. Sibling task and obligations flags
follow `$AGENT_SDLC_PATH/cli/README.md`.

## Output structure

`# Intent` is conventional. Only `##` headings are ingested. An unknown `##`
heading fails closed (`INVALID_INPUT` lists it and the allowed set) and
`start` does not create a run. Accepted aliases are `Non goals` and
`Invariants & constraints`.

```markdown
# Intent

## Goal

<one or more paragraphs: the outcome>

## Non-goals

- <explicit deferral>

## Owning context

<single package or directory, such as pkg>

## Touched surfaces

- <file or directory the change will edit>

## Invariants and constraints

- <boundary that must hold>

## Public contract impact

None. <what stays unchanged>

## Acceptance criteria

1. AC-01: <observable outcome>. Given <precondition>. Then <observable result>. Cases: AC-01.1: <case>.

## Failure defenses

- <nil, empty, timeout, or stale state>

## Verification plan

- <which check proves AC-01>

## Unresolved questions

_None_

## Assumptions

_None_
```

| Heading | Shape | Completeness |
|---|---|---|
| Goal | scalar paragraphs | required, non-empty |
| Non-goals | `- ` bullets | required, at least one |
| Owning context | scalar | required, non-empty |
| Touched surfaces | `- ` bullets | required, 1 to 64 |
| Invariants and constraints | `- ` bullets | required, at least one |
| Public contract impact | scalar paragraph | required, non-empty |
| Acceptance criteria | numbered `AC-NN` lines | required, at least one grammatical item |
| Failure defenses | `- ` bullets | required, at least one |
| Verification plan | `- ` bullets | required, at least one |
| Unresolved questions | `- ` bullets or `_None_` | must parse empty |
| Assumptions | `- ` bullets or `_None_` | optional |

Scalar sections are plain text, not a bullet list. List items are one line
each. `_None_` parses as empty. Empty required lists fail completeness. Do
not put secrets, tokens, or credentials in any field.

## Acceptance criteria grammar

Each criterion is one list line:

```text
AC-NN: <observable outcome>. Given <precondition or input>. Then <observable result>.
```

Optional suffixes on the same line, in this order:

- ` Cases: AC-NN.1: <case>; AC-NN.2: <case>.`
- ` Evidence: <pointer>.`

`NN` is two or more digits (`AC-01` is valid; `AC-1` is not). Ids are unique.
Outcome, Given, and Then are non-empty and each end with a period. A `Cases:`
clause ends with a period. Case ids match `AC-NN.N`, start at `1`, and use
the parent id (`AC-01.1` belongs to `AC-01`). Separate cases with semicolons.

Words that fail the criterion: `TBD`, `unsure`, and `??`.

A test that proves a criterion puts `@ac AC-NN` in the `it` or `test` title.
A test that proves a case also puts `@case AC-NN.N` in that title.

## Product obligations

When the host profile declares `productEvidence` and the draft has acceptance
criteria, write `docs/specs/drafts/<slug>.obligations.json` beside the spec.
One obligation per declared case. The engine does not invent case ids. Give
every run-starting criterion at least one `Cases:` id before writing this
file. Skip the file when the goal is the profile's `qualificationFixture.spec`
or `acceptanceEvidence.canary.spec`.

```json
{
  "schemaVersion": "1.0.0",
  "obligations": [{
    "obligationId": "month-default",
    "criterionId": "AC-01",
    "caseId": "AC-01.1",
    "ownerTaskId": "task-0",
    "layer": "unit",
    "profileId": "unit",
    "testFile": "pkg/example.spec.mjs",
    "caseKey": "month-default",
    "observableOutcome": "The month control is selected.",
    "setupAction": "Open the landing page.",
    "expectedResult": "The month control is selected."
  }]
}
```

The document is closed: `schemaVersion` and `obligations` only. Each row is
closed to the keys above, plus optional `capabilities`.

- `profileId` is a key of `productEvidence.commands`. `layer` is that
  command's layer: `unit`, `integration`, `browser`, or `static`.
- `capabilities`, when present, are a subset of that command's capabilities.
  The allowed values are `native-browser`, `native-file-picker`,
  `focus-navigation`, and `static-check`.
- `testFile` is a repository-relative path with no `.` or `..` segment, and
  it must sit under the run's allowed path prefixes. The test title contains
  `@case AC-NN.N` equal to `caseId`.
- Each `caseId` must be absent from `testFile` when the draft is checked. A
  missing `testFile` is fine. When `check-spec` or `shell start` reports an
  occupied case, follow that reported remedy. Do not delete tests to make a
  review packet fit.
- `ownerTaskId` is `task-0` when no task manifest is passed. When a manifest
  is passed, it is the task whose slice lists `criterionId`.
- `obligationId`, `ownerTaskId`, `profileId`, and `caseKey` match
  `^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$`.

## Check and hand off

Check ingest without creating a run. Pass a sibling flag when
`$AGENT_SDLC_PATH/cli/README.md` requires it.

```bash
pnpm run agent:sdlc -- check-spec --goal-file docs/specs/drafts/<slug>.md --json
```

Exit `0` with `ready: true` means `shell start` can skip
`WAITING_FOR_ANSWERS`. Exit `2` means headings parsed and fields or grammar
are still incomplete. Exit `64` means `INVALID_INPUT` or `INVALID_CONTRACT`.

Hand off to `agent-sdlc-shell`.

## Task manifest

When one run needs more than one task, write
`docs/specs/drafts/<slug>.tasks.json`. The top-level keys are only
`schemaVersion`, `slices`, and `tasks`. Ceilings are in
`$AGENT_SDLC_PATH/policy/README.md`. `check-spec` exit `64` with
`TASK_DECOMPOSITION_REQUIRED` names the exceeded dimension.

```json
{
  "schemaVersion": "1.0.0",
  "slices": [{
    "sliceId": "behavior",
    "kind": "vertical",
    "goal": "Deliver the observable behavior.",
    "acceptanceCriteria": ["AC-01"],
    "dependsOn": []
  }],
  "tasks": [{
    "taskId": "behavior-task",
    "sliceId": "behavior",
    "targetPackage": "pkg",
    "authoredPaths": ["pkg/example.mjs", "pkg/example.spec.mjs"],
    "pathPrefixes": ["pkg"],
    "generatedOutputs": [],
    "dependsOn": [],
    "deliveryLayers": ["tooling"],
    "dependencyMutations": [],
    "shadowPaths": {
      "unhappy": "invalid input is rejected",
      "timeout": "the command deadline is enforced",
      "empty": "empty output fails closed",
      "boundary": "out-of-scope writes are rejected"
    },
    "verificationCommand": ["pnpm", "run", "test"],
    "generatorCommand": null
  }]
}
```

Slice `kind` is `enabling`, `vertical`, or `activation`. An enabling slice
owns no acceptance criteria. Every frozen `AC-NN` has one non-enabling owner.
`deliveryLayers` values are `domain`, `application`, `ports`, `adapters`,
`contracts`, `persistence`, `configuration`, `tooling`, or `documentation`.
With a manifest, set each obligation `ownerTaskId` to that owning `taskId`.
