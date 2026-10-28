# CLI & Operator Shell (`packages/agent-sdlc/cli/`)

Command entrypoints, operator shell driver, Human-in-the-Loop (HITL) interrupt handling, and `status.json` continuation projections for `@evelbulgroz/agent-sdlc`.

## Key Files & Entrypoints

- `packages/agent-sdlc/cli/cli.ts` — Thin CLI facade (`agent-sdlc`) and `exitCodeForResult` process exit mapper.
- `packages/agent-sdlc/cli/shell-driver.ts` — Operator shell (`shell start`, `shell status`, `shell reply`, `shell watch`), the only process permitted to drive an orchestrated run for an operator or host chat session.
- `packages/agent-sdlc/cli/commands/index.ts` — Subcommand handlers (`start.ts`, `authorize.ts`, `resume.ts`, `run-lifecycle.ts`, `pr.ts`, `maintenance.ts`, `skills.ts`, `candidate-learning.ts`, `host-check.ts`).
- `packages/agent-sdlc/cli/status-projection.ts` — Status projection facade combining `status-document.ts`, `status-result.ts`, `continuation.ts`, `continuation-card.ts`, and `host-invocation.ts`.
- `packages/agent-sdlc/cli/progress.ts` — Best-effort `stderr` progress line emitter (`<= 240` bytes per line).
- `packages/agent-sdlc/cli/auto-prune.ts` — Detached post-preflight retention sweep trigger (`AGENT_SDLC_AUTO_PRUNE`).

## Core Invariants

1. **Headless State Engine & Operator Shell Boundary:**
   The engine does not host an interactive REPL. When it hits a HITL boundary (`WAITING_FOR_ANSWERS`, `WAITING_FOR_APPROVAL`, `WAITING_FOR_AUTHORIZATION`, or `RECONCILIATION_CONFLICT`), it pauses via LangGraph `interrupt(...)`, persists state in `runtime.sqlite`, and emits structured JSON on `stdout`.
   - `shell start` validates the draft via governor-free `check-spec` first. Unready drafts exit `2` without creating a run. Ready drafts without `--response-file` print a brief (`briefHash`, owning context, and `AC-NN` lines) and exit `2`. Passing `--response-file` with `{"confirm":true,"briefHash":"<briefHash>"}` starts the run once. When `<slug>.tasks.json` sits beside a `.md` goal file, `--task-plan-file` is required.
   - `shell watch` replays mechanical continuations (`resume`, `authorize`) by executing the engine's published `hostInvocation.argv` verbatim without operator prompts or `--retry`, stopping when `continuation.action` is `answer` or `stop`.
   - `shell reply` validates the operator response against the card's `responseSlots` (`choices` and `changes`) before submitting via the card's published `argv`.
   - `shell status` is read-only. On `GIT_APPROVAL`, both `shell status` and `shell watch` stop and print the worktree path without running `git commit`, `git push`, or adding git flags.

2. **Host Continuation Loop & Process Exit Codes (`exit-codes.ts`, `host-invocation.ts`):**
   - The host loop is approve, then authorize with an envelope, then resume until continuation.action is stop or answer by executing hostInvocation. The host does not keep its own retry count. Planning and plan critic run after the envelope is stored.
   - The host runs every executable hostInvocation.argv, including the approval response-file resume and a resume whose retry.allowed is false. packetConsumed true with a null argv is a finished packet when the process exit is 0, 2, 3, or 4.
   - Exit code mapping: `authorize` and `answer` $\to$ `2`; `resume` $\to$ `3`; `stop` with `GIT_APPROVAL` or `COMPLETE` $\to$ `0`; `stop` on `CANCELLED` or `SPEC_REJECTED` $\to$ `4`; other `stop` $\to$ `3`; invalid input/contract $\to$ `64`; policy violation $\to$ `70`.

3. **Infrastructure Retry vs Semantic Repair (`commands/resume.ts`):**
   - Infrastructure `BLOCKED` (`HYDRATION_FAILED`, `GOVERNOR_ROUTES_EXHAUSTED`, or a quota/timeout/transport failure with `executionProvenFalse`) resumes once from its checkpoint (`continuation.reason: 'INFRASTRUCTURE_RETRY'`). A second unchanged failure halts (`continuation.action: 'stop'`, `reason: 'HALTED'`).
   - A modified `tools/.model-usage/local-policy.json` produces a new policy fingerprint (`policy/local-policy-fingerprint.ts`) and re-enables one `INFRASTRUCTURE_RETRY`.
   - Plain `resume` never increments or resets repair counters; `resume --retry` is exclusively for operator-initiated retry after `FAILED` or `ESCALATED`.

4. **In-Flight Observability: Stderr Progress Lines & Live Status Projections (`progress.ts`, `status-projection.ts`):**
   - **Streaming progress lines (`progress.ts`):** Mutating commands (`start`, `resume`, `approve`, `authorize`, `answer`) emit `agent-sdlc: progress <ISO-8601> state=<STATE> revision=<rev> [task=<id>] [role=<role>] [step=<n>] [activity=<model|tool:<name>|tool:other>]` to `stderr` (at most 240 bytes, deduplicating consecutive identical lines). Never emits prompt text, tool arguments, or file paths; sink errors are swallowed so they never alter runtime state.
   - **Live run projections (`status-projection.ts`, `projection-artifacts.ts`):** Every state transition projects machine-readable `status.json` (current state, `runtimeRevision`, per-task DAG status, token/cost summary, pending interrupt/continuation card, and fleet friction summary) alongside human-readable `intent.md`, `plan.md`, `decisions.md`, and `candidate-learnings.json`, inspectable at any time via read-only `agent-sdlc shell status --run <run-id> [--json]`.

## Commands

```bash
# Operator shell (canonical interactive / host-session surface)
agent-sdlc shell start --goal-file docs/specs/drafts/<slug>.md \
  [--task-plan-file docs/specs/drafts/<slug>.tasks.json] [--json]
agent-sdlc shell watch --run <run-id> [--json]
agent-sdlc shell reply --run <run-id> --response-file <path> [--json]
agent-sdlc shell status --run <run-id> [--json]

# Spec validation (governor-free, no run created)
agent-sdlc check-spec --goal-file docs/specs/drafts/<slug>.md \
  [--task-plan-file docs/specs/drafts/<slug>.tasks.json] [--json]

# Headless lifecycle & maintenance subcommands
agent-sdlc list [--json]
agent-sdlc status --run <run-id> [--json]
agent-sdlc cancel --run <run-id> [--json]
agent-sdlc export --run <run-id> --dest export.json [--overwrite] [--json]
agent-sdlc prune-runs [--dry-run] [--json]
agent-sdlc host check [--root <dir>] [--json]
```
