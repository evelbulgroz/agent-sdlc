# AI Software Factory Philosophy & Core Thesis

## 1. First Principles

> **Architectural Rule of Thumb:**  
> *"Code for invariants and mechanisms; Prompts for policy and synthesis; Agents to build and maintain the code."*

We do not use natural language prompts as a replacement for disciplined software engineering. Instead, we use agentic engineering to build traditional, deterministic, type-safe software, reserving LLMs strictly for semantic reasoning, synthesis, and domain-grounded generation where logic cannot easily or economically be expressed in static code.

---

## 2. A Spectrum of AI Software Engineering Setups

```text
[ Traditional CI/CD ] ──────── [ Spec-to-Code Ratchet ] ──────── [ Typed State Graph ] ──────── [ Maximalist Agent ]
 (Deterministic Code)           (Governed Deliverable)           (agent-sdlc Core)              (Pure Prompts/Tokens)
```

| Paradigm | Architecture Archetype | Role of Plain Text / Markdown | Role of Formal Code | Token Appetite | Best Suited For |
|---|---|---|---|---|---|
| **Maximalist Agentic** | Prompt-native runtime; dynamic tool orchestration | **The Runtime Program:** Flow control and state live in prompts. | Minimal glue (CLI wrappers, daemons). | Very High (continuous token burn). | Solo prototypes, high failure tolerance. |
| **Typed State Graph** (`agent-sdlc`) | Deterministic state machine with LLM semantic nodes | **Node-Level Intent:** Structured prompts with strict JSON Schema contracts. | **The Backbone:** Explicit DAGs, state persistence, deterministic transitions. | Moderate (tokens used strictly for semantic nodes). | Governed workflows, auditable multi-step automation. |
| **Spec-to-Code "Ratchet"** | Spec-driven code generation and refinement | **Human-Readable Spec:** Living documentation, specs, and architectural boundaries. | **The Deliverable:** Typed languages, DDD aggregates, unit/integration tests, CI gates. | Batch / Burst (tokens spent at build time; zero at runtime). | Production codebases, team engineering, core domain services. |
| **Frugal Tooling** | Deterministic scripts with selective LLM augmentation | **Semantic Filter:** Narrow extraction, summarization, or semantic diffing. | **90%+ of System:** Scripts and binaries handling I/O, git, and validation. | Minimal (low-token calls). | High-throughput pipelines, constrained budgets. |

---

## 3. Key Trade-Off Dimensions

1. **Token Economics vs. Latency:** Procedural tasks (branch validation, diff auditing, quality scanning, type checking) run in milliseconds at zero token cost via deterministic tools. Invoke an LLM only when synthesis or semantic judgment is required.
2. **Failure Polarity & Blast Radius ($p^n$):** Multi-step sequential LLM pipelines degrade exponentially ($0.95^{10} \approx 0.60$), and negative prompt constraints suffer attention drift. Compilers, type systems, and lint gates fail closed with certainty.
3. **Cognitive Ergonomics across Teams:** Type signatures, JSON schemas, and static gates serve as unambiguous contracts between engineers and agents that cannot be subtly reinterpreted across model updates.

---

## 4. The "Ratchet" Pattern

1. **Prototype fast** in natural language or markdown (`SKILL.md`, specs) to explore capabilities.
2. **Ratchet down to code** as soon as failure modes, token bloat, or non-determinism emerge (graduating recurrent lessons from `.learnings.jsonl` into tests or static checks).
3. **Ground in Institutional Memory ($0 \to 0.85 \to 1.0$):** Agents ingest domain contracts, specs, and scoped project learnings to produce a verified draft ($0 \to 0.85$); the human engineer applies final architectural judgment and Git sign-off ($0.85 \to 1.0$).
