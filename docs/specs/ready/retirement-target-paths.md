# Intent

## Goal

Before `taskPlanHash` freezes, run one static closure over the union of every task marked `retirement`. A sibling whose resolved importers all sit in that union is added to exactly one of those tasks. The operator accepts the expanded plan. A miss is a plan-critic P1 at `WAITING_FOR_PLAN_ACCEPTANCE`. Nothing is added after the hash freezes.

The motivating case is task `gateway-retire-conditioning-controller`, whose write set was one controller file while sibling application files were left behind. Two retirement tasks that each hold one importer are closed by the same scan. This slice reads the base tree once. It does not delete those files, scan prose, or run a test suite.

Current source: there is no `policy/plan-validator.ts`. `check-spec` parses the goal and acceptance grammar. `validateTaskPlan` in `policy/contracts/dag-schema.ts` is schema validation. `DagTaskV2Schema` is strict. `pathPrefixes` is required. `taskAuthoredWritePaths` in `execution/task-scope.ts` uses `authoredPaths` when that array is non-empty, otherwise `pathPrefixes`. The plan critic freezes `taskPlanHash` before worktrees exist. A plan-critic P1 stops at `WAITING_FOR_PLAN_ACCEPTANCE`, and `accept_residual` continues.

## Non-goals

- Do not change `check-spec` into a host source scan.
- Do not trigger on goal or task prose.
- Do not infer private-method deletions, Nest reflection, decorator metadata, or string tokens as files to add.
- Do not delete, edit, or mark files unreferenced at execution time.
- Do not freeze a plan and then suggest extra paths.
- Do not widen `allowedPathPrefixes` or the authorization envelope.
- Do not add a path to a task whose `retirement` flag is omitted or false.
- Do not run a package coverage command, `agent:preflight`, or any host test suite. A package coverage gate after the last task in a package stays deferred until a run shows an orphan this walker cannot see.
- Do not add a repair counter or a runtime state.

## Owning context

agent-sdlc planning. The scan reads the host tree at `baseCommitSha` from the planning workspace. It is deterministic and token-free.

## Touched surfaces

- policy/static-import-graph.ts (new)
- policy/static-import-graph.spec.mjs (new)
- policy/contracts/dag-schema.ts
- policy/contracts/dag-schema.spec.mjs
- policy/retirement-paths.ts (new)
- policy/retirement-paths.spec.mjs (new)
- policy/task-planner.ts
- workflow/nodes/planning.ts
- policy/README.md

## Invariants and constraints

- HOLD SCOPE: an optional task field, the pre-freeze scan, plan-critic reporting for unresolved imports, and the tests that lock them.
- Add optional `retirement: boolean` to the task schema. Absent or false excludes that task from the union. Do not overload `changeClass`.
- `policy/task-planner.ts` is 490 lines and 14612 bytes. The scan lives in `policy/retirement-paths.ts`. The planner adds one call. If that call crosses 500 lines, extract an existing helper in the same slice before adding it. Schema stays in `dag-schema.ts`.
- The walker lives only in `policy/static-import-graph.ts`. `policy/retirement-paths.ts` calls it once per plan. The correction slice imports the same module and does not grow a second walker. The walker resolves relative `import`, relative `export ... from`, and `import('literal')` specifiers to files in the task package. A spec or test file counts as an importer. A non-relative specifier or a non-literal dynamic import is unresolved.
- A sibling is eligible when every resolved static importer sits inside the union of `taskAuthoredWritePaths` for tasks with `retirement` true, and the sibling is inside `allowedPathPrefixes`. An importer in a non-retirement write set, or in no write set, keeps the sibling out.
- Assign an eligible sibling to one retirement task: the task whose write set contains the most of those importers. A tie goes to the earliest `integrationOrder`. Add it to that task's `pathPrefixes` and, when `authoredPaths` is non-empty, to `authoredPaths`, before `PLAN_FROZEN`. Do not add it to a second task.
- `taskPlanHash` is the hash of that expanded plan. Plan acceptance displays the expanded paths. `accept_residual` does not add paths and does not change the hash.
- A candidate outside `allowedPathPrefixes` is not added. Planning stops at `WAITING_FOR_PLAN_ACCEPTANCE` with a plan-critic P1 naming the path.
- Unresolved imports on a retirement task are the same kind of P1. They do not add paths.
- Re-run the existing concurrent-task path overlap check after expansion. An overlap fails planning. The file is not shared by omitting the dependency.
- Private methods inside a file that is already a write path are not path candidates.
- Tasks with `retirement` false or omitted keep today's planning behavior.
- No new dependency. Native type stripping and explicit `.ts` imports stay.

## Public contract impact

Task plans gain an optional `retirement` boolean. The retirement union may gain write paths before the operator accepts the plan. Each added path appears on exactly one retirement task. Envelopes, `check-spec`, and non-retirement tasks stay as they are. The full host preflight still runs once, after reconciliation. The expansion is visible in the frozen plan the operator accepts.

## Acceptance criteria

1. AC-01: Siblings owned by the retirement union join one write set before the plan hash freezes. Given one or more retirement tasks whose combined write sets contain every static relative importer of a sibling inside the authorized package. Then planning adds that sibling to exactly one retirement task and the frozen taskPlanHash covers the expanded plan. Cases: AC-01.1: a single retirement importer receives the sibling on pathPrefixes and on authoredPaths when authoredPaths is non-empty; AC-01.2: a sibling that is already listed stays once; AC-01.3: an importer outside the retirement union keeps the sibling out; AC-01.4: a spec or test importer counts as a reference; AC-01.5: two retirement importers assign the sibling only to the task with more importers, and an equal count assigns it to the earliest integrationOrder.
2. AC-02: Unresolved references block acceptance and add no paths. Given a retirement task with a non-literal dynamic import or a non-relative specifier. Then planning stops at WAITING_FOR_PLAN_ACCEPTANCE with a plan-critic P1 and accept_residual leaves the write set unchanged. Cases: AC-02.1: a non-literal import is unresolved; AC-02.2: accept_residual adds no path and does not change taskPlanHash; AC-02.3: a sibling outside allowedPathPrefixes is refused and named on the P1.
3. AC-03: Prose and non-retirement tasks do not select files. Given a goal whose prose says retire route and a task with retirement omitted. Then check-spec reads no host tree and planning adds no path to that task. Cases: AC-03.1: check-spec on retirement prose performs no scan; AC-03.2: retirement false skips that task; AC-03.3: a non-retirement task that holds the only importer gains no sibling.
4. AC-04: Method-only and overlapping expansions stay bounded. Given a retirement task. Then a private method in an already targeted file adds no file, and an expanded path that overlaps a concurrent task fails planning. Cases: AC-04.1: a method-only retirement adds no sibling; AC-04.2: overlap after expansion fails before PLAN_FROZEN.

## Failure defenses

- Use a temporary fixture tree. Do not scan the fitness-app checkout in unit tests.
- Treat an unresolved import as unknown, not as zero references.
- Assert the frozen hash changes when a sibling is added and stays stable across `accept_residual`.
- Assert `check-spec` makes no filesystem reads of a host package.
- Assert this slice starts no package coverage command and no host preflight.

## Verification plan

- `policy/static-import-graph.spec.mjs` locks the walker. `policy/retirement-paths.spec.mjs` cites AC-01 through AC-04 with `@ac` and `@case`.
- Extend `policy/contracts/dag-schema.spec.mjs` for the optional boolean and for rejection of an unknown task key other than that boolean.
- Run the touched specs, then `pnpm run build && pnpm run typecheck && pnpm run test:unit && node cli/cli.ts reliability replay` before calling the slice done.
- This slice is phase 2. It does not consume `integrationFailure`. It lands `policy/static-import-graph.ts` before the correction slice imports it. The package coverage gate stays deferred.
- Saving this draft authorizes no implementation and no run.

## Unresolved questions

_None_

## Assumptions

- The planning workspace contains the host tree at `baseCommitSha`.
- Relative TypeScript import specifiers are enough for this slice. A later slice may add a language the host declares.
- Operators set `retirement` on the task in the plan. The engine does not infer it. A feature task that only edits an importer stays out of the union.
- `policy/task-planner.ts` gets one call into `policy/retirement-paths.ts`. The walker stays in `policy/static-import-graph.ts`.
