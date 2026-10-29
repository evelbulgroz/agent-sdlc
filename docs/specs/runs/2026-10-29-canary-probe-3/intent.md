# Intent

## Goal

Add a small pure helper `clampPercent(value)` in `scripts/canary-probe.ts` that returns an integer between 0 and 100, with a co-located node:test spec.

## Non-goals

- No CLI wiring, no new dependencies, no changes outside `scripts/`.

## Owning context

scripts

## Touched surfaces

- scripts/canary-probe.ts
- scripts/canary-probe.spec.mjs

## Invariants and constraints

- The helper is pure and has no imports.
- Non-finite input returns 0 and never throws.

## Public contract impact

None. The helper is internal to the repository and not exported from any package entry point.

## Acceptance criteria

1. AC-01: Values are clamped to the 0 to 100 range. Given a finite number. When clampPercent is called. Then the result is an integer from 0 to 100 inclusive, rounding to the nearest integer.
2. AC-02: Invalid input is neutralised. Given NaN, Infinity, or a non-number. When clampPercent is called. Then the result is 0 and no error is thrown.

## Failure defenses

- Non-number and non-finite input returns 0 instead of throwing.

## Verification plan

- Run `pnpm run test:unit`; the new spec asserts AC-01 and AC-02 with @ac tags.

## Unresolved questions

_None_

## Assumptions

_None_
