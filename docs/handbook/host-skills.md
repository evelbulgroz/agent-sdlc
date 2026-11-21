# Host shell and specification skills

Copy two skills into a new host so its chat model can draft a run-starting spec and drive the engine. `agent-sdlc host scaffold` writes a profile draft and does not write these skills. The skills under this repository's `.agents/skills/` are for working on the engine.

## Copy

1. Point `AGENT_SDLC_PATH` at this engine checkout. The published `dist/` tree does not include the templates.
2. Add a host package script that runs `node "$AGENT_SDLC_PATH/cli/cli.ts"`. The shell template's script name is `agent:sdlc`. If the host uses another name, change it in the copied shell skill.
3. Copy these directories into the host `.agents/skills/`:
   - `host/skill-templates/agent-sdlc-shell`
   - `host/skill-templates/specification-workflow`
4. Leave `AGENT_SDLC_PREFERRED_ROUTES` unset.
5. Add host-only drafting rules (interview, architecture notes, the host verify command) in the copied specification skill.

## What each skill owns

| Skill | Owns |
|---|---|
| `agent-sdlc-shell` | `shell start`, `shell watch`, `shell reply`, and `shell status` only. It reads `$AGENT_SDLC_PATH/cli/README.md` before it invokes `shell`. |
| `specification-workflow` | Draft headings, acceptance-criteria grammar, and the product obligations document. |

Sibling task and obligations flags stay in [`../../cli/README.md`](../../cli/README.md). Task-manifest ceilings stay in [`../../policy/README.md`](../../policy/README.md). The host profile stays in [`../../host/README.md`](../../host/README.md).

When a run stops for git approval, the shell skill asks the operator before any git command.
