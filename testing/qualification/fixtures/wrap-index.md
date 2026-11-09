# Intent

> **Qualification fixture N2 (observational).** Engine-owned fixture spec. **Never commit or merge the resulting worktree**, so its `@ac` citations never enter a baseline.

## Goal

Add one pure tooling helper, `wrapIndex`, in `tools/lib/wrap-index.mjs` that wraps an integer index into a list length, with a co-located `node:test` spec. The produced tests are scored offline against hidden mutants by `wrap-index-oracle.mjs`.

## Non-goals

- No wiring into any script, package, or service.
- No new dependencies, package manifest edits, generated files, or contract changes.
- No edits to existing files under `tools/`.

## Owning context

tools

## Touched surfaces

- tools/lib/wrap-index.mjs
- tools/lib/wrap-index.test.mjs

## Invariants and constraints

- `wrapIndex` is a pure synchronous function with no imports and the named export `wrapIndex`.
- A valid result is always an integer from 0 to `length - 1` inclusive.

## Public contract impact

None. The helper is internal to `tools/` and is not imported by anything.

## Acceptance criteria

1. AC-01: Indexes wrap in both directions. Given an integer index and a positive integer length. When `wrapIndex(index, length)` is called. Then the result is the index modulo the length, never negative, so `wrapIndex(-1, 5)` returns `4`, `wrapIndex(5, 5)` returns `0` and `wrapIndex(12, 5)` returns `2`.
2. AC-02: Invalid input is rejected with a typed error. Given a length that is zero, negative, fractional or `NaN`, or an index that is fractional. When `wrapIndex` is called. Then it throws a `RangeError`.

## Failure defenses

- Invalid input never returns a number.
- Negative zero is not returned.

## Verification plan

- The co-located spec `tools/lib/wrap-index.test.mjs` uses `node:test`, cites each criterion with `@ac AC-NN`, and asserts the examples above.
- Run the fixture's done bar: `pnpm run test:unit`.

## Unresolved questions

_None_

## Assumptions

- The helper is new and nothing imports it.
- `tools/` is an allowed path root in the fixture profile and is not a high-risk path.
