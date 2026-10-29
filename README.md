# LangGraph SDLC Workflow Automation

**Living home** for the local-first LangGraph SDLC Workflow Orchestrator and Dynamic Critic Review specialist (`@evelbulgroz/agent-sdlc`, consuming `@evelbulgroz/model-usage-govenor`).

The engine automates the development lifecycle from a structured specification to a verified, critic-reviewed, and optionally locally committed implementation ready for operator Git signoff—routing 100% of model invocations through the Model Usage Governor (`@evelbulgroz/model-usage-govenor`), requiring an affirmative `RunAuthorizationEnvelope` (`policy/authorization.ts`) before workspace mutations, and enforcing the host verification gate in `.agents/sdlc-host.json` (`verify.argv`—progressive across Tier 1 `npm test` default, Tier 2 custom exit-code command, and Tier 3 receipt-backed `pnpm run verify:receipt` with `status=OK canonical=true`).

**Canonical references:**
- **Architecture, design principles & outer/inner loops:** [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- **AI software factory philosophy:** [`docs/philosophy.md`](./docs/philosophy.md)
- **Operator shell & authorization boundary:** [`docs/operator-shell-and-authorization.md`](./docs/operator-shell-and-authorization.md)
- **Dynamic critic review protocol:** [`docs/critic-protocol.md`](./docs/critic-protocol.md)
- **Anti-patterns & prohibitions:** [`docs/anti-patterns.md`](./docs/anti-patterns.md)
- **Institutional memory & learnings:** [`docs/institutional-memory.md`](./docs/institutional-memory.md)
- Governed model execution: [`@evelbulgroz/model-usage-govenor`](https://github.com/evelbulgroz/model-usage-govenor)
- Package agent operating contract: [`AGENTS.md`](./AGENTS.md)
- Host profile & workspace adapters: [`host/README.md`](./host/README.md)
- Policy, authorization & task planning: [`policy/README.md`](./policy/README.md)

---

## 1. Package Layout & Module Documentation

Detailed subsystem documentation lives in co-located module READMEs:

| Module | Responsibility | Documentation |
|---|---|---|
| `cli/` | CLI facade, operator shell (`shell start/status/reply/watch`), `status.json` projection, progress lines, `auto-prune.ts` | [`cli/README.md`](./cli/README.md) |
| `workflow/` | LangGraph state graph, spec hashing, `worktree-guard.ts`, lazy hydration, patch reconciliation, git delivery, `landed-check.ts` | [`workflow/README.md`](./workflow/README.md) |
| `execution/` | Boundary-governed `minimal-executor.ts` loop, allowlisted tools, path containment, `@ac` coverage (`ac-coverage.ts`), failure traces | [`execution/README.md`](./execution/README.md) |
| `review/` | Heterogeneous `CriticReviewAdapter` (`spec`, `plan`, `qa` graph nodes; standalone `phase=code`), excerpt packing, `verifier.ts` | [`review/README.md`](./review/README.md) |
| `persistence/` | SQLite event store (`runtime-store.ts`), artifacts, 7-day retention (`run-retention.ts`, `run-cleanup.ts`, `run-compaction.ts`, `run-archive.ts`) | [`persistence/README.md`](./persistence/README.md) |
| `policy/` | `RunAuthorizationEnvelope`, Task DAG planner (`task-planner.ts`), `SdlcError` taxonomy (`errors.ts`), reliability/canary gates | [`policy/README.md`](./policy/README.md) |
| `roles/` | Role/capability registries, cognitive tiering, upstream learning recall, closed-loop trace-skill learning (`scripts/`) | [`roles/README.md`](./roles/README.md) |
| `adapters/` | Outbound ports to `@evelbulgroz/model-usage-govenor` (`model-governor.ts`) and GitHub draft PRs (`github-pr.ts`) | [`adapters/README.md`](./adapters/README.md) |
| `host/` | `.agents/sdlc-host.json` (`1.3.0`) loader, 3-tier `verify` (`verify-config.ts`), 3-layer prompts, host adapters, `learnings.ts` | [`host/README.md`](./host/README.md) |
| `ledger/` | Run token/cost ledger snapshots and model-usage archive records (`persistence/run-ledger.ts`, `persistence/ledger-archive.ts`) | [`ledger/README.md`](./ledger/README.md) |
| `prompts/` | 3-layer role prompt & critic rubric composition (`roles/role-registry.ts`, `review/critic-prompt.ts`, `roles/defaults/`, `review/defaults/`) | [`prompts/README.md`](./prompts/README.md) |

```text
agent-sdlc/
├── cli/
├── workflow/
├── execution/
├── review/
├── persistence/
├── policy/
├── roles/
├── adapters/
├── host/
├── ledger/
├── prompts/
├── scripts/
├── testing/
├── agent-status-validate.ts
├── AGENTS.md
├── ARCHITECTURE.md
└── README.md
```

---

## 2. Installation, Deployment Strategy & Host Onboarding

### Recommended Deployment Strategy: Per-Machine Engine + Per-Project Host Profile

`@evelbulgroz/agent-sdlc` is designed around a **hybrid deployment model** that separates the orchestration runtime from the repositories it operates on:

1. **Single Per-Machine Engine Installation:** Install this package once on your workstation and expose its CLI binaries (`agent-sdlc`, `agent-review`, `agent-sdlc-trace`, `agent-sdlc-trends`) on your user `PATH`.
   - **Zero dependency pollution in target repos:** Client repositories do not need LangGraph, Zod, or engine scripts in their own `package.json` or lockfiles.
   - **Centralized model & cost governance:** All runs share the single machine installation of [`@evelbulgroz/model-usage-govenor`](https://github.com/evelbulgroz/model-usage-govenor), enforcing unified provider credentials, circuit-breaker state, and 3-tier lower-only budget ceilings (committed `.agents/model-usage-policy.json` $\to$ machine-wide `~/.config/model-usage/local-policy.json` $\to$ per-project `.agent-sdlc/local-policy.json` or `tools/.model-usage/local-policy.json`).
2. **Lightweight Per-Repository Onboarding:** Each target repository checks in a single declarative `.agents/sdlc-host.json` (`schemaVersion: "1.3.0"`) and gitignores `.agent-sdlc/`. Built-in workflow, role, and prompt defaults execute directly from the machine installation unless overridden locally.

### Per-Machine Installation

#### 1. Prerequisites
- **Node.js `>= 22.18.0`** with native TypeScript type stripping first on `PATH`:
  ```bash
  node -p process.features.typescript # must print: strip
  ```
- **`pnpm` (`>= 9`)** (`corepack enable`) and **`git`**.

#### 2. Install Workspace, Link CLI Binaries & Export `AGENT_SDLC_PATH`
Clone the repository once on your machine, install workspace dependencies, and link the package binaries declared in [`package.json`](./package.json) onto your global `pnpm` bin path:

```bash
pnpm install --frozen-lockfile
pnpm link --global

# Verify the CLI is reachable on PATH
agent-sdlc help
agent-review --help
```

*(You can also invoke scripts directly via `pnpm run sdlc -- <subcommand>` without global linking.)*

For host repositories whose scripts, preflight hooks (`auto-prune.ts`), or dynamic ESM shims (`agent-status-validate.ts`) invoke the local checkout directly without adding `@evelbulgroz/agent-sdlc` to the host `package.json`, export `AGENT_SDLC_PATH` (alongside `MODEL_USAGE_PATH`) in your shell login/environment profile (`~/.profile`, `~/.bashrc`, or `~/.zshenv` so both interactive terminals and non-interactive agent/worktree subshells inherit it):

```bash
export AGENT_SDLC_PATH="/path/to/agent-sdlc"
export MODEL_USAGE_PATH="/path/to/model-usage-govenor"
```

#### 3. Configure Model Governor Credentials & Local Ceilings
All LLM calls route through `@evelbulgroz/model-usage-govenor`. Export the API keys for your enabled routes in your shell profile, and optionally create `~/.config/model-usage/local-policy.json` (machine-wide) or `.agent-sdlc/local-policy.json` / `tools/.model-usage/local-policy.json` (per-project) to tighten per-run or per-instance spend ceilings (see [`@evelbulgroz/model-usage-govenor`](https://github.com/evelbulgroz/model-usage-govenor)).

### How to Onboard a Host Repository (`.agents/sdlc-host.json` & `.agent-sdlc/`)

Onboarding a repository requires one configuration file (`.agents/sdlc-host.json`) and one `.gitignore` entry (`.agent-sdlc/`). You do not need to copy workflow manifests, role definitions, or prompt files into your repository to get started.

#### Step 1: Create `.agents/sdlc-host.json` and ignore `.agent-sdlc/`

Add `.agent-sdlc/` to your repository's `.gitignore` so machine-local SQLite databases, detached worktrees, critic reports, and archived runs are never committed. Then create `.agents/sdlc-host.json` (`schemaVersion: "1.3.0"`) using the portable `script` adapter (see [`host/README.md`](./host/README.md)):

```json
{
  "schemaVersion": "1.3.0",
  "profileId": "my-repo",
  "repositoryId": "my-repo",
  "adapter": "script",
  "workspace": {
    "directories": ["."]
  },
  "hydration": [
    ["pnpm", "install", "--frozen-lockfile"]
  ],
  "commands": [
    ["pnpm", "test"]
  ]
}
```

Validate your setup at any time with:

```bash
agent-sdlc host check --json
```

#### Step 2: Understand where state and artifacts live on disk

- **Zero-config single directory (`.agent-sdlc/`):** In `schemaVersion: "1.3.0"`, directory paths are optional. When omitted, all runtime state is co-located under `.agent-sdlc/`:
  - `.agent-sdlc/specs/drafts/` (`specDraftDir`) — Spec drafts (`<slug>.md`) and optional task plans (`<slug>.tasks.json`).
  - `.agent-sdlc/reviews/<run-id>/` (`reviewDir`) — Critic review manifests and findings reports.
  - `.agent-sdlc/<run-id>/` (`stateDir`) — Per-run `runtime.sqlite`, `artifacts/`, detached `worktree/` (or `worktrees/<task-id>` + `worktrees/integration`), and human-readable projections (`status.json`, `intent.md`, `decisions.md`, `plan.md`, `candidate-learnings.json`).
  - `.agent-sdlc/.archive/` — Compacted 7-day run archives (`index.jsonl`, `unlanded.patch`, `sweep.lock`, `sweep.log`; see [`persistence/README.md`](./persistence/README.md)).
- **Custom or repo-visible directories (optional):** If you prefer storing specs or run summaries in tracked project folders, set `stateDir` (e.g. `tools/.agent-sdlc/` or via `AGENT_SDLC_STATE_DIR`), `reviewDir` (e.g. `tools/.review/`), `specDraftDir` (e.g. `docs/specs/drafts/`), or opt-in `runsDir` (e.g. `docs/specs/runs/`) in `.agents/sdlc-host.json`.

#### Step 3: Choose a verification tier (`verify`)

The engine never lets a model self-approve its work; every run must pass your host verification gate (`host/verify-config.ts`). You can start simple and tighten the gate as your repo matures:

1. **Tier 1 — Default (`npm test`):** Omit `verify` in `.agents/sdlc-host.json`. The engine runs `npm test` in the worktree and passes on exit code `0`.
2. **Tier 2 — Custom exit-code command (`verify.argv`):** Set `"verify": { "argv": ["pnpm", "run", "verify"] }` (optionally including a discrete `"{baseSha}"` argument for diff-aware scripts).
3. **Tier 3 — Receipt-backed preflight (`verify.resultPath`):** Point `verify.argv` at a script like `verify:receipt` that writes a JSON receipt (`status: "OK"`, `canonical: true`, `base`, and `gitHeadSha`) to `verify.resultPath`, preventing skipped suites or early `exit 0` from passing verification (see [`host/README.md`](./host/README.md)).

#### Step 4: Customize prompts, rules, and roles only when needed

- **Built-in defaults work out of the box:** `.agents/workflows/` is optional. When omitted, `roles/defaults/` and `review/defaults/` supply the default `specification.json` workflow, the 4 built-in roles (`specifier`, `implementer`, `reviewer`, `critic-reviewer`), Layer 1 `protocol/` prompts, and Layer 2 `philosophy/` prompts and rubrics (see [`roles/README.md`](./roles/README.md) and [`prompts/README.md`](./prompts/README.md)).
- **Repo-specific guardrails (Layer 3):** To teach the roles your repository's conventions without forked role JSONs, add markdown addenda in `.agents/workflows/prompts/<roleId>.md`, attach path-scoped rules via `prompts.pathScopedRules` in `.agents/sdlc-host.json`, or configure `architecture`, `policy`, `qualityGate`, and `learnings` rules in `.agents/sdlc-host.json`.

---

## 3. CLI Reference & Usage

### Operator Shell (`agent-sdlc shell`)

`shell` (`cli/shell-driver.ts`, documented in [`cli/README.md`](./cli/README.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md)) is the only surface that drives an orchestrated run for an operator or host chat session. The host loop is approve, then authorize with an envelope, then resume until continuation.action is stop or answer by executing hostInvocation. The host does not keep its own retry count. Planning and plan critic run after the envelope is stored. The host runs every executable hostInvocation.argv, including the approval response-file resume and a resume whose retry.allowed is false. packetConsumed true with a null argv is a finished packet when the process exit is 0, 2, 3, or 4.

```bash
# 1. Validate spec and task manifest (governor-free, no run or worktree created)
agent-sdlc check-spec --goal-file docs/specs/drafts/<slug>.md \
  --task-plan-file docs/specs/drafts/<slug>.tasks.json --json

# 2. Start via Operator Shell (pass --task-plan-file whenever <slug>.tasks.json exists)
agent-sdlc shell start --goal-file docs/specs/drafts/<slug>.md \
  --task-plan-file docs/specs/drafts/<slug>.tasks.json [--executor minimal] --json
agent-sdlc shell start --goal-file docs/specs/drafts/<slug>.md \
  --response-file <path-to-brief-confirmation.json> --json

# 3. Drive mechanical continuations, reply to HITL cards, or inspect status
agent-sdlc shell watch --run <run-id> --json
agent-sdlc shell reply --run <run-id> --response-file <path> --json
agent-sdlc shell status --run <run-id> --json
```

### Maintenance, Retention, Review & Analytics CLIs

```bash
# Validate .agents/sdlc-host.json profile
agent-sdlc host check [--root <dir>] [--json]

# Sweep merged worktrees (< 7d, landed-check.ts / run-cleanup.ts) and compact idle runs
# (>= 7d, run-retention.ts / run-compaction.ts / run-archive.ts; auto-triggered by auto-prune.ts
# after canonical preflight on main unless AGENT_SDLC_AUTO_PRUNE=0)
agent-sdlc prune-runs [--dry-run] [--json]

# Offline reliability replay & hosted canary qualification (see policy/README.md)
agent-sdlc reliability replay --json
agent-sdlc canary check --goal-file <spec.md> --task-plan-file <tasks.json> --json
agent-sdlc canary qualify --run <run-id> --json

# Standalone heterogeneous critic review (see review/README.md)
agent-review --phase code --author-vendor google --scope packages/example-service
agent-review --phase <spec|plan|code|qa> --author-vendor <vendor>

# Trace diagnostics & closed-loop skill learning (see execution/README.md & roles/README.md)
agent-sdlc-trace --run <run-id> [--json]
agent-sdlc skills --run <run-id>
agent-sdlc-trends --skills [--threshold <N>] [--json]
```

---

## 4. Development & Testing

### Develop

- **No build step (native type stripping):** Sources run directly on Node.js `>= 22.18.0` (`node -p process.features.typescript` printing `strip`). Use erasable TypeScript syntax only (`erasableSyntaxOnly`, `verbatimModuleSyntax` in [`tsconfig.json`](./tsconfig.json)) and explicit `.ts` extensions on relative imports.
- **Package boundaries & navigability ceilings:** Keep all modules self-contained inside the package root (no relative imports outside the package root) and within `<= 500` lines and `<= 20,480` bytes.

```bash
# Strictly typecheck package TypeScript sources (no emit, erasable syntax only)
pnpm run typecheck
```

### Test

Tests are colocated `*.spec.mjs` files executed with the built-in `node:test` runner:

```bash
# Run a single module spec during inner-loop development
node --test review/agent-review.spec.mjs

# Run all colocated package specs (*.spec.mjs) serially
pnpm run test:unit
```

### Qualify (Offline Replay & Hosted Canary)

Before running a multi-task DAG after modifying orchestration logic, qualify the engine in two stages (`policy/reliability/canary.ts`, documented in [`policy/README.md`](./policy/README.md)):

- **Purpose (Why):** Any change to the workflow manifest (`workflowHash`), task-planning/execution modules (`boundedPlanningHash`, [`policy/canary-planning-files.ts`](./policy/canary-planning-files.ts)), the `implementer` role/prompts (`implementerRoleHash`), or committed `.agents/model-usage-policy.json` (`modelPolicyHash`) invalidates `<stateDir>/canary-qualification.json` (`CANARY_STALE` / `CANARY_REQUIRED`), blocking multi-task runs until a fresh canary passes. Documentation-only commits (`*.md`) do not mark the canary stale.
- **Manner (How):**
  1. **Offline replay (`providerOperations: 0`):** Verify the deterministic reliability corpus without live model calls.
  2. **Canary eligibility check:** Confirm the target fixture has 1 `vertical` slice, 1 task, $\le 2$ ACs, $\le 3$ authored files, complexity $\le 10$, non-high-risk paths, and no contract/dependency/generated outputs.
  3. **Hosted canary execution (unmerged fixture):** Drive an **unmerged** canary spec to `READY_FOR_GIT_APPROVAL` via `agent-sdlc shell start`, `shell reply`, and `shell watch` with `0` rejected mutations and `0` semantic repairs. **Never commit or merge the canary worktree into `main`**, so its `@ac` test citations never enter `HEAD` baseline citations (`ac-coverage.ts`).
  4. **Record qualification receipt:** Bind the passing run to the current engine/policy hashes in `<stateDir>/canary-qualification.json` (mode `0600`).

```bash
# 1. Offline reliability corpus replay (zero provider calls)
agent-sdlc reliability replay --json

# 2. Validate canary fixture bounds (1 vertical slice/task, <= 2 ACs, <= 3 files, score <= 10)
agent-sdlc canary check --goal-file <canary-spec.md> --task-plan-file <canary.tasks.json> --json

# 3. Drive the unmerged canary fixture to READY_FOR_GIT_APPROVAL via shell start / reply / watch, then qualify:
agent-sdlc canary qualify --run <run-id> --json
```

---

## 5. License & Disclaimer

Released under the **ISC License** (permissive):

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT. THE AUTHORS AND COPYRIGHT HOLDERS REFUSE ALL RESPONSIBILITY AND SHALL IN NO EVENT BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY OTHER LIABILITY—WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE—ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE, INCLUDING ANY MODEL API COSTS, DATA LOSS, OR WORKSPACE MODIFICATIONS.
