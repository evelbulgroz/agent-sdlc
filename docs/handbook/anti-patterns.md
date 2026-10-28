# Anti-Patterns & Prohibitions in Agentic SDLC

## 1. The "Infinite Patch Ratchet" (Helicopter Chaperoning)

A common failure mode in AI engineering is attempting to micromanage agent output via brittle regex interceptors, microscopic state-graph steps, and comment-policing prompt addenda. This leads to fragile, unmaintainable agent pipelines.

Instead, `agent-sdlc` enforces:
> **"Loose in the middle, tight at the boundaries."**

- **Loose in the middle:** The implementer has freedom inside its isolated worktree to explore, edit, run tests, and refine code using standard tools.
- **Tight at the boundaries:** The engine strictly enforces authorization envelopes, path containment, timeout budgets, preflight verification, and git sign-off.

---

## 2. Autonomous Repair Budget (Max 2 Iterations)

When verification gates or tests fail:
- The engine allows up to **2 autonomous repair iterations**.
- If the gate does not pass after 2 attempts, the run halts immediately to escalate to human operators rather than entering a costly retry storm.

---

## 3. The Unmerged Canary Invariant

Hosted canary runs qualify that orchestration logic, planning bindings, and prompt templates are functioning without regressions:
- Canary fixtures test minimal, unmerged slices.
- **Invariant:** Never commit or merge the canary worktree into `main`. Merging canary test citations pollutes the baseline `@ac` test coverage matrix (`ac-coverage.ts`), masking future verification omissions.
