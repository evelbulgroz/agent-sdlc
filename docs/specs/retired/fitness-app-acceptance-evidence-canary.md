# Fitness-app acceptance-evidence integration and live canary

**Status:** Local implementation approved; live execution gated.
**Type:** Reference.

## Intent and authority

Qualify real fitness-app evidence adapters, then exercise checkpoint-bound QA in
separately admitted, isolated canary runs under one shared experiment cap.
Demonstrate observable evidence, heterogeneous
adequacy review, correction/restart behavior, and fail-closed delivery without
changing the landed application or adopting the policy by default.

This draft extends the engine's
[quality-gates specification](acceptance-evidence-and-qa-quality-gates.md),
[checkpoint contract](acceptance-evidence-checkpoint-contract.md),
[wire contract](acceptance-evidence-wire-contract.md), and
[resolution contract](acceptance-evidence-resolution-contract.md).
Those contracts and schemas remain authoritative.

Drafting permits read-only inspection only. Host edits, installs, providers, run
creation and Git actions require separate approvals; engine commit approval
grants none of them.

## Observed baseline

Inspected on 2026-11-02:

| Surface | Observed value |
|---|---|
| Engine baseline | `4f5c104`, checkpoint-evidence implementation and review fixes |
| Reference host | `/home/ulrik/version-control/projects/fitness-app` |
| Host HEAD | `a888010f17b4df6c646e19b5f169c23fbdef5b5d` |
| Host worktree | Clean at inspection; recheck before implementation |
| Host profile | `.agents/sdlc-host.json`, schema `1.3.0`, no evidence adapters |
| Target package | `apps/frontends/fitnessapp-pwa-frontend`, `@fitness-app/pwa-frontend` |
| Unit runner | Vitest; package `test` runs `cross-env NODE_ENV=test vitest run` |
| Browser runner | Playwright Chromium; package `test:e2e` runs `playwright test` |
| Browser configuration | `playwright.config.ts`: Vite build/preview, port 4173 |
| Existing browser cases | `e2e/session-data-sources.spec.ts`: picker activation and focus restoration |

These facts are not execution bindings. Default browser server reuse and CI
retries are not canary policy. Vitest cannot discharge native capabilities.
Direct runner invocation must retain package pretest checks.

## Scope and ownership

Host implementation is a separately approved integration change, completed and
verified before choosing the canary base commit. It includes:

- Two real adapters and their protocol/normalization tests, proposed under
  `tools/acceptance-evidence/`.
- Dedicated `vitest.canary.config.ts` and `playwright.canary.config.ts` inside the
  target frontend package, selected only by frozen adapter argv. Do not edit the
  ordinary runner configurations or package `test`/`test:e2e` scripts.
- Host profile `1.4.0` registration, preserving existing hydration, preparation,
  canonical preflight, policy, and legacy behavior.
- Qualification manifests, runner identity mappings, and bounded operational docs.

The integration's adapter/configuration set and qualification harness must add
no `@ac` citations to the landed baseline. New healthy canary tests, seeded
variants and their citations exist only in disposable run worktrees. Existing
landed citations are neither extended nor rewritten for this experiment.
Profile `1.4.0` is inert for legacy plans; only an explicitly approved
`checkpoint-evidence-v1` plan selects adapters. Verify that compatibility before
qualification. Host-main adoption remains separately approved, not implied by
creating an isolated integration base.

The engine remains framework-neutral; Vitest/Playwright knowledge stays in host
adapters. An engine defect discovered during qualification becomes a separate
reproduction and remediation, not an inline policy bypass.

Exclude backend contracts, authentication, shared packages, baselines, existing
assertions and root dependencies. Manifest/lockfile edits need scope extension.
Exclude UX polish, production infrastructure, new frameworks, default rollout
and historical run rewriting.

## Adapter and execution contract

Each adapter consumes exactly one engine `EvidenceRequest` on stdin and returns
one closed normalized `EvidenceReport` on stdout. Diagnostics go to stderr.
Use the existing wire schema, exact request hash, operation/candidate binding,
adapter binding, profile, repository-relative file, and stable `caseKey`.

The unit adapter normalizes Vitest results; the browser adapter normalizes
Playwright results and all attempts. Never infer success from process exit,
test title, an `@ac` citation, aggregate counts, or a requested capability alone.
Reject ambiguous parameterized cases, missing/duplicate identities, unknown
outcomes, and unsupported runner output versions. Preserve failed, skipped,
not-run, timed-out, and incomplete cases. Empty selection is not success.

Select cases by a frozen manifest mapping obligation to file and stable runner
identity, including parameter/project identity where needed. Similar titles in
different files must not alias. Do not copy case identifiers from unrelated
existing AC namespaces into the canary without an explicit mapping.

Browser profile advertises `native-browser`, `native-file-picker`, and
`focus-navigation` only after qualification. Emit each exercised capability only
for cases whose real browser actions and assertions establish it. The unit
profile advertises layer `unit` with an empty capability set.

Before any real adapter invocation, freeze an inspectable manifest containing:

- Canonical absolute `argv[0]`, executable byte hash, exact argv, runner versions,
  adapter/configuration bytes, and qualified profile/capability mappings.
- A vendored, repository-relative regular-file runtime under the proposed
  protected `tools/acceptance-evidence/runtime/` prefix. This is the chosen
  packaging strategy, not an option to bind a live pnpm store. Materialize the
  entire executed dependency closure, including Chromium and its required
  runtime assets, without symlink traversal. Hash every regular file.
- Bind all hashes through approved `dependencyManifest` references, not oversized
  inline lists. Verify every dependency on execution/reuse; no downloads or PATH.
- Required environment inputs, allowed non-secret values, working directory,
  generated output ownership, artifact directory, and preparation hash.
- Host-specific pretest checks, frontend build, gateway-client freshness checks,
  browser installation requirements, and canonical preflight dependency closure.

Freeze paths, hashes, argv and closure before execution. Unbounded dependencies
block qualification. Adapter files stay outside model write scope.

Materialize this runtime in every relevant isolated worktree through an explicitly
approved preparation step; source manifests are versioned, large runtime assets
need not be Git-tracked. Verify the copied bytes at each destination. No user
browser cache, external pnpm-store target or `node_modules` symlink may be executed.
The absolute hashed Node executable is the sole registration executable exception;
it does not authorize unregistered subprocess dependencies. Include adapter,
selected canary configs, Vite build inputs, pretest/gateway checks and every tool
they execute in the closure. Generated frontend output has its own admission-time
preparation hash. Unrepresentable native/runtime dependencies block qualification;
do not silently switch to another packaging layout.

Use fresh, owned loopback servers with no existing-server reuse, retries disabled,
one browser project and one worker initially. Port allocation must avoid shared
services; collisions halt rather than stop unrelated processes. Use synthetic
application data and local request interception; no production API or credentials.
Keep canonical host preflight separate from obligation execution.

Process groups must be cleaned after success and failure before observing source.
Record and verify child cleanup; process groups are not a sandbox against
`setsid` escape. Qualification must exclude escape behavior or require external
containment before admission. Do not claim stronger isolation than demonstrated.

## Frozen qualification corpus

Create a hashed corpus with expected outcomes recorded independently of adapter
reports and reviewer output. Preserve every result, including failures.

| Case family | Required observation |
|---|---|
| Adequate unit | Requested file/case executes and its result assertion passes |
| Native picker | Tab reaches upload; Enter and Space cause a real filechooser event |
| Focus | Keyboard opens the dialog; Escape closes it and restores trigger focus |
| Missing/null/empty | Invalid request, absent result, or empty selection cannot pass |
| Identity/binding | Wrong candidate, request hash, file/case, profile, or capability blocks |
| Runner failures | Nonzero exit, timeout, malformed output, skip, and fail-then-pass cannot discharge |
| Containment | Symlink/dependency drift, leftover child, artifact escape, and occupied port block |
| Weak assertion | A green, correctly cited test with unrelated assertions is inadequate |
| Omitted context | Decisive later assertions are supplied or retrieved; unresolved context blocks |
| Seeded defects | Disabled picker and broken focus restoration are detected |

Execute malformed-report and containment probes without providers first.
Require all deterministic negative fixtures to block and positive normalization
fixtures to preserve exact identity/outcome/attempts. Separately authorize the
live semantic subset; a missed seeded defect blocks qualification. Label
uncertainty and false positives for human adjudication, not automatic relaxation.
Defect variants and their AC citations stay in disposable worktrees, never the
host baseline. Do not repair a corpus expectation to make a run appear successful.

## Proposed live canary topology and scenario

After deterministic qualification, freeze a run-specific spec and task-plan
`2.0.0` against the approved integration baseline:

- One enabling slice establishes synthetic fixtures and case mappings.
- Vertical slice A verifies unit behavior and native picker activation.
- Vertical slice B depends on A and verifies dialog dismissal/focus restoration.
- Final integration performs canonical preflight, coverage, and distinct final QA.

Use the existing session-data-sources flow, not a new product feature. Freeze
small test-only defect variants before admission; do not improvise product edits.
Require at least one task dependency within a vertical slice to exercise
same-slice parent materialization in addition to the enabling predecessor.

Preserve the expected healthy result and each seeded variant separately. The
live experiment may halt on the first genuine blocker; this is a valid result,
not permission to exceed budgets. Healthy completion, seeded detection, and
correction recovery need distinct observations and may require separately
authorized run IDs rather than forcing every path into one successful run.

A correction is optional and requires a separate candidate-bound operator
`approve-correction` answer naming owning tasks, paths, obligations and one edit
iteration. No preauthorization by this spec. If exercised, demonstrate fresh
revisions, downstream rematerialization and exact final-tree reconstruction.
Confirm/refute actions retain existing contracts; failed corrections are
confirm-only acknowledgements that halt, not a new correction budget.

Exercise one controlled restart at a documented durable boundary. No repeated
fault injection or blind automatic restart loop. Report which checkpoints,
follow-ups, human decisions and recovery boundaries were actually reached.
AC-03.2 requires a failed-coverage restart observation in a dedicated negative
run; a miss blocks qualification. Investigate engine defects separately, never
waive the observation or alter the engine in the middle of the canary.

## Proposed finite envelope -- approval required

These proposed ceilings grant no spending or production default. Measure full
prompt fit; never truncate required context. Exhaustion halts without auto-raising.

| Dimension | Proposed ceiling |
|---|---|
| Policy | Explicit `checkpoint-evidence-v1`, clean-success, R=1, F=1 |
| Non-enabling slices S | 2; per-run `review.maxLogicalDispatches=12`, the minimum `(2+1)*(1+1)*(1+1)` |
| QA physical calls | 24 total, including retries/failover |
| QA input/output tokens | 480,000 / 144,000 total |
| Per QA dispatch | At most 2 physical attempts, 1 retry per route, 0 failovers; 20,000 prompt / 6,000 completion tokens per attempt |
| Evidence execution | 48 invocations; 1,800,000 ms total |
| Adapter timeout | Unit 120,000 ms; browser 300,000 ms including owned setup/cleanup |
| Per invocation output | Report 1 MiB; artifacts 16 MiB total, at most 8 files |
| Retrieval | Existing 24,576 bytes/1,000 lines packet; 49,152 bytes/2,000 lines candidate |
| Shared all-role experiment ceiling | 80 physical calls; 1,600,000 input / 480,000 output tokens across all run IDs |
| Shared experiment wall clock | 90 minutes elapsed, including pauses/interrupts; restart does not reset it |
| Source-edit allowance | Existing task repair cap; optional correction limited to 1 approved iteration |

QA and execution rows are per-run ceilings, not one allowance that guarantees all
observations. The shared all-role ceiling includes adapter semantic qualification,
specification, plan, implementation and every critic across every run ID;
QA limits are a subset, not an additional allowance. Admission must verify these
ceilings can be enforced by the actual governor/host controls. Wall-clock and
artifact limits require demonstrated enforcement; unsupported controls block
admission rather than existing only in this document.

Freeze the effective critic role and governor settings at two physical attempts,
one retry per route and zero failovers, rather than inheriting the default role.
QA currently derives retries from physical attempts and disables failover
(`review/qa-resources.ts`); prove the effective dispatch settings in admission
records. The worst-case inventory is 12 logical dispatches times 2 attempts =
24 physical calls, 480,000 input and 144,000 output tokens, including full
uncertain-dispatch charges. Measure every full frozen prompt against 20,000.
These are caps, not reserved success: three initial checkpoint reviews leave only
the permitted R/F slots; interrupted calls and correction reviews consume those
same slots. Do not promise healthy, seeded and recovery paths in one allocation.

Before admission, enumerate each run's expected checkpoints, R/F slots, fault
boundary, execution invocations and worst-case durations. Allocate all-role/spend
subcaps whose sums fit the shared experiment cap; a new run does not refill it.
The 1,800,000 ms execution ceiling is binding after six 300-second browser
timeouts even if far fewer than 48 invocations ran. Exhaustion is inconclusive,
not authority to raise the limit or start an unfunded replacement run.

The execution manifest must name the actual governor configuration fields and
supervisor/stop mechanism enforcing shared all-role usage, money and wall clock.
Record the shared start/deadline and restart-safe ledger; reject dispatch after
deadline, reserved allowance or aggregate cap exhaustion. Demonstrate stop during
an active command and after a paused/restarted interrupt. No such controller is
claimed implemented here: absent proof, live admission remains blocked.

Exact author/reviewer vendors, route IDs, models, physical retry settings, and
finite monetary/credit ceiling remain operator-approved inputs. Known author
provenance and heterogeneous critic admission are mandatory; no matching/unknown
vendor fallback. Price the frozen route configuration before approving spend.
If the governor cannot enforce the requested spend unit, obtain an explicitly
approved enforceable alternative before dispatch. Tokens alone are not a price.

## Approval sequence and run isolation

1. Approve bounded host integration paths, vendored regular-file packaging,
   dedicated configs and citation-free integration files. Name exact commands
   for preparation, copying and deterministic qualification; enumerate any
   package/browser installation or download, destination and source separately.
   Installation/download is forbidden unless explicitly listed and approved;
   runtime installation/download is always forbidden. Do not run providers yet.
2. Verify the integration using canonical fitness-app `agent:preflight`, without
   skip flags or quality-baseline changes. Separately approve any host Git action
   needed to establish an immutable isolated integration base; re-run canonical
   preflight for that exact base under the host's commit/preflight lifecycle.
   This does not authorize landing the profile/integration on host `main`.
3. Review the qualification corpus, complete manifests, frozen run spec/plan,
   reviewer configuration, exact base, proposed limits, and priced spend cap.
   Record explicit live qualification/run approval.
4. Bind the run authorization to approved spec hash, base commit, packages and
   narrow paths. For model edits allow only the approved canary test/fixture
   files inside the frontend; exclude adapters, host profile, budgets and baselines.
   Explicitly allow `createDetachedWorktree`, `editIsolatedWorktree`, and
   `runAllowlistedCommands`, naming permitted adapter/preparation argv. Authorize
   internal worktree/snapshot materialization and local Git objects, not delivery
   commits; `createLocalCommits` stays false.
   Disable branch creation, local commits, push, PR, merge and deploy operations.
5. Execute in engine-owned detached worktrees; stop at a quality interrupt,
   resource ceiling, deterministic failure, or `READY_FOR_GIT_APPROVAL`.
   Never commit, merge or cherry-pick the canary into `main`.

Do not silently migrate an old run or reactivate the historical fitness-app run.
Use a new run ID and explicit policy. Recheck host cleanliness/base and executable
bindings immediately before admission. A no-Git-delivery run still needs explicit
permission for engine worktree/snapshot materialization and local Git objects.

Implementation approval may precede hashes; execution approval requires the
reviewed immutable manifest: base, dependencies, case map, scoped paths/argv,
qualification, governor and demonstrated stop controls. A blanket approval
does not supply these bindings.

## Acceptance criteria and retained evidence

1. AC-01: Host bindings are qualified before live admission. Cases: AC-01.1:
   real unit/browser normalization; AC-01.2: stale executable/dependency rejected;
   AC-01.3: missing qualification or unapproved limits prevent dispatch.
2. AC-02: Evidence proves the requested behavior at sufficient layer. Cases:
   AC-02.1: native chooser activation; AC-02.2: Escape restores focus;
   AC-02.3: jsdom, skipped cases and fail-then-pass cannot substitute.
3. AC-03: Current checkpoint evidence governs release and delivery. Cases:
   AC-03.1: enabling and same-slice parents retained; AC-03.2: failed coverage
   blocks QA across restart; AC-03.3: healthy final gate stops for Git approval.
4. AC-04: Failure handling stays bounded and authorized. Cases: AC-04.1: seeded
   defect blocks; AC-04.2: consumed-answer recovery does not repeat unauthorized
   work; AC-04.3: exhausted budget stops without refill; AC-04.4: if correction is
   approved, selected revised deltas survive final reconstruction exactly once.
5. AC-05: Results are auditable without rollout claims. Cases: AC-05.1: record
   expected/observed outcomes and unresolved cases; AC-05.2: retain all usage and
   artifacts; AC-05.3: prove no delivery operation, baseline mutation or new
   canary citations in the integration baseline.

Retain engine/host SHAs, authorization, manifest/corpus hashes, plan/policy hashes,
requests/reports/receipts, actual argv, process cleanup results, candidate trees,
review packets/findings, human answers, restart events and usage ledgers. Record
latency, tokens, physical/logical calls, monetary/credit usage, confirmed misses,
false positives and unresolved outcomes with denominators. Do not retain secrets.

Operational success does not imply semantic qualification. Unreached paths remain
untested. One canary proves neither detection reliability nor merge trust. Set
sample sizes/pilot gates after measurement; rollout/default activation need approval.
