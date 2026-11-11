# ADR 0001: Why / Why Not Multi-Agent — Architectural Tradeoffs in AI-Assisted Software Delivery

- **Status:** Accepted
- **Date:** 2026-11-11
- **Context:** `@evelbulgroz/agent-sdlc` & `@evelbulgroz/model-usage-govenor`
- **Scope:** Delivery Engine Orchestration, Tool Governance, and Verification Boundaries
- **Related Documents:**
  - [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
  - [`reflections.md`](../../reflections.md)
  - [`policy/authorization.ts`](../../policy/authorization.ts)
  - [`execution/minimal-executor.ts`](../../execution/minimal-executor.ts)
  - [`execution/minimal-prompt.ts`](../../execution/minimal-prompt.ts)
  - [`execution/ac-coverage.ts`](../../execution/ac-coverage.ts)

---

## 1. Context and Problem Statement

When embedding autonomous agentic capabilities into a disciplined software architecture (combining Domain-Driven Design, Hexagonal Architecture, and executable quality gates), what is the appropriate level of agentic orchestration?

Specifically: **For the problem of transforming a frozen, human-approved specification and task dependency DAG into verified, reviewable code modifications, does multi-agent orchestration provide enough value to justify its complexity over deterministic and single-agent alternatives?**

In earlier iterations of `@fitness-app/agent-sdlc`, we tested multi-agent decomposition inside the inner execution loop, breaking task turns into specialist roles (e.g., dedicated coder, reader, linter, and autonomous repairer). Concurrently, in Prototype A (Discovery Research Synthesis), we evaluated an unanchored evaluator-optimizer multi-turn critique loop. Both investigations raised the core architectural question:

> *Where does multi-agent orchestration actually earn its place, and where does it introduce self-inflicted failure demand?*

---

## 2. Decision Drivers

1. **Defect Leakage & Semantic Accuracy (Quality):** Generated code must satisfy domain invariants, passing host verification suites without regressions, syntax hallucinations, or ungrounded assumptions.
2. **Harness Complexity & Maintainability:** The orchestration harness must not become a sprawling, brittle "second product" that consumes more engineering maintenance than the host application.
3. **Convergence Reliability:** Multi-task runs must predictably converge to working code rather than entering deadlocks, infinite repair ratchets, or repetitive retry loops.
4. **Economic & Runtime Ceilings (Cost & Latency):** Token consumption and wall-clock execution time must scale linearly with task scope rather than blowing up through unbounded inter-agent chatter.
5. **Human Accountability & Safety (Oversight):** The human engineer must retain non-negotiable ownership over intent, boundaries, and git history without becoming an in-loop bottleneck.

---

## 3. Considered Alternatives

### Alternative 1: Pure Deterministic Workflow (Templates, Linters & AST Codegen)
* **Mechanisms:** CLI-driven code scaffolding, AST transform scripts, static linters, and preflight test suites. Zero LLM calls in the generation loop.
* **Strengths:** 100% reproducible, zero token cost, sub-second execution, zero hallucination.
* **Limitations:** Cannot synthesize novel domain logic, resolve nuanced compiler/test error traces, or adapt existing complex microservice UI/backend implementations to new business intents.

### Alternative 2: Unconstrained Single-Agent Turn Loop (Interactive Vendor Editor)
* **Mechanisms:** A single LLM session (e.g., Cursor, Claude Code, Antigravity) with open repository tool access, guided conversationally by an interactive human developer.
* **Strengths:** Rapid setup for exploratory spikes and single-file modifications.
* **Limitations:** Context window bloat, lack of detached worktree isolation, high risk of semantic drift on multi-task features, and forces the human into an exhausting role as the continuous in-loop orchestrator and review bottleneck.

### Alternative 3: Fine-Grained Inner-Loop Multi-Agent Swarm (Specialist Role Decomposition)
* **Mechanisms:** Decomposing task execution into a swarm of interacting in-loop specialist agents: `ReaderAgent` ➔ `CoderAgent` ➔ `LinterAgent` ➔ `RepairerAgent` ➔ `CriticAgent` communicating via JSON messages inside each task turn.
* **Empirical Reality:** Tested in `@fitness-app/agent-sdlc` between 7 September and 16 October 2026. Resulted in a 5,996-line chaperone harness (`controlled-executor.mjs`), severe retry amnesia, and harness failure demand (>70% rejection of valid work). Similarly, in Prototype A, an unanchored evaluator-optimizer loop doubled token cost and degraded recall on small corpora unless anchored by deterministic regression guards.

### Alternative 4: The Bicameral Architecture — Single-Agent Working-Set Worker with Outer-Loop Heterogeneous Cross-Vendor Critics & Deterministic Floor *(The Selected Architecture)*
* **Mechanisms:**
  1. *Inner Loop ("Loose in the Middle"):* A single, bounded `GovernedWorkingSetWorker` (`execution/minimal-executor.ts`) equipped with discrete atomic tools, raw streams, live working-set compaction (`execution/minimal-prompt.ts`), and a 2-call `AUDIT_REQUIRED` gate.
  2. *Outer Loop ("Tight at the Boundaries"):* A stateful LangGraph orchestrator (`runtime.sqlite`) enforcing `RunAuthorizationEnvelope`, worktree write-containment, execution-backed AC verification (`execution/ac-coverage.ts`), and **mechanically excluding the author vendor from reviewing its own work** via cross-vendor critics (`policy/governor.ts`) across `spec`, `plan`, and `code`.

---

## 4. Empirical Comparison Matrix

The table below contrasts the empirical performance observed across benchmark runs in our engineering laboratory:

| Evaluation Dimension | Alternative 1: Deterministic Workflow | Alternative 3: Inner-Loop Multi-Agent Swarm | Alternative 4: Bicameral (Single Worker + Cross-Vendor Critics) |
| :--- | :--- | :--- | :--- |
| **Quality & Accuracy** | Poor (rigid templates; zero novel synthesis) | Volatile (agents gamed each other's regexes; hallucination cascading) | **High** (deterministic tests verify execution; independent vendor critic catches blind spots) |
| **Harness Complexity** | **Very Low** (standard shell/npm scripts) | **Extreme** (5,996 LOC controller, custom JSON IPC, prompt parsing) | **Low / Lean** (minimal executor <500 LOC; LangGraph outer state machine) |
| **Reliability & Convergence** | 100% deterministic (fails predictably on unknown syntax) | **Catastrophic Failure Demand** (17 failed attempts at 11-task DAG; >70% false rejections) | **High** (11-task DAG converged on first attempt; 39 files, +1,343/-8 LOC in `e0c807dd`) |
| **Latency & Cost** | **Zero tokens**; seconds | **Very High** (2x–4x token blowouts; context duplication across roles) | **Bounded & Governed** (Pre-dispatch budget reservations; warm prefix-cache blocks) |
| **Maintainability** | High | Unmaintainable (patch ratchet: 75 fixes over 137 commits) | **High** (`<=500` LOC navigability ceiling; deleted 32,373 LOC of bloat in `41c30aa6`) |
| **Human Oversight** | 100% human-driven | Opaque agent banter; human forced to debug harness mechanics | **High Leverage (*Jidoka*)**; 4 explicit human decision gates; halts at `READY_FOR_GIT_APPROVAL` |
| **Failure Containment** | Process exit | Leaks state; context window explosions | **Total** (detached git worktree; `realpath` path containment; non-zero line-stop) |

---

## 5. Decision Outcome

### Core Architecture Selection
We **reject** fine-grained multi-agent decomposition inside the execution turn (Alternative 3).  
We **adopt** the **Bicameral Architecture (Alternative 4)**: pairing a single-agent autonomous working-set worker inside the turn with a deterministic verification floor and an outer multi-agent/multi-vendor critic loop.

---

### Why Inner-Loop Multi-Agent Swarms Fail:
1. **The Decomposition Fallacy:** Subdividing code editing into separate "reader", "coder", and "linter" agents creates high-frequency handoff boundaries that destroy working context, blow up prompt ceilings, and induce retry amnesia.
2. **The "Helicopter Chaperone" Anti-Pattern:** Attempting to police an LLM turn by injecting conversational guards (e.g., regex checks on intermediate reads or comments) turns synthesis into a brittle state machine that fights the model's native reasoning priors.
3. **Self-Referential Failure Loops:** In unanchored multi-agent loops, models from the same vendor family share systemic blind spots. When one agent reviews another, they compound each other's hallucinations rather than catching defects.

---

### Where Multi-Agent Earns Its Place (Outer Governance Boundaries):
Multi-agent orchestration earned its keep **only** where two conditions were met:
1. **Adversarial Vendor Independence ("Never Let AI Grade Its Own Homework"):** A single model family suffers from systematic blind spots. Having Claude critique an OpenAI plan, or Gemini critique a Claude implementation, reliably surfaces structural omissions and edge cases that a single agent misses.
2. **Durable, Asynchronous Lifecycle State:** A stateful graph (`LangGraph` + `runtime.sqlite`) is justified on the *outside* to maintain thread state across process exits, pause for human approval gates (`RunAuthorizationEnvelope`, `READY_FOR_GIT_APPROVAL`), enforce budget reservations, and coordinate detached worktrees.

---

## 6. Consequences & System Invariants

### Positive Consequences
* **Radical Code Simplification:** Enabled the deletion of 32,373 LOC of harness bloat (`41c30aa6`), retiring 5 unused roles and returning the entire engine under a strict `<= 500` LOC navigability ceiling.
* **Unattended Convergence:** Enabled multi-task feature specifications (such as the 11-task `conditioning-session-weather` slice) to execute unattended from `SPEC_APPROVED` to `READY_FOR_GIT_APPROVAL`.
* **True Process Ownership:** Decoupled our development workflow from proprietary vendor editor platforms.
* **Jidoka in Practice:** Built-in quality automatically halts the line on abnormalities instead of burning unbounded tokens on doomed repair loops.

### Negative Consequences / Tradeoffs
* **Engine Carrying Cost:** Maintaining `@evelbulgroz/agent-sdlc` and `@evelbulgroz/model-usage-govenor` as custom workspace packages requires ongoing maintenance as provider API schemas evolve.
* **Upfront Specification Discipline:** The factory requires sharp human intent and bounded task DAGs; it cannot guess ambiguous intent.

---

## 7. Traceability and Empirical Evidence Ledger

This decision is backed by the following verifiable repository evidence:

1. **Commit `e0c807dd`:** Inversion from `controlled-executor.mjs` to `minimal-executor.ts`, converging 11 tasks across 39 files (+1,343/-8 LOC) with canonical preflight green.
2. **Commit `41c30aa6`:** Deletion of 32,373 LOC of micro-step state machine bloat (`controlled-executor.mjs`, `repair.mjs`, `AUTONOMOUS_REPAIR_RETIRED`).
3. **Commit `65fb41ce`:** Implementation of token/trace ledgers, per-role attribution, and 7-day run archival.
4. **Execution Contracts:**
   - [`execution/minimal-executor.ts`](../../execution/minimal-executor.ts) (Bounded at $\le$ 150 tool calls, $\le$ 60 minutes, $\le$ 3 verification attempts).
   - [`execution/ac-coverage.ts`](../../execution/ac-coverage.ts) (Proving acceptance criteria execution via automated test runs).
   - [`policy/authorization.ts`](../../policy/authorization.ts) (Cryptographic `RunAuthorizationEnvelope` binding spec, plan, and path prefixes).
