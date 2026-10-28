# Institutional Memory & Learning Graduation

## 1. Capturing Friction: The Native Learnings Store

During autonomous runs, agents encounter friction: critic findings, failing verification commands, or repair iterations. The engine records candidate learnings in `.agent-sdlc/<run-id>/candidate-learnings.json` and host `.agents/learnings.jsonl` via `host/learnings.ts`.

Each entry records:
- `topic`: The architectural or functional domain.
- `rule`: The specific constraint or expectation.
- `trigger`: What caused the friction or error.
- `recommendation`: Concrete corrective action for future agents.

---

## 2. Learning Recall

When planning or drafting tasks in a given area, the engine queries the learnings store for entries matching the target package or scope, injecting high-signal institutional memory directly into prompt contexts.

---

## 3. The Graduation Workflow

Learnings should not remain forever in prompt context:
1. **Recurrent Lessons:** When a learning triggers repeatedly, graduate it down to static code, linters, or tests.
2. **Prompts.pathScopedRules:** For domain rules that cannot be mechanically checked by linters, graduate them into `.agents/sdlc-host.json` `prompts.pathScopedRules`.
3. **Retirement:** Once mechanically guarded by a test or linter, mark the learning graduated to prevent prompt bloat.
