# Intent

Draft only. Do not start this goal until its sibling obligations file exists. The 24,576-byte critic packing ceiling stays.

## Goal

When a run is blocked on a quality-review card, `shell status` gives the operator an executable `shell reply` argv. The reply accepts the actions the quality schema already allows: `refute`, `confirm`, and `approve-correction`. A finding that contradicts the frozen acceptance text can be answered as "the spec is the contract" without minting another slug.

Today `cli/host-invocation.ts` recognizes `questions`, `approval`, `authorization`, `plan_critic`, `reconciliation_conflict`, and `high_risk_review`. A pending `quality_review` interrupt is not in that set, so `projectHostInvocation` returns `executable: false` and `argv: null`. `cli/quality-answer.ts` and `cli/commands/resume.ts` already validate a quality answer. The historic Strength keyboard runs reached a green task and then stopped on this card. Keyboard-14 blocked after the test matched the frozen download contract.

## Non-goals

- Do not resume a halted slug in place.
- Do not add a quality action beyond `refute`, `confirm`, and `approve-correction`.
- Do not let `shell watch` submit the answer.
- Do not raise the 24,576-byte critic packing ceiling or any governor token limit.
- Do not commit, push, or treat a critic finding as merge trust.

## Owning context

`cli/host-invocation.ts` in agent-sdlc.

## Touched surfaces

- cli/host-invocation.ts
- cli/host-invocation.spec.mjs
- cli/quality-answer.ts
- cli/commands/quality-answer.spec.mjs

## Invariants and constraints

- `QualityAnswerSchema` remains the response contract. `approve-correction` still requires a correction payload, and `refute` still requires evidence hashes.
- A reply whose interrupt id or binding hash does not match the pending card is `STALE_RESPONSE`.
- An action absent from the card's `allowedActions` is `POLICY_VIOLATION`.
- The packing ceiling stays 24,576 bytes. Local policy may only lower committed limits.

## Public contract impact

None. This changes the operator shell card for an engine interrupt. No product HTTP, OpenAPI, or host repository contract changes.

## Acceptance criteria

1. AC-01: quality-review card is executable. Given a blocked run whose pending interrupt kind is `quality_review` and whose allowed actions are `refute`, `confirm`, and `approve-correction`. Then `projectHostInvocation` returns `executable: true` and an argv that is `shell reply` with `--response-file` for that run. Cases: AC-01.1: refute and confirm are selectable; AC-01.2: approve-correction is selectable only when the card lists it.
2. AC-02: a mismatched reply does not leave the card. Given a response whose `interruptId` or `bindingHash` differs from the pending card. Then validation throws `STALE_RESPONSE` and the run stays blocked. Cases: AC-02.1: stale interrupt id; AC-02.2: stale binding hash.
3. AC-03: watch does not answer the card. Given a quality-review card with an executable reply argv. Then `shell watch` does not submit a quality action. Cases: AC-03.1: watch argv is not `shell reply`.

## Failure defenses

- An unrecognized quality action is rejected before the run resumes.
- A second reply for a consumed interrupt is `STALE_RESPONSE`.
- Missing `allowedActions` rejects every action.

## Verification plan

- `cli/host-invocation.spec.mjs` proves AC-01 and AC-03 with `@ac` and `@case` citations.
- `cli/commands/quality-answer.spec.mjs` proves AC-02.
- Engine check: `pnpm test:unit` in this package.

## Unresolved questions

_None_

## Assumptions

- The historic keyboard block is the motivating case. The frozen spec text remains the contract a `refute` may cite.
