# Intent

Ready for `shell start`. This host profile declares no `productEvidence`, so this goal has no obligations file.

## Goal

A sentence captured on `resume --retry` or `post-mortem` stays in `.learnings.jsonl` for `learnings search`, and it stays out of role recall until an operator republishes that key with `source: observed`. The 1 October–19 November 2026 fitness-app log held 27 entries. Four `observed` traps were worth a handbook paragraph. Twenty-three `user-stated` entries at confidence 9 were task prompts, and confidence 9 already passes the recall floor of 7, so those prompts competed for the three recall slots.

## Non-goals

- Do not add a model or keyword classifier that decides whether an insight is a lesson.
- Do not change the graduation gate. It keeps searching for the `fitnessapp:<key>` marker.
- Do not drop `user-stated` rows from `learnings search`.
- Do not change the confidence floor of 7.
- Do not stop `resume` or `post-mortem` from writing the outbox.

## Owning context

`roles/upstream-recall.ts` in agent-sdlc.

## Touched surfaces

- roles/upstream-recall.ts
- roles/upstream-recall.spec.mjs
- docs/handbook/institutional-memory.md

## Invariants and constraints

- Store rows with `source: user-stated` are omitted from `resolveScopeLearnings` before `candidateLearnings` are merged.
- The `candidateLearnings` argument is still merged after that filter. Those entries are this run's staged proposals, including when their source defaults to `user-stated`.
- `source: observed` and `source: inferred` rows at confidence 7 or higher follow the existing scope, type, and three-slot rules.
- `agent-sdlc-deterministic` and `maxPromptTokens: 0` still return an empty string.
- `learnings add --upsert` with `source: observed` replaces the stored row and makes that key eligible for recall.
- Git branch, commit, and push remain operator-authorized.

## Public contract impact

None. Recall text injected into a role prompt changes. No product HTTP or OpenAPI change.

## Acceptance criteria

1. AC-01: Role recall omits an unreviewed store entry. Given a store row `source: user-stated`, confidence 9, scope and type matching the role. Then `resolveScopeLearnings` does not contain that key. Cases: AC-01.1: user-stated pitfall is absent from implementer recall.
2. AC-02: Search still lists the unreviewed entry. Given the same store row. Then `searchLearningStore` returns that key. Cases: AC-02.1: search result contains the user-stated key.
3. AC-03: Republishing as observed makes the key recallable. Given the same key upserted with `source: observed` and confidence 9. Then `resolveScopeLearnings` contains that key. Cases: AC-03.1: observed pitfall is present in implementer recall.
4. AC-04: This run's staged proposals still inject. Given `candidateLearnings` with no source and a key absent from the store. Then `resolveScopeLearnings` contains that key. Cases: AC-04.1: default candidate key is present.

## Failure defenses

- A store row with a missing source is treated as `observed`, matching `validateLearningEntry`.
- A `user-stated` row below confidence 7 stays out of recall for both reasons.
- An upsert that keeps `source: user-stated` stays out of recall.

## Verification plan

- Unit: `roles/upstream-recall.spec.mjs` cites `@ac AC-01` through `@ac AC-04` and `@case AC-01.1` through `@case AC-04.1`.
- Command: `pnpm run test:unit` in agent-sdlc.
- The fitness-app host graduation gate is unchanged and is not part of this change.

## Unresolved questions

_None_

## Assumptions

- `learnings add --upsert` remains the accept path. No new subcommand.
