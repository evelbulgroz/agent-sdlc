# Intent

> **Qualification fixture N8 (crash and resume).** Engine-owned fixture spec. **Never commit or merge the resulting worktree**, so its `@ac` citations never enter a baseline.

## Goal

Add one pure tooling helper, `clampPercent`, in `tools/lib/clamp-percent.mjs` that returns an integer from 0 to 100, with a co-located `node:test` spec. The run is killed mid-implementation and resumed.

## Non-goals

- No wiring into any script, package, or service.
- No new dependencies, package manifest edits, generated files, or contract changes.
- No edits to existing files under `tools/`.

## Owning context

tools

## Touched surfaces

- tools/lib/clamp-percent.mjs
- tools/lib/clamp-percent.spec.mjs

## Invariants and constraints

- `clampPercent` is a pure synchronous function with no imports.
- It never throws.
- The return value is always an integer in the inclusive range 0 to 100.

## Public contract impact

None. The helper is internal to `tools/` and is not imported by anything.

## Acceptance criteria

1. AC-01: Finite values are clamped and rounded. Given a finite number. When `clampPercent` is called. Then the result is the nearest integer within 0 to 100 inclusive, so `-5` returns `0`, `42.6` returns `43`, and `250` returns `100`.
2. AC-02: Invalid input is neutralised. Given `NaN`, `null`, or a string. When `clampPercent` is called. Then the result is `0` and no error is thrown.

## Failure defenses

- Non-number and non-finite input returns `0` instead of throwing.
- Negative zero returns `0`, so `Object.is(result, -0)` is false.

## Verification plan

- The co-located spec `tools/lib/clamp-percent.spec.mjs` uses `node:test`, cites each criterion with `@ac AC-NN`, and asserts the examples above plus negative zero.
- Run the fixture's done bar: `pnpm run test:unit`.

## Unresolved questions

_None_

## Assumptions

- The helper is new and nothing imports it.
- `tools/` is an allowed path root in the fixture profile and is not a high-risk path.
