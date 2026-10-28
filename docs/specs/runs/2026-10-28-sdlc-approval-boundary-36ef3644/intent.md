# Intent

## Goal

Recover approval processing

## Non-goals

- Do not mutate code

## Owning context

Monorepo Tooling

## Touched surfaces

- tools/example.mjs

## Invariants and constraints

- All model calls use the governor

## Public contract impact

No public API change

## Acceptance criteria

1. AC-01: Approval resumes once. Given the specification interview is complete. Then the operator may approve the draft.

## Failure defenses

- No duplicate approval

## Verification plan

- Inspect approval events

## Unresolved questions

_None_

## Assumptions

_None_
