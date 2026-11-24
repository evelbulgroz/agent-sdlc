# Intent

Status: retired 2026-11-24 (implemented on `c971c4d`). This file is no longer a `check-spec` goal.

## Goal

A critic prompt carries the acceptance text owned by this goal's tasks. When the run binds an obligations document, the prompt also carries that document's SHA-256. It does not embed the obligations JSON, and it does not embed criterion text for ids this goal does not own. A run with no obligations document still assembles from the draft. A goal that still exceeds the ceiling fails `INPUT_OVERSIZED` before a model call.

`review/critic-prompt.ts` rejects an assembled prompt above 24,576 bytes or 1,000 lines. The historic Strength monolith assembled a spec-critic prompt of 39,006 bytes from a 42,007-byte spec and stopped before any model call. The combined queue goal assembled a 30,432-byte QA packet. Splitting the goal was the only way through. The ceiling is the control that made that split necessary.

## Non-goals

- Do not raise the 24,576-byte ceiling, the 1,000-line ceiling, or the 8,000-token QA reservation.
- Do not drop the obligations hash from the run binding.
- Do not start a goal whose own criterion text still exceeds the ceiling.
- Do not change which criteria a task owns.

## Owning context

`review/critic-prompt.ts` in agent-sdlc.

## Touched surfaces

- review/critic-prompt.ts
- review/critic-prompt.spec.mjs

## Invariants and constraints

- The ceiling remains 24,576 bytes and 1,000 lines. An over-ceiling prompt throws `INPUT_OVERSIZED` and does not call a model.
- A bound obligations document contributes its SHA-256 and no other bytes from that document.
- A run with no obligations document does not require a hash.
- Criterion lines in the prompt, including lines copied from the draft, are limited to ids listed on this goal's tasks.
- Local policy may only lower committed limits.

## Public contract impact

None. Prompt assembly stays inside the engine. No product HTTP or OpenAPI change.

## Acceptance criteria

1. AC-01: foreign criteria stay out of the prompt. Given a goal whose tasks own AC-01 and an obligations file that also contains AC-02. Then the assembled spec-critic prompt contains the AC-01 text and the obligations hash, and does not contain the AC-02 text or the obligations JSON. Cases: AC-01.1: owned text is present; AC-01.2: foreign text and the raw obligations document are absent.
2. AC-02: the ceiling still fails closed. Given owned criterion text that assembles to 24,577 bytes. Then assembly throws `INPUT_OVERSIZED` and reports the byte count. Cases: AC-02.1: one byte over the ceiling; AC-02.2: 24,576 bytes is accepted.
3. AC-03: the same rule binds the plan and QA prompts. Given the fixture from AC-01. Then the plan-critic prompt and the QA prompt also omit AC-02 and the obligations JSON. Cases: AC-03.1: plan prompt; AC-03.2: QA prompt.
4. AC-04: a run with no obligations document still assembles. Given owned criterion text and no obligations document. Then assembly returns the prompt and does not throw. Cases: AC-04.1: no obligations hash is required; AC-04.2: the owned criterion text is present.

## Failure defenses

- A bound obligations document with a missing hash rejects assembly before the byte check.
- A task criterion id absent from a bound obligations document rejects assembly.
- Truncating foreign text to fit the ceiling is not a success.

## Verification plan

- `review/critic-prompt.spec.mjs` proves AC-01, AC-02, AC-03, and AC-04.
- Engine check: `pnpm test:unit` in this package.

## Unresolved questions

_None_

## Assumptions

- The measured historic prompts, 39,006 bytes and 30,432 bytes, are the reason this goal exists. Those drafts stay unstarted.
