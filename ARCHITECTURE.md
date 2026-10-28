# Architecture & Design Principles (`packages/agent-sdlc/`)

Conceptual architecture, design principles, and outer/inner loop orchestration for the local-first LangGraph SDLC Workflow Orchestrator and Dynamic Critic Review specialist (`@fitness-app/agent-sdlc`, a private workspace package consuming `@fitness-app/model-usage` at `packages/model-usage`).

For installation, host repository onboarding, CLI reference, and development/testing commands, see [`README.md`](./README.md) and [`AGENTS.md`](./AGENTS.md).

---

## 1. Architectural Intent & Design Principles

The SDLC Workflow Orchestrator automates the development lifecycle from a structured specification to a verified, critic-reviewed, and optionally locally committed implementation ready for operator Git signoff.

It was created not to compete with commercial cloud agent platforms, but as a personal lab for exploring autonomous agentic software engineering emphasizing:
- Strict cost governance
- A deliberate balance between probabilistic and deterministic execution
- Model vendor independence
- Full local workflow ownership
- In-flight observability and retrospective cost, reliability, and trace analytics that compound run evidence into iterative workflow improvements

> **Governing Maxim:** *Code for invariants and mechanisms; Prompts for policy and synthesis; Agents to build and maintain the code.*

1. **Local-first and autonomous:** Runs entirely within the local repository on Node.js 22 (`>= 22.18.0` with native `.ts` type stripping where `node -p process.features.typescript` prints `strip`) and LangGraph JS/TS—without cloud agent platforms, LangSmith, or external CI runners.
2. **Governed model invocations:** 100% of LLM calls route through `packages/model-usage/governor.ts` (`@fitness-app/model-usage`) under consumer `agent-sdlc`, with pre-dispatch budget reservations and immutable attempt accounting.
3. **Strict human authorization:** Workspace mutations require an affirmative `RunAuthorizationEnvelope` (`packages/agent-sdlc/policy/authorization.ts`). Git branch, commit, push, and draft PR operations require explicit envelope flags; `merge` and `deploy` are permanently forbidden.
4. **Deterministic verification as exit criterion:** No model approves its own work. Canonical local done is the host verification gate in `.agents/sdlc-host.json` (`verify.argv`—progressive across Tier 1 `npm test` default, Tier 2 custom exit-code command, and Tier 3 receipt-backed `pnpm run agent:preflight` with `status=OK canonical=true`; see [`host/README.md`](./host/README.md)).
5. **In-flight observability, retrospective analytics & compounding memory:** Active runs stream secret-safe `stderr` progress lines and project live state, task DAG status, and HITL continuation cards (`status.json`, `intent.md`, `plan.md`, `decisions.md`; see [`cli/README.md`](./cli/README.md) and [`persistence/README.md`](./persistence/README.md)). Across runs, the engine recalls high-confidence project learnings (`packages/agent-sdlc/roles/upstream-recall.ts`), stages new candidate learnings, and exposes retrospective analytics across per-role token/cost ledgers ([`ledger/README.md`](./ledger/README.md)), failure-fingerprint trace diagnostics ([`execution/README.md`](./execution/README.md)), stratified reliability and route-comparison reports ([`policy/README.md`](./policy/README.md)), and 3-run anti-overfitting critic/skill trend ratchets ([`roles/README.md`](./roles/README.md)).

### Non-Goals
- Automatic `merge` or `deploy` operations (forbidden by contract).
- Unbudgeted model calls bypassing `packages/model-usage/governor.ts`.
- Autonomous LLM conflict resolution on patch integration conflicts (halts for human resolution).
- Critic review as a preflight blocker (preflight remains 100% deterministic, offline, and token-free; QA critic inspects static logs rather than executing test suites).

---

## 2. Cross-Cutting Orchestration: Outer & Inner Loops

```text
  OUTER LOOP (LangGraph State Machine & Operator Shell — workflow/, cli/, policy/, review/)
  ─────────────────────────────────────────────────────────────────────────────────────────
  Host Spec Draft ──► Spec Critic (phase=spec, ≤2) ──► Human Approval (SPEC_APPROVED)
        │
        ▼
  RunAuthorizationEnvelope ──► Task DAG Plan ──► Plan Critic (phase=plan, ≤2) & PLAN_FROZEN
        │
        ▼
  Detached Worktrees & Lazy Hydration (tools/.agent-sdlc/<run-id>/worktree[s])
        │
        ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │ INNER LOOP: "Loose in the Middle, Tight at the Boundaries" (execution/)   │
  │   Observation ──► Reasoning ──► Discrete Tool Action (read/edit/grep/cmd) │
  │        ▲                                                │                 │
  │        └────────── Raw stdout/stderr & working-set ─────┘                 │
  │ • Boundaries: path containment, governor budgets, targeted test feedback, │
  │   two-call AUDIT_REQUIRED completion gate, and declared task verification │
  └───────────────────────────────────────────────────────────────────────────┘
        │
        ▼
  Binary Patch Reconciliation ──► Semantic Review (reviewer)
        │
        ▼
  Deterministic Preflight (agent:preflight) ──► AC Coverage (@ac AC-NN) ──► QA Critic (phase=qa)
        │
        ▼
  Terminal Completion: READY_FOR_GIT_APPROVAL (default) or DONE (when git-authorized)
```

### Outer Loop Invariants
- **Authorization & Frozen Plan Guard:** Moving past `SPEC_APPROVED` requires a `RunAuthorizationEnvelope` binding `approvedSpecHash`, `approvedPlanPolicyHash`, `baseCommitSha`, `allowedPackages`, and `allowedPathPrefixes` ([`policy/README.md`](./policy/README.md)). Creating any detached worktree requires `taskPlanFrozen === true` (`packages/agent-sdlc/workflow/worktree-guard.ts`).
- **Heterogeneous Critic Placement:** Graph nodes run `spec` (before `SPEC_APPROVED`), `plan` (before worktree creation), and `qa` (once per `approvedSpecHash` after green preflight and AC coverage). `phase=code` runs exclusively via standalone `agent-review --phase code`, never from a graph node ([`review/README.md`](./review/README.md)).
- **Binary Patch Reconciliation:** Multi-task deltas apply sequentially to `worktrees/integration` via `git apply --check`; conflicts halt via HITL interrupt with zero automated LLM merges ([`workflow/README.md`](./workflow/README.md)).

### Inner Loop Philosophy: "Loose in the Middle, Tight at the Boundaries"
The sole implementer is `packages/agent-sdlc/execution/minimal-executor.ts` (`--executor minimal`, capped at 150 calls, 60 minutes, and 3 attempts; see [`execution/README.md`](./execution/README.md)). Within a turn, the model receives atomic tool schemas and raw secret-redacted `stdout`/`stderr` while the harness enforces strict perimeter invariants (isolated worktrees, exact authored-path write containment, governor token reservations, execution-backed `@ac` test evidence, and deterministic verification).

**Four Anti-Patterns Never to Reintroduce:**
1. *No regex error interceptors ("Helicopter Chaperone"):* Deliver raw compiler/test output rather than brittle framework-specific prompt addenda.
2. *No nullable bundled mega-tool schemas:* Expose discrete, atomic tool parameter schemas.
3. *No comment policing over executable assertions:* Ground `@ac AC-NN` verification in executed, passing test assertions (`packages/agent-sdlc/execution/ac-coverage.ts`).
4. *No micro-step state machines:* Enforce determinism at the boundaries (worktrees, path guards, budgets, preflight), not by micromanaging intermediate reads.

### Operator Shell & Workflow Interleaving

The CLI engine is a **headless, batch-oriented state machine** backed by `runtime.sqlite`. `shell` (`packages/agent-sdlc/cli/shell-driver.ts`, documented in [`cli/README.md`](./cli/README.md) and the `agent-sdlc-shell` skill) is the only surface that drives a run for an operator or host chat session:

1. **Draft & Validate in Chat:** The host agent interviews the operator (`/grill-me`), authors `docs/specs/drafts/<slug>.md` (and optional `<slug>.tasks.json`) per `specification-workflow`, and validates readiness via governor-free `check-spec`.
2. **Brief-Then-Confirm Start:** `shell start` runs `check-spec`, prints a brief (`briefHash`, owning context, and `AC-NN` lines) on first call (exit `2`, no run created), and starts the run once `--response-file` confirms that exact `briefHash`.
3. **Mechanical Continuation (`shell watch`) & Validated Replies (`shell reply`):**
   The host loop is approve, then authorize with an envelope, then resume until continuation.action is stop or answer by executing hostInvocation. The host does not keep its own retry count. Planning and plan critic run after the envelope is stored. The host runs every executable hostInvocation.argv, including the approval response-file resume and a resume whose retry.allowed is false. packetConsumed true with a null argv is a finished packet when the process exit is 0, 2, 3, or 4.
4. **Git Approval Boundary:** At `READY_FOR_GIT_APPROVAL` (`continuation.reason: 'GIT_APPROVAL'`, exit `0`), `shell watch` and `shell status` stop and print the worktree path without running `git commit`, `git push`, or adding git flags.
