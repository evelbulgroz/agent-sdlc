# Costs, benefits, and architectural reflections on an autonomous software factory

This note records the September–October 2026 ledger for `@fitness-app/agent-sdlc` (`packages/agent-sdlc/`) and `@fitness-app/model-usage` (`packages/model-usage/`) against an interactive vendor editor agent (Cursor, Antigravity, Claude Code, Grok, or Copilot) and against subprocess-based multi-agent harnesses such as Uncle Bob Martin's SwarmForge.

The factory is a local LangGraph state machine: governed model calls, isolated git worktrees, deterministic verification (`pnpm run agent:preflight` or the host's configured `verify` tier) as the exit gate, and an operator shell (`agent-sdlc shell`) that drives `hostInvocation` packets between a chat host and the headless worker. The comparison fits one human authorization (`RunAuthorizationEnvelope`), followed by an unattended multi-task run that halts for human git sign-off. It is the wrong baseline when daily work stays interactive pairing.

---

## 1. Timeline & Cost Base (September–October 2026)

1. **Initial Build & The First Chaperone Growth (7 September – 7 October):**
   - `tools/agent-sdlc` and `tools/model-usage` accumulated ~137 commits (75 of them fixes). The initial vertical slices landed by 9 September, and the first hosted one-task canary finished inside its step budget on 5–6 October.
   - During this month, `controlled-executor.mjs` grew from ~400 lines to ~3,500 lines as every model misstep was answered with another in-loop guard.
2. **The "Infinite Patch Ratchet" Peak (7 October – 16 October):**
   - Attempting to scale from one-task canaries to real multi-task product specs (56 multi-task runs and 17 runs of the 11-task `conditioning-session-weather` slice) exposed severe brittleness.
   - `controlled-executor.mjs` and its companion `programmer-turn.mjs` ballooned to nearly **6,000 lines** (`5,996` LOC). Runs repeatedly died on self-inflicted harness constraints: 4-window read caps, prompt-budget blowouts from raw append-only transcripts, retry context amnesia, and over-strict `@ac` string policing that failed working code with passing tests more than 70% of the time.
3. **The SwarmForge Review & Inner-Loop Inversion (16–17 October):**
   - A forensic review against Uncle Bob Martin's SwarmForge project diagnosed the root cause: the factory had blurred the boundary between deterministic invariants and probabilistic synthesis.
   - Replacing the micromanaged loop with the SwarmForge-inspired `GovernedWorkingSetWorker` (`packages/agent-sdlc/execution/minimal-executor.ts`) immediately converged the 11-task weather spec (`e0c807dd`) and unlocked subsequent multi-task product features and C3 decompositions.
4. **Retirement, Structural Deepening & Package Extraction (20–27 October):**
   - Over ~110 additional October commits across an 18-spec factory overhaul, `controlled-executor.mjs`, `programmer-turn.mjs`, `repair.mjs`, and autonomous outer repair loops (`AUTONOMOUS_REPAIR_RETIRED`) were deleted (`41c30aa6`).
   - Both `packages/agent-sdlc` and `packages/model-usage` were decomposed into capability subfolders under a hard navigability ceiling (`<= 500` lines and `<= 20,480` bytes per file), converted to strict TypeScript running on Node 22 native type stripping (`erasableSyntaxOnly`), equipped with 7-day run archival and token/trace analytics, and extracted into self-contained private workspace packages onboarding repositories via a single declarative `.agents/sdlc-host.json` (`1.3.0`).

---

## 2. Key Insights from the SwarmForge Review & Refactoring

### Oversight, Training Priors, and the Four Anti-Patterns

The single largest source of wasted tokens during the build was **limiting human architectural oversight early on and trusting coding agents too much to diagnose and repair the factory itself**.

When an autonomous run failed, handing the failure trace back to an interactive agent with light supervision produced a predictable pathology: the agent patched the symptom by adding another mechanical restriction to the harness. Left unchecked across dozens of iterations, the agents repeatedly fell into **four anti-patterns**:

1. **Regex Error Interceptors ("The Helicopter Chaperone"):** Parsing compiler or test output with regexes to inject framework-specific prompt addenda (e.g., special-casing Vitest `jsdom` docblocks or Nest DI errors) instead of handing the model raw `stdout`/`stderr`.
2. **Nullable Bundled Mega-Tool Schemas:** Packing every possible tool action into a single monolithic JSON schema with dozens of nullable fields—requiring provider-specific schema compilers, strict-mode padding, and constant repair when models hallucinated parameter combinations.
3. **Comment Policing over Executable Assertions:** Enforcing rigid string placement rules for `@ac AC-NN` and `@case AC-NN.N` tags (rejecting `@ac` placed on an enclosing `describe()` block or rejecting table-driven `it.each` cases) even when the underlying test suite executed and passed.
4. **Micro-Step State Machines:** Dictating the exact sequence of reads, searches, and edits inside the turn loop (`controlled-executor.mjs`, `programmer-turn.mjs`, 4-window read caps, search lockouts after four queries, and single-file gather menus) until the model was starved of context.

**Why agents struggle with software factories more than commonplace tasks:**
Current-generation frontier models have deep training-data priors for high-frequency software engineering tasks—such as adding a metric card to a React UI, wiring a standard REST controller, or writing CRUD unit tests. On those well-trodden paths, light human oversight is often enough because the model's default completions align with established idioms.

Autonomous software factories and meta-orchestration harnesses sit near the leading edge and are sparsely represented in model training corpora. Lacking strong architectural priors for how to govern another probabilistic model without suffocating it, coding agents default to local defensive programming: every stochastic tool error is treated as a deterministic bug requiring a new guard clause. **Innovation near the leading edge requires substantially higher human engagement and architectural taste than routine product work.**

### "Loose in the Middle, Tight at the Boundaries"

Comparing the stalled 6,000-line controller against Uncle Bob Martin's SwarmForge clarified that the repository's governing maxim—*"Code for invariants and mechanisms; Prompts for policy and synthesis; Agents to build and maintain the code"*—was right, but had been misapplied inside the inner loop. How an agent sequences file reads, searches, and intermediate edits is *synthesis*, not an invariant.

The refactored inner loop (`packages/agent-sdlc/execution/minimal-executor.ts`, the sole implementer) enforces **"Loose in the Middle, Tight at the Boundaries"**:

- **Loose in the middle:** Inside a task turn (capped at 150 tool calls, 60 minutes, and 3 verification attempts), the model receives discrete, atomic tool schemas (`read_file`, `grep`, `list_dir`, `find_files`, `write_file`, `replace_in_file`, `replace_snapshot_range`, `delete_file`, `run_allowlisted_command`) and raw secret-redacted `stdout`/`stderr`. There are no regex error interceptors, no read-window lockouts, and no micro-step state machines.
- **Stateful working-set prompt & zero retry amnesia:** Instead of an unbounded append-only tool dump that blows prompt ceilings or a hard reset on Attempt 2 that forces 20 redundant file reads, `minimal-prompt.ts` keeps `promptBlocks[0]` byte-identical (warming provider prefix caches), elides historical write payloads, collapses superseded `read_file` outputs, renders live working-set views with `expected_file_hash`, and preserves compacted tool history across verification retries.
- **Two-call `AUDIT_REQUIRED` completion gate:** Borrowed directly from SwarmForge's handoff discipline, the first `{ kind: "complete" }` call runs deterministic verification and returns a self-audit challenge without burning a retry attempt. The task finishes only when the model audits its live working set against every AC and boundary rule and submits a second `{ kind: "complete" }` against the unchanged working-tree digest.
- **Tight at the boundaries:** While SwarmForge delegates inner loops to un-governed vendor CLI subprocesses (`claude`, `codex`, `grok`), `@fitness-app/agent-sdlc` retains a governed in-process worker (`GovernedWorkingSetWorker`) so that every call still passes through `packages/model-usage/governor.ts` for pre-dispatch budget reservation, mid-task vendor failover, and provider-free deterministic replay. Hard mechanical boundaries stay strictly outside the model's reasoning loop: `RunAuthorizationEnvelope`, frozen task plans before worktree creation, `realpath` write containment to declared `authoredPaths`, execution-backed `@ac` test verification (`ac-coverage.ts`), heterogeneous critic review (`spec`, `plan`, `qa`), and canonical host verification (`verify.argv`).

---

## 3. Updated Costs and Benefits Against a Vendor Editor Agent

### Costs

- **Front-loaded build & over-delegation tax.** A usable one-task canary arrived weeks after the initial graph was wired, and a reliable multi-task executor arrived only after paying down the 6,000-line `controlled-executor.mjs` detour caused by trusting agents to patch the harness with insufficient human review.
- **Provider adapter & schema portability maintenance.** Even with atomic tool schemas, routing across OpenAI, Anthropic, Google Gemini, and xAI behind `packages/model-usage/governor.ts` carries ongoing maintenance: strict-mode schema rules, reasoning-effort parameters, prompt-cache breakpoint semantics, token-detail accounting, and credit-depletion failover patterns.
- **Outer control plane overhead.** An interactive editor agent never pays for `status.json` continuation cards, exit codes that distinguish pause from retry, `RunAuthorizationEnvelope` hashes bound to `baseCommitSha`, lockfile refresh containment, or worktree hydration. That machinery exists because the conversational host and the batch worker are separate processes.
- **Slower rule iteration than a chat prompt.** Updating a deterministic gate or executor contract changes planning hashes, invalidates canary qualification, and requires test updates across `packages/agent-sdlc`. However, once a boundary invariant or `<= 500` LOC navigability rule is encoded in tests, it does not drift across model versions.
- **Second-product carrying cost.** Even after retiring the controlled executor and 5 inactive roles and enforcing a 500-line ceiling per module, `@fitness-app/agent-sdlc` and `@fitness-app/model-usage` remain a substantial local codebase maintained alongside the fitness application.

### Benefits

- **Predictable multi-task convergence.** With `minimal-executor.ts`, working-set compaction, `AUDIT_REQUIRED`, and strict `< 500` LOC module boundaries, multi-task specifications (10+ tasks across domain, application, persistence, and UI layers) execute unattended from `SPEC_APPROVED` to `READY_FOR_GIT_APPROVAL`.
- **Metered unattended stretch & governor ceiling.** Pre-dispatch reservations, per-run token/cost caps, and route exhaustion bound spend. Preflight, git worktree isolation, path containment, and AST/schema checks run locally at zero token cost. Spec interviewing (`/grill-me`) stays in the interactive host session; governed API spend starts only after spec approval and authorization.
- **Vendor independence & heterogeneous review.** Disabling a degraded model route or swapping implementer vendors requires a policy edit, not a workflow rewrite. Critic review nodes (`spec`, `plan`, `qa`, plus standalone `agent-review --phase code`) mechanically exclude the author vendor via `governor.ts`.
- **Uncompromised repository done bar.** No model can self-approve its work, weaken a test oracle (`*.oracle.spec.ts`), or bypass the configured verification tier (`agent:preflight` with `status=OK canonical=true` in this monorepo). Execution-backed `@ac` verification proves that every acceptance criterion and sub-case is cited by a test that actually ran and passed.
- **Crash-resilient, replayable state.** A dead editor chat does not lose the run. SQLite event persistence (`runtime.sqlite`), 7-day compacted run archives (`.agent-sdlc/.archive/index.jsonl`), failure-fingerprint traces (`agent-sdlc-trace`), and the offline reliability replay corpus make failures inspectable and reproducible without burning provider tokens.
- **Portable host seam.** Extracting `@fitness-app/agent-sdlc` and `@fitness-app/model-usage` into self-contained workspace packages with built-in role/prompt defaults and a single `.agents/sdlc-host.json` (`1.3.0`) profile means the engine can be installed once per machine and pointed at new repositories with a one-file `npm test` verification tier before graduating to receipt-backed preflight gates.

---

## 4. When This Ledger Applies

- **Fits an unattended, spec-driven factory.** Best when the operator invests upfront human judgment in the specification, task slicing, and architectural boundaries (`/grill-me`, `specification-workflow`), issues one `RunAuthorizationEnvelope`, and steps away while the engine delivers a verified, critic-reviewed worktree ready for human git sign-off.
- **Overstates routine interactive pairing.** For quick exploratory prototypes or trivial single-file edits, an interactive editor agent already supplies the conversational loop without the ceremony of spec hashing, worktree hydration, and continuation cards.
- **Requires human leadership on frontier architecture.** Delegate well-understood product slices to the unattended loop; keep a short leash and high human engagement whenever designing or refactoring the factory's own abstractions.
