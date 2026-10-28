# AGENTS.md — @fitness-app/agent-sdlc

Private workspace package providing the local SDLC orchestration engine (`packages/agent-sdlc`).

## Critical Rules

1. **Explicit Git Approval**: DO NOT commit, branch, or push unless the operator explicitly approves that action in chat. Local file changes only by default.
2. **Platform & Toolchain**: Linux/WSL only (`node >= 22.18.0`, `pnpm install`). Use `pnpm` exclusively.
3. **SDLC Automation & Authorization Boundary**: Engine runs follow headless JSON `continuation` (`cli/status-projection.ts`). Runs require an explicit `RunAuthorizationEnvelope` bound to `approvedSpecHash`, `baseCommitSha`, `allowedPackages`, and `allowedPathPrefixes`. The plan critic freezes `taskPlanHash` before creating worktrees. The engine enforces path containment and halts at `READY_FOR_GIT_APPROVAL` (or `DONE` if authorized).
4. **Dynamic Critic Review Protocol**: Heterogeneous critic reviews run on dedicated graph nodes (`spec`, `plan`, `qa`, and standalone `code`). Governor consumer profile: `critic-review`. Reviewers fail closed on matching/unknown vendor. Critic review is evidence, never merge trust.
5. **Reliability & Unmerged Canary Invariant**: Offline replay (`agent-sdlc reliability replay`) is deterministic and token-free. Never commit or merge the canary worktree to `main` so canary `@ac` test citations never enter the host baseline.
6. **Pre-Emit Verification**: Before flagging any bug or regression in review/triage, quote the exact code and reproduction evidence proving it exists. Add boundary test cases when implementing.
7. **Repair Budget**: Max 2 autonomous repair iterations per failing check before stopping to escalate.
8. **No Masking**: Never delete test assertions, weaken invariants, or mutate quality baselines. Prefer fixing the root cause.
9. **Navigability Ceilings**: Every file must remain within <= 500 lines and <= 20,480 bytes.

## Development & Packaging Directives

1. **Native Node Type Stripping**: `tsconfig.json` maintains `noEmit: true`, `erasableSyntaxOnly: true`, and `verbatimModuleSyntax: true`. In-source relative imports use explicit `.ts` extensions.
2. **Build Emission**: `tsconfig.build.json` compiles to `dist/` with rewritten `.js` specifiers and copies `roles/defaults` and `review/defaults`.
3. **Self-Sufficiency**: Host root discovery uses `resolveRepositoryRoot()`. Fall back to bundled planning files and policy defaults when absent in host.
4. **Status Lead**: End implementation turns with what changed, what was skipped, and verification command results.

## Documentation

- `./README.md` (package overview, installation, host onboarding, CLI quickstart, and development/testing)
- `./ARCHITECTURE.md` (architectural intent, design principles, and outer/inner loop orchestration)
- Module documentation:
  - `./cli/README.md` — Operator shell (`shell start/watch/reply/status`), CLI subcommands, `status.json` continuation projection, and exit codes
  - `./workflow/README.md` — LangGraph state graph, detached worktrees, lazy hydration, patch reconciliation, and git delivery
  - `./execution/README.md` — `minimal-executor.ts` loop, allowlisted tools, path containment, `@ac` coverage, and failure traces
  - `./review/README.md` — Heterogeneous critic review (`spec`, `plan`, `qa`, standalone `code`), excerpt packing, and preflight verifier
  - `./persistence/README.md` — `runtime.sqlite` event store, artifacts, and 7-day run retention/compaction (`prune-runs`)
  - `./policy/README.md` — `RunAuthorizationEnvelope`, Task DAG planning, `SdlcError` taxonomy, and reliability/canary gates
  - `./roles/README.md` — Role/capability registries, semantic cognitive tiering, upstream learning recall, and trace-skill learning
  - `./adapters/README.md` — Model usage governor bridge (`@fitness-app/model-usage`) and GitHub draft PR adapter
  - `./host/README.md` — `.agents/sdlc-host.json` (`1.3.0`) schema, native learnings store, and `fitness-app` / `script` host adapters
  - `./ledger/README.md` — Per-run model usage ledger records and archive snapshots
  - `./prompts/README.md` — 3-layer prompt and critic rubric composition

## Commands

| Task | Command |
|------|---------|
| CLI | `agent-sdlc` (`pnpm --filter @fitness-app/agent-sdlc run sdlc`) |
| Review CLI | `agent-review` (`pnpm --filter @fitness-app/agent-sdlc run review`) |
| Trace Summary | `agent-sdlc-trace` (`pnpm --filter @fitness-app/agent-sdlc run trace`) |
| Critic & Skill Trends | `agent-sdlc-trends` (`pnpm --filter @fitness-app/agent-sdlc run trends`) |
| Package Unit Tests | `pnpm --filter @fitness-app/agent-sdlc run test:unit` |
| Package Typecheck | `pnpm --filter @fitness-app/agent-sdlc run typecheck` |
| Build | `pnpm --filter @fitness-app/agent-sdlc run build` |

## Local Done Bar

Before claiming an implementation task is done in this package:

```bash
pnpm --filter @fitness-app/agent-sdlc run build && pnpm --filter @fitness-app/agent-sdlc run typecheck && pnpm --filter @fitness-app/agent-sdlc run test:unit && node packages/agent-sdlc/cli/cli.ts reliability replay
```
