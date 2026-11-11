# Intent

Status: retired 2026-11-11 (phase 2 implemented on `c5e6476`). The package coverage gate stays deferred. This file is no longer a `check-spec` goal.

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
- The walker lives only in `policy/static-import-graph.ts`. `policy/retirement-paths.ts` calls it once per plan. The correction slice imports the same module and does not grow a second walker. The walker resolves relative `import`, relative `export ... from`, and `import('literal')` specifiers to files under the walked roots. A spec or test file counts as an importer.
- A non-literal dynamic import, a relative specifier that does not resolve, and a bare specifier that names a source file under the walked roots are unresolved. The bare-file case is reason `non_relative`. `pkg/src/orphan` is that case. A specifier that starts with `node:`, and a package name or package subpath that names no source file under the walked roots, is not unresolved. `@nestjs/common`, `lodash/get`, and `@nestjs/common/interfaces` are that case. A pattern that also matches a walked file path does not implement this rule.
- A sibling is eligible when every resolved static importer sits inside the union of `taskAuthoredWritePaths` for tasks with `retirement` true, and the sibling is inside `allowedPathPrefixes`. An importer in a non-retirement write set, or in no write set, keeps the sibling out.
- Assign an eligible sibling to one retirement task: the task whose write set contains the most of those importers. A tie goes to the earliest `integrationOrder`. Add it to that task's `pathPrefixes` and, when `authoredPaths` is non-empty, to `authoredPaths`, before `PLAN_FROZEN`. Do not add it to a second task.
- `taskPlanHash` is the hash of that expanded plan. Plan acceptance displays the expanded paths. `accept_residual` does not add paths and does not change the hash.
- A candidate outside `allowedPathPrefixes` is not added. Planning stops at `WAITING_FOR_PLAN_ACCEPTANCE` with a plan-critic P1 naming the path.
- Unresolved imports on a retirement task are the same kind of P1. They do not add paths. The critic derives those blockers from the stored plan and the base tree. A process-local map may cache that result for the same plan hash. When the map has no entry, the critic runs the same closure again, appends no path, and does not change `taskPlanHash`. Non-empty blockers skip the model critic and name their paths. An empty result leaves the model critic in place.
- Re-run the existing concurrent-task path overlap check after expansion. An overlap fails planning. The file is not shared by omitting the dependency.
- Private methods inside a file that is already a write path are not path candidates.
- Tasks with `retirement` false or omitted keep today's planning behavior.
- No new dependency. Native type stripping and explicit `.ts` imports stay.

## Public contract impact

Task plans gain an optional `retirement` boolean. The retirement union may gain write paths before the operator accepts the plan. Each added path appears on exactly one retirement task. Envelopes, `check-spec`, and non-retirement tasks stay as they are. The full host preflight still runs once, after reconciliation. The expansion is visible in the frozen plan the operator accepts.

## Acceptance criteria

1. AC-01: Siblings owned by the retirement union join one write set before the plan hash freezes. Given one or more retirement tasks whose combined write sets contain every static relative importer of a sibling inside the authorized package. Then planning adds that sibling to exactly one retirement task and the frozen taskPlanHash covers the expanded plan. Cases: AC-01.1: a single retirement importer receives the sibling on pathPrefixes and on authoredPaths when authoredPaths is non-empty; AC-01.2: a sibling that is already listed stays once; AC-01.3: an importer outside the retirement union keeps the sibling out; AC-01.4: a spec or test importer counts as a reference; AC-01.5: two retirement importers assign the sibling only to the task with more importers, and an equal count assigns it to the earliest integrationOrder.
2. AC-02: Unresolved references block acceptance and add no paths. Given a retirement task whose file contains a non-literal dynamic import, a non-relative specifier, a node: import, or a package subpath. Then an unresolved import stops at WAITING_FOR_PLAN_ACCEPTANCE with a plan-critic P1 and adds no path, a node: import or a package subpath that names no walked file adds no blocker, and accept_residual leaves the write set unchanged. Cases: AC-02.1: a non-literal import is unresolved; AC-02.2: accept_residual adds no path and does not change taskPlanHash; AC-02.3: a sibling outside allowedPathPrefixes is refused and named on the P1; AC-02.4: node:fs and @nestjs/common/interfaces add no blocker and no path; AC-02.5: a bare specifier that names a walked file is a non_relative P1 and adds no path.
3. AC-03: Prose and non-retirement tasks do not select files. Given a goal whose prose says retire route and a task with retirement omitted. Then check-spec reads no host tree and planning adds no path to that task. Cases: AC-03.1: check-spec on retirement prose performs no scan; AC-03.2: retirement false skips that task; AC-03.3: a non-retirement task that holds the only importer gains no sibling.
4. AC-04: Method-only and overlapping expansions stay bounded. Given a retirement task. Then a private method in an already targeted file adds no file, and an expanded path that overlaps a concurrent task fails planning. Cases: AC-04.1: a method-only retirement adds no sibling; AC-04.2: overlap after expansion fails before PLAN_FROZEN.
5. AC-05: A restarted critic still reports stored retirement blockers. Given a stored plan whose retirement closure has blockers and an empty in-memory map. Then the critic recomputes those blockers, skips the model, and does not change taskPlanHash. Cases: AC-05.1: the recomputed P1 stops at WAITING_FOR_PLAN_ACCEPTANCE and names the blocker paths; AC-05.2: a recompute that finds no blockers leaves the model critic in place.

## Failure defenses

- Use a temporary fixture tree. Do not scan the fitness-app checkout in unit tests.
- Treat an unresolved import as unknown, not as zero references. A `node:` import and a package subpath that names no walked file are not unresolved.
- Assert a critic with an empty map and stored blockers does not call the model and does not change `taskPlanHash`.
- Assert the frozen hash changes when a sibling is added and stays stable across `accept_residual`.
- Assert `check-spec` makes no filesystem reads of a host package.
- Assert this slice starts no package coverage command and no host preflight.

## Verification plan

- `policy/static-import-graph.spec.mjs` locks the walker, including AC-02.4 and AC-02.5. `policy/retirement-paths.spec.mjs` and `policy/retirement-planning.spec.mjs` cite AC-01 through AC-05 with `@ac` and `@case`. AC-05.1 starts the critic in a fresh process map.
- Extend `policy/contracts/dag-schema.spec.mjs` for the optional boolean and for rejection of an unknown task key other than that boolean.
- Run the touched specs, then `pnpm run build && pnpm run typecheck && pnpm run test:unit && node cli/cli.ts reliability replay` before calling the slice done.
- This slice is phase 2. It does not consume `integrationFailure`. It lands `policy/static-import-graph.ts` before the correction slice imports it. The package coverage gate stays deferred.
- Saving this draft authorizes no implementation and no run.

## Unresolved questions

_None_

## Assumptions

- The planning workspace contains the host tree at `baseCommitSha`.
- Relative TypeScript import specifiers are enough to bind a sibling. `node:` imports and package subpaths that name no walked file are ignored. A later slice may add a language the host declares.
- Operators set `retirement` on the task in the plan. The engine does not infer it. A feature task that only edits an importer stays out of the union.
- `policy/task-planner.ts` gets one call into `policy/retirement-paths.ts`. The walker stays in `policy/static-import-graph.ts`.
