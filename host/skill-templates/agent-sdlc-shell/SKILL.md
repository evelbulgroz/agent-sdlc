---
name: agent-sdlc-shell
description: Drive an agent-sdlc run through the operator shell (shell start/status/reply/watch), the only surface permitted to invoke the engine. Use once a spec is drafted or an agent-sdlc run needs a continuation, approval, or reply.
---

Use this skill whenever a conversation needs to start, check, or advance an
`agent-sdlc` run. The host model drafts in this conversation
(`specification-workflow`). It executes no `agent-sdlc` command other than
`shell`.

Read `$AGENT_SDLC_PATH/cli/README.md` before invoking `shell`. That file is
the shell contract: brief confirmation, sibling task and obligations files,
watch, reply, status, and exit codes.

## When to use

- A spec draft (`docs/specs/drafts/<slug>.md`) is ready to become a run.
- An existing run needs its status checked, a mechanical continuation
  replayed, or an operator reply submitted.

## Host command

Invoke the engine through the host script. Include a sibling flag when
`$AGENT_SDLC_PATH/cli/README.md` requires it. Replace `agent:sdlc` below
when the host script has another name.

```bash
pnpm run agent:sdlc -- shell start --slug <slug> --goal-file docs/specs/drafts/<slug>.md \
  --obligations-file docs/specs/drafts/<slug>.obligations.json \
  --task-plan-file docs/specs/drafts/<slug>.tasks.json --json
pnpm run agent:sdlc -- shell watch --run <run-id> --json
pnpm run agent:sdlc -- shell reply --run <run-id> --response-file <path> --json
pnpm run agent:sdlc -- shell status --run <run-id> --json
```

`specification-workflow` owns the shape of `<slug>.obligations.json`.

## Git

When the run stops for git approval, review the diff in chat and ask the
operator before any git command.
