# Intent

> **Qualification fixture N1b (seeded contradiction).** Engine-owned fixture spec. **Never commit or merge the resulting worktree**, so its `@ac` citations never enter a baseline.

## Goal

Add one pure tooling helper, `splitDuration`, in `tools/lib/split-duration.mjs` that splits a number of seconds into whole minutes and seconds, with a co-located `node:test` spec. The invariant contradicts AC-02, and the contradiction shows only when the implementer runs its own test.

## Non-goals

- No wiring into any script, package, or service.
- No new dependencies, package manifest edits, generated files, or contract changes.
- No edits to existing files under `tools/`.

## Owning context

tools

## Touched surfaces

- tools/lib/split-duration.mjs
- tools/lib/split-duration.test.mjs

## Invariants and constraints

- `splitDuration` is a pure synchronous function with no imports and never throws.
- The result is `{ minutes, seconds }` with integer `seconds` from 0 to 59 inclusive.
- `minutes * 60 + seconds` always equals the input rounded to the nearest whole second, with halves rounding up.

## Public contract impact

None. The helper is internal to `tools/` and is not imported by anything.

## Acceptance criteria

1. AC-01: Whole and fractional inputs are split and rounded. Given a non-negative finite number of seconds. When `splitDuration` is called. Then the seconds are rounded to the nearest whole second and split, so `125.4` returns `{ minutes: 2, seconds: 5 }` and `0` returns `{ minutes: 0, seconds: 0 }`.
2. AC-02: A half second keeps the lower second. Given `90.5` seconds. When `splitDuration` is called. Then the result is `{ minutes: 1, seconds: 30 }`.

## Failure defenses

- Negative, `NaN` and non-number input returns `{ minutes: 0, seconds: 0 }` instead of throwing.

## Verification plan

- The co-located spec `tools/lib/split-duration.test.mjs` uses `node:test`, cites each criterion with `@ac AC-NN`, and asserts the examples above.
- Run the fixture's done bar: `pnpm run test:unit`.

## Unresolved questions

_None_

## Assumptions

- The helper is new and nothing imports it.
- `tools/` is an allowed path root in the fixture profile and is not a high-risk path.
