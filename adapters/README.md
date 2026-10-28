# Outbound Adapters (`packages/agent-sdlc/adapters/`)

Outbound infrastructure ports connecting `@fitness-app/agent-sdlc` to the repository Model Usage Governor (`@fitness-app/model-usage`) and GitHub CLI (`gh`) draft pull request workflows.

## Key Files & Entrypoints

- `packages/agent-sdlc/adapters/model-governor.ts` — `RepositoryModelGovernor` wrapping `executeOperation` and `assessReservation` from `packages/model-usage/governor.ts` under consumer `agent-sdlc`.
- `packages/agent-sdlc/adapters/github-pr.ts` — `createDraftPullRequest` and remote branch push integration for explicitly authorized runs (`agent-sdlc pr`).

## Core Invariants

1. **Exclusive Governor Bridge (`model-governor.ts`):**
   - 100% of model-backed role, implementer, critic, and trace-attribution calls route through `RepositoryModelGovernor` $\to$ `packages/model-usage/governor.ts`.
   - Pre-flight reservation checks call `assessReservation` (`assertCanReserve`); missing methods fail closed with `GOVERNOR_UNAVAILABLE` and budget denials map to `GOVERNOR_BUDGET_DENIED` retaining `dimension`, `limit`, `requested`, `remaining`, `taskId`, and `operationId`.
   - Proven non-execution failures (`executionProvenFalse: true`) reconcile reservations to zero token/cost charge so permitted route failovers can proceed.

2. **Opt-In Draft Pull Requests Only (`github-pr.ts`):**
   - Remote push and draft PR creation require explicit `createBranch: true`, `createLocalCommits: true`, `push: true`, and `openPullRequest: true` permissions on the `RunAuthorizationEnvelope`.
   - PRs are created strictly as drafts (`--draft`), embedding the verification summary and QA per-AC divergence brief. Automatic `merge` and `deploy` are forbidden.
