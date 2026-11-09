# Intent

> **Qualification fixture C1 (clean, unseen, fourth).** Engine-owned fixture spec. **Never commit or merge the resulting worktree**, so its `@ac` citations never enter a baseline.

## Goal

Add one pure tooling helper, `formatElevation`, in `tools/lib/format-elevation.mjs` that formats an elevation gain in metres as a display string, with a co-located `node:test` spec.

## Non-goals

- No wiring into any script, package, or service.
- No new dependencies, package manifest edits, generated files, or contract changes.
- No edits to existing files under `tools/`.

## Owning context

tools

## Touched surfaces

- tools/lib/format-elevation.mjs
- tools/lib/format-elevation.test.mjs

## Invariants and constraints

- `formatElevation(meters)` is a pure synchronous function with a named export.
- It never throws and never reads the clock or the locale.

## Public contract impact

None. The helper is internal to `tools/` and is not imported by anything.

## Acceptance criteria

1. AC-01: Elevation is formatted for display. Given a non-negative finite elevation gain in metres. When `formatElevation` is called. Then it returns the value rounded to the nearest whole metre (half up) followed by ` m`, and a value of 1000 or more uses a thousands separator comma, so `0` returns `"0 m"`, `12.5` returns `"13 m"` and `1234.4` returns `"1,234 m"`.
2. AC-02: Implausible elevation yields no string. Given a negative, non-finite or non-number elevation. When `formatElevation` is called. Then it returns `undefined` instead of throwing.

## Failure defenses

- Invalid input never produces a pace object.

## Verification plan

- The co-located spec `tools/lib/format-elevation.test.mjs` uses `node:test`, cites each criterion with `@ac AC-NN`, and asserts the examples above.
- Run the fixture's done bar: `pnpm run test:unit`.

## Unresolved questions

_None_

## Assumptions

- The helper is new and nothing imports it.
- `tools/` is an allowed path root in the fixture profile and is not a high-risk path.
