# Intent

> **Qualification fixture C1 (clean, unseen, second).** Engine-owned fixture spec. **Never commit or merge the resulting worktree**, so its `@ac` citations never enter a baseline.

## Goal

Add one pure tooling helper, `paceToSpeed`, in `tools/lib/pace-to-speed.mjs` that converts a pace in seconds per kilometre into a speed in kilometres per hour, with a co-located `node:test` spec.

## Non-goals

- No wiring into any script, package, or service.
- No new dependencies, package manifest edits, generated files, or contract changes.
- No edits to existing files under `tools/`.

## Owning context

tools

## Touched surfaces

- tools/lib/pace-to-speed.mjs
- tools/lib/pace-to-speed.test.mjs

## Invariants and constraints

- `paceToSpeed(secondsPerKm)` is a pure synchronous function with a named export.
- It never throws and never reads the clock.

## Public contract impact

None. The helper is internal to `tools/` and is not imported by anything.

## Acceptance criteria

1. AC-01: Pace converts to speed. Given a positive finite pace in seconds per kilometre. When `paceToSpeed` is called. Then it returns the speed in kilometres per hour rounded to one decimal place (half up), so `240` returns `15` and `330` returns `10.9`.
2. AC-02: Implausible pace yields no speed. Given a pace that is zero, negative, non-finite or not a number. When `paceToSpeed` is called. Then it returns `undefined` instead of throwing, `NaN` or `Infinity`.

## Failure defenses

- Invalid input never produces a pace object.

## Verification plan

- The co-located spec `tools/lib/pace-to-speed.test.mjs` uses `node:test`, cites each criterion with `@ac AC-NN`, and asserts the examples above.
- Run the fixture's done bar: `pnpm run test:unit`.

## Unresolved questions

_None_

## Assumptions

- The helper is new and nothing imports it.
- `tools/` is an allowed path root in the fixture profile and is not a high-risk path.
