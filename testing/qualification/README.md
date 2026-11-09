# Engine qualification runbook

Tier 1 runs in `pnpm run test:unit` (`cases.json`, `tier: 1`). Tier 2 runs live against a temporary git repository built from `testing/fixture-monorepo` and a spec in `fixtures/`. Tier 3 is the host configuration smoke and is documented in the operator handbook.

## Running a tier 2 case

1. Pick the case in `cases.json` (`tier: 2`) and its `fixtureSpec`. Prefer a spec whose `usedIn` in `fixtures/pool.json` is empty; a spec a live model has seen is no longer unseen.
2. Copy `testing/fixture-monorepo` to a temporary directory, `git init`, commit, and run `agent-sdlc shell start` there with an explicit authorization envelope.
3. Drive the run to a terminal state (`READY_FOR_GIT_APPROVAL`, `FAILED`, `ESCALATED`). Never commit or merge the resulting worktree.
4. Score:
   - `node scripts/run-invariants.ts --run <run-id> --root <fixture repository>` (exit 0 means all invariants hold).
   - N2 only: `node testing/qualification/wrap-index-oracle.mjs <produced spec>`.
5. Record the run in `pool.json` (`usedIn`).

## Archive

Archives live outside this repository, in an operator-chosen directory, as `<engine-sha>/<case>/` holding `status.json`, `runtime.sqlite`, the scorer output and the report.

## Report template

```
case:           <id>
engine sha:     <git sha>
kind:           <clean | crash | seeded | observational>
outcome class:  <one of outcomeClasses[kind]>
terminal state: <state, lastError.code>
scorer:         <command and exit code>
gate that fired: <name, or none>
notes / backlog: <links>
```
