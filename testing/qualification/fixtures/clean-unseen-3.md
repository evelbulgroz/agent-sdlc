# Intent

> **Qualification fixture C1 (clean, unseen, second).** Engine-owned fixture spec. **Never commit or merge the resulting worktree**, so its `@ac` citations never enter a baseline.

## Goal

Add one pure tooling helper, `speedToPace`, in `tools/lib/speed-to-pace.mjs` that converts a speed in kilometres per hour into a pace in whole seconds per kilometre, with a co-located `node:test` spec.

## Non-goals

- No wiring into any script, package, or service.
- No new dependencies, package manifest edits, generated files, or contract changes.
- No edits to existing files under `tools/`.

## Owning context

tools

## Touched surfaces

- tools/lib/speed-to-pace.mjs
- tools/lib/speed-to-pace.test.mjs

## Invariants and constraints

- `speedToPace(kmh)` is a pure synchronous function with a named export.
- It never throws and never reads the clock.

## Public contract impact

None. The helper is internal to `tools/` and is not imported by anything.

## Acceptance criteria

1. AC-01: Speed converts to pace. Given a positive finite speed in kilometres per hour. When `speedToPace` is called. Then it returns the pace in seconds per kilometre rounded to the nearest whole second (half up), so `15` returns `240` and `10.9` returns `330`.
2. AC-02: Implausible speed yields no pace. Given a speed that is zero, negative, non-finite or not a number. When `speedToPace` is called. Then it returns `undefined` instead of throwing, `NaN` or `Infinity`.

## Failure defenses

- Invalid input never produces a pace object.

## Verification plan

- The co-located spec `tools/lib/speed-to-pace.test.mjs` uses `node:test`, cites each criterion with `@ac AC-NN`, and asserts the examples above.
- Run the fixture's done bar: `pnpm run test:unit`.

## Unresolved questions

_None_

## Assumptions

- The helper is new and nothing imports it.
- `tools/` is an allowed path root in the fixture profile and is not a high-risk path.
