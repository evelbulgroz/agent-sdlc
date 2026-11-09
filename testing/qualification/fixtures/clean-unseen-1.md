# Intent

> **Qualification fixture C1 (clean, unseen).** Engine-owned fixture spec. **Never commit or merge the resulting worktree**, so its `@ac` citations never enter a baseline.

## Goal

Add one pure tooling helper, `averagePace`, in `tools/lib/average-pace.mjs` that turns a distance and a moving time into an average pace per kilometre and a display string, with a co-located `node:test` spec.

## Non-goals

- No wiring into any script, package, or service.
- No new dependencies, package manifest edits, generated files, or contract changes.
- No edits to existing files under `tools/`.

## Owning context

tools

## Touched surfaces

- tools/lib/average-pace.mjs
- tools/lib/average-pace.test.mjs

## Invariants and constraints

- `averagePace(distanceMeters, movingTimeMs)` is a pure synchronous function with a named export.
- It never throws, never mutates its input, and never reads the clock.

## Public contract impact

None. The helper is internal to `tools/` and is not imported by anything.

## Acceptance criteria

1. AC-01: Average pace is derived per kilometre and formatted for display. Given a positive finite distance in metres and a positive finite moving time in milliseconds. When `averagePace` is called. Then it returns `{ secondsPerKm, formatted }`, where `secondsPerKm` is the pace rounded to the nearest whole second (half up) and `formatted` is `M:SS` below one hour and `H:MM:SS` from one hour, so 5000 m in 1,200,000 ms returns `{ secondsPerKm: 240, formatted: "4:00" }` and 1000 m in 3,605,000 ms returns `{ secondsPerKm: 3605, formatted: "1:00:05" }`.
2. AC-02: Missing or implausible data yields no pace. Given a distance or a moving time that is zero, negative, non-finite or not a number. When `averagePace` is called. Then it returns `undefined` instead of throwing, `NaN` or `Infinity`.

## Failure defenses

- Invalid input never produces a pace object.

## Verification plan

- The co-located spec `tools/lib/average-pace.test.mjs` uses `node:test`, cites each criterion with `@ac AC-NN`, and asserts the examples above.
- Run the fixture's done bar: `pnpm run test:unit`.

## Unresolved questions

_None_

## Assumptions

- The helper is new and nothing imports it.
- `tools/` is an allowed path root in the fixture profile and is not a high-risk path.
