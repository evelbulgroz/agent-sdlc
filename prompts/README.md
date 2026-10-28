# 3-Layer Prompt & Rubric Composition (`packages/agent-sdlc/prompts/`)

Engine-generic role prompts, critic review rubrics, and host-configured 3-layer prompt composition for `@evelbulgroz/agent-sdlc`.

## Key Files & Entrypoints

- `packages/agent-sdlc/roles/role-registry.ts` — 3-layer role prompt composer (`RoleRegistry.loadRole()`, `resolveHostPromptsConfig()`, `loadAndValidatePathScopedRules()`) driven by `.agents/sdlc-host.json` (`prompts.preset`, `prompts.roleAddendaDir`, `prompts.pathScopedRules`).
- `packages/agent-sdlc/review/critic-prompt.ts` — 3-layer critic rubric composer (`loadRubric()`, `buildPhasePrompt()`) driven by `.agents/sdlc-host.json` (`prompts.preset`, `prompts.rubricAddendaDir`, `prompts.pathScopedRules`).
- `packages/agent-sdlc/roles/defaults/` — Built-in role protocol prompts (`packages/agent-sdlc/roles/defaults/protocol/<role>.md`) and default engineering philosophy addenda (`packages/agent-sdlc/roles/defaults/philosophy/<role>.md`).
- `packages/agent-sdlc/review/defaults/` — Built-in critic rubric protocol contracts (`packages/agent-sdlc/review/defaults/protocol/<phase>.md`) and default review philosophy addenda (`packages/agent-sdlc/review/defaults/philosophy/<phase>.md`).

## Core Invariants

1. **Three-Layer Composition & `.agents/workflows/` Override Resolution (`role-registry.ts`, `critic-prompt.ts`):**
   - **Layer 1 (Engine Protocol Base):** Domain-neutral output contracts and tool-boundary rules loaded from `packages/agent-sdlc/roles/defaults/protocol/<role>.md` and `packages/agent-sdlc/review/defaults/protocol/<phase>.md`.
   - **Layer 2 (Preset Engineering Philosophy):** Included when `prompts.preset` is `"default"` (the default when omitted) from `packages/agent-sdlc/roles/defaults/philosophy/<role>.md` and `packages/agent-sdlc/review/defaults/philosophy/<phase>.md`; skipped when `prompts.preset === "none"`.
   - **Layer 3 (Host Addenda & Path-Scoped Rules):** Optional repository-local role addenda under `prompts.roleAddendaDir` (default `.agents/workflows/prompts/<role>.md`), optional critic rubric addenda under `prompts.rubricAddendaDir` (default `.agents/review-rubrics/<phase>.md`), and `prompts.pathScopedRules` matched deterministically against `authoredPaths` / `touchedFiles`, role ID, and critic phase.
   - **Zero-config client onboarding:** Because Layers 1 and 2 live inside `packages/agent-sdlc/roles/defaults/` and `packages/agent-sdlc/review/defaults/`, new client repositories do not need `.agents/workflows/` or `.agents/review-rubrics/` unless they want repo-specific Layer 3 addenda.
   - **Non-executable prompt guard:** Every composed layer and path-scoped rule is validated through `rejectExecutablePrompt()` in `packages/agent-sdlc/roles/role-registry.ts`.
