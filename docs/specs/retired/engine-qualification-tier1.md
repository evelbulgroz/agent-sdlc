Status: retired. Implemented before 2026-11-09 and split out of `engine-qualification-suite.md`. Tier 2 continues in `docs/specs/retired/engine-qualification-suite.md`.

# Engine qualification, tier 1

## Purpose

Show that the engine blocks defects, not only that it completes clean runs. A case passes when the engine stops for the predicted reason.

## What exists

`testing/qualification/cases.json` holds one entry per case: `id`, `tier`, `seededDefect`, `expectedOutcome`, and for tier 1 `expectedCode` plus a `proof` (spec file and test title). `testing/qualification.spec.mjs` fails when a tier 1 proof test is renamed, removed, or no longer mentions its expected code, so a case cannot be dropped silently. Tier 1 behaviour is asserted by the existing gate specs and is not duplicated. Tier 1 runs in `pnpm run test:unit` with no model spend.

| Case | Seeded defect | Expected code |
|---|---|---|
| N3 | Pinned evidence file altered after admission | `PINNED_FILE_MODIFIED` |
| N4 | No allowed governed route completes a critic review | `GOVERNOR_ROUTES_EXHAUSTED` |
| N5 | Tool path escapes the worktree, directly or by symlink | `PATH_CONTAINMENT_VIOLATION` |
| N6 | Authorization envelope expired or mismatched | `AUTHORIZATION_EXPIRED` |
| N7 | Engine process dies at an execution or repair boundary | `resume` (no duplicate effects) |

## Known limits, carried to the tier 2 draft

- N6 pins only `AUTHORIZATION_EXPIRED`. The spec-hash, run-id and base-commit mismatches all throw `AUTHORIZATION_INVALID` (told apart by message), and the run-id path is not in the proof.
- N7's `expectedCode` is not an error code, so the guard's "body mentions the code" check is weak for it.
- The guard finds a proof by the literal `test('<title>'`. Tests declared with other quoting or `it`/`describe` would be reported missing.
