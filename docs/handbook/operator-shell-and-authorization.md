# Operator Shell & Run Authorization Boundary

## 1. Headless Continuation & Operator Shell Design

The `agent-sdlc` engine is strictly headless. It produces state projections and continuation cards as machine-readable JSON (`status-projection.ts`).

The Operator Shell (`agent-sdlc shell`) is the sole surface that drives orchestrated runs:

```bash
# 1. Validate spec and task plan (governor-free, creates no run or worktree)
agent-sdlc check-spec --goal-file <spec.md> --task-plan-file <tasks.json> --json

# 2. Brief-then-confirm gate (stops with briefHash; requires explicit confirmation)
agent-sdlc shell start --goal-file <spec.md> --task-plan-file <tasks.json> --json
agent-sdlc shell start --goal-file <spec.md> --response-file <confirmation.json> --json

# 3. Mechanical watch loop (replays authorized steps until a human gate is reached)
agent-sdlc shell watch --run <run-id> --json

# 4. Human-In-The-Loop response submission (validates response slots before execution)
agent-sdlc shell reply --run <run-id> --response-file <reply.json> --json

# 5. Read-only status projection
agent-sdlc shell status --run <run-id> --json
```

---

## 2. The Run Authorization Envelope

Autonomous runs cannot begin implementation without an explicit `RunAuthorizationEnvelope` (`policy/authorization.ts`). The envelope binds execution cryptographically to:
- `approvedSpecHash`: SHA-256 of the approved specification.
- `baseCommitSha`: The exact Git commit SHA of the target branch.
- `allowedPackages`: Explicitly allowlisted workspace package directories.
- `allowedPathPrefixes`: Exact directory and file boundaries the implementer may edit.

After authorization, the plan critic freezes `taskPlanHash` (`taskPlanFrozen === true`) before any detached worktree can be created.

---

## 3. Detached Worktrees & Realpath Containment

To prevent repository corruption or concurrent git index contention:
- The engine operates in detached, isolated worktrees (`.agent-sdlc/<run-id>/worktree`).
- The implementer role executes allowlisted tools (`read_file`, `write_file`, `edit_file`, `run_command`).
- Every filesystem mutation is checked against realpath path-containment assertions (`assertPathContained`). Escapes outside `allowedPathPrefixes` fail closed.

---

## 4. Terminal Git Sign-Off

The engine permanently forbids autonomous merges and deployments. By default, upon passing preflight verification and QA review, the run halts cleanly at `READY_FOR_GIT_APPROVAL` (`exitCode: 0`).

Branch creation, commits, pushes, and pull requests remain strictly human-operator authorized actions.

---

## 5. Qualification Boundary

The engine is qualified in this repository: tier 1 deterministic gate proofs and scripted scenarios run in `pnpm run test:unit`, and tier 2 live runs use an engine-owned fixture (`testing/qualification/README.md`). A host canary (`agent-sdlc canary check` / `canary qualify`) is a tier 3 configuration smoke: one clean run on the host's own spec that checks admission, preflight and the 7/7 run invariants. A tier 3 failure reopens engine qualification only if it reproduces on the engine fixture; otherwise it is reported as host configuration.
