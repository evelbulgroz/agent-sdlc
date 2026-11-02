# Acceptance evidence checkpoint contract

Normative companion to the draft
[acceptance-evidence-and-qa-quality-gates.md](acceptance-evidence-and-qa-quality-gates.md).
These new-policy contracts are implemented for the offline engine and fixtures.
Real host adapters and production activation remain subject to the prerequisites.
The [resolution contract](acceptance-evidence-resolution-contract.md) defines
their approval sequence, proposed pilot policies and qualification gates.
The [wire proposal](acceptance-evidence-wire-contract.md) supplies record fields
and transitions. Reviewed offline decisions are recorded there; this is not run
or host authorization.

## Verified source limitations (legacy baseline)

- `execution/task-acceptance-evidence.ts` binds citations to passing execution
  after edits, but returns null without a supported evidence command or tests.
  Unsupported output already fails when the validator runs.
- `execution/ac-coverage.ts` checks assertion presence/citations, not meaning.
  `execution/minimal-verification.ts` requests an author self-audit.
- `workflow/preflight-gate.ts` emits `AC_COVERAGE_PASSED` even for false coverage
  and does not bind final coverage to fresh execution. The motivating run's
  coverage passed, so false coverage did not cause its findings.
- `workflow/nodes/review-qa.ts` records P1 findings with `repairAuthorized: false`,
  then advances to committing or Git-ready. SKIP, budget exhaustion and deferred
  unavailable review can also advance. `workflow/graph-qa-advisory.spec.mjs`
  explicitly preserves advisory P1 behavior.
- `review/excerpt-extractor.ts` defaults to three assertions per test.
  `docs/backlog.md` records resulting false positives and open blocking policy.
  Grounding a quote does not corroborate an absence claim.
- Task completion releases dependents; `workflow/nodes/execute-tasks.ts` and
  `workflow/nodes/reconcile.ts` integrate only after all tasks complete.
- Slice kinds include enabling, vertical and activation. Every non-enabling slice
  owns acceptance criteria; activation cannot be omitted from review allocation.
- `execution/task-tree-delta.ts` derives a single dependency tree or temporary
  multi-parent tree. `workflow/reconciliation.ts` applies each task's
  `parentTreeSha` to `targetTreeSha` delta once in global integration order.
- Cleanup/archive and preflight sibling scans infer worktrees from direct children
  of `worktrees/`. Nested checkpoint containers would be misclassified.
- `review/critic-budget.ts` admits QA after green bound preflight, caps at one,
  and skips on any existing QA regardless of a new key.
- `workflow/node-helpers.ts` reads `qaReviews[0]` and only
  `AC_COVERAGE_PASSED`. New candidate-bound success/failure readers are required.
- `cli/shell-driver.ts` mechanically replays `resume` and `authorize`.
- `host/command-policy.ts` defaults to test/build/lint/typecheck and contract
  verbs, not `test:e2e`. `host/verify-runner.ts` provides an existing host-command/
  result seam; `review/verifier.ts` binds preflight results to candidate trees.
  Neither currently supplies the proposed generic case-level evidence port.

## Framework-neutral evidence port and host adapters

The engine understands evidence obligations and normalized results, not testing
products. Playwright, Jest, TAP and static-tool report interpretation belongs to
host-space adapters. Extend the host verification boundary without replacing
canonical preflight or importing runner-specific parsers into the new-policy core.
Existing execution parsers remain compatible with legacy runs.

- Engine ownership: obligation/layer policy, capability requirements, request and
  report validation, candidate/invocation binding, permissions, freshness, resource
  accounting, checkpoint decisions and delivery blockers.
- Host ownership: explicit runner argv, browser/runtime environment, fixtures,
  runner configuration, raw-report parsing and normalized case/attempt results.
  A host may use Playwright or another runner without changing engine routing.
- Initially use a host-command adapter protocol, not dynamically imported host
  plugins. An explicitly authorized argv consumes a structured request and emits
  a bounded versioned JSON report. No shell command discovery, arbitrary command
  strings, new test dependencies or implicit `test:e2e` authorization is introduced.
  Choose the transport/result path and exact wire schema before implementation.

The semantic contract uses the reviewed wire fields:

- Host registration declares adapter identity/version, supported protocol and
  capability set, explicit argv and configuration binding. Freeze these with the
  approved verification policy; a task cannot replace its own verifier unnoticed.
  A changed adapter/configuration requires renewed binding and affected evidence.
- Requests identify the engine-issued operation, run, spec/plan hashes, checkpoint,
  actual candidate tree/digest, obligation ids, required capabilities, expected
  source/test paths and approved execution profile. The engine selects the actual
  worktree and enforces command/path authorization; request data grants no rights.
- Reports identify the request and adapter/configuration, and return per-case
  source file, stable case identity, obligation mapping, execution profile,
  capabilities exercised, outcome, attempts and raw-artifact references/hashes.
  Failed, skipped, not-run and incomplete results remain explicit. Missing file/
  case identity cannot fall back to a passed title or process exit code.
- Execution profiles and attempt records are generic. Browser projects and runner
  retry syntax stay host-owned; adapters preserve every attempt and cannot hide
  failures behind a final pass. The proposed initial policy requires a clean
  successful execution; a retry pass after a failed test attempt remains blocking.
  Execution retries consume approved execution limits, not QA review slots.
- The engine records observed argv, worktree/candidate, adapter binding, process
  outcome and artifact hashes independently. Validate untrusted reports against
  those observations and expected cases; reject mismatches, duplicate/foreign
  results, escaping paths, unsupported versions and stale or incomplete evidence.
  Artifact access stays bounded/contained; never persist secrets/environment dumps.
- Required capabilities must be supported before plan freeze. Unsupported native
  browser or static obligations block planning rather than downgrade to jsdom,
  unit titles or exit-code-only evidence. Reports must identify exercised
  capabilities, but declarations and self-reported labels alone prove no behavior.
  Independent adequacy review still examines case-relevant actions/assertions.

Host adapters require qualification against frozen raw-report and native-behavior
fixtures before claiming capabilities. Verify normalization, case/file identity,
attempt preservation and failure semantics. Such qualification is evidence, not
merge trust; deterministic replay remains token-free and hosted critic evaluation
retains separate authorization. Exact schemas, capability vocabulary, host argv,
retry policy and qualification thresholds remain acceptance prerequisites.

## Checkpoint tree and scheduler barrier

- New-policy scheduling yields at a completed slice before starting cross-slice
  dependents. Same-slice task dependencies retain existing execution order.
- Every non-enabling slice (vertical or activation) needs an accepted reviewed
  checkpoint. Enabling slices need a durable verified closure snapshot containing
  all their completed task deltas and predecessor closure. They have no adequacy
  review or acceptance cases, not a prohibition on materializing a closure tree.
- Reconcile the slice and its eligible predecessor closure, using frozen
  integration order and recorded task deltas, into a detached checkpoint worktree
  at `<runtimeDir>/checkpoint-worktrees/<checkpointId>`. Each checkpointId is a
  unique engine-generated safe path segment bound to slice and candidate revision.
  There is no nested container under `worktrees/`.
- Store checkpoint parent/tree SHA, ordered task/delta hashes, slice id and
  revision. Exclude unrelated parallel slices and unfinished tasks. Dependent
  worktrees must use the same eligible predecessor closure.
- Hydrate/prepare this checkpoint, execute its obligations, then assess adequacy.
  Non-enabling release requires durable review acceptance; enabling release
  requires complete successful verification of its registered closure snapshot.
- Partial reconciliation conflicts halt through an operator gate without source
  edits or dependency release. Final integration remains a separate all-task tree.
- Checkpoint worktree creation must be explicitly covered by authorization.
  It grants no branch/local-commit permission. Engine-owned reconciliation/index
  writes remain contained; model source scope is unchanged.
- Updates belong in task scheduling, execute-tasks orchestration, reconciliation,
  worktree authorization, persistence and graph routing, not only QA nodes.

## Parent-tree and delta invariant

- Persist the eligible predecessor-closure tree as `parentTreeSha`
  before starting every task whose initial source is that closure. Materialize
  the task from exactly that tree; do not retain the old single-edge parent.
- For same-slice tasks with additional completed local dependencies, materialize
  a derived parent by applying their task-only deltas once onto the eligible
  predecessor closure. Persist that actual derived `parentTreeSha` and closure
  provenance before execution. Task-local dependency order remains unchanged.
- Eligible predecessors include reviewed non-enabling and verified enabling
  slices. Use the transitive frozen slice DAG, not only reachable task edges:
  include every task in each predecessor slice, including enabling siblings.
  Multiple predecessors require their union of current task deltas in frozen
  global order, deduplicated by task identity. Never stack snapshot diffs or infer
  closure from a single dependency edge. Conflicts halt before execution.
- Capture each task's delta solely as `diff-tree parentTreeSha targetTreeSha`.
  Checkpoints are evidence snapshots, not extra authored deltas.
- Final reconciliation applies each task-only delta once in global integration
  order. Do not apply a checkpoint delta in addition to its constituent tasks.
  Verify the reconstructed closure/tree binding before accepting final evidence.
- Resume checks stored parent tree and eligible closure provenance. A changed
  predecessor invalidates dependent task deltas and evidence; do not rebase or
  relabel an old delta as if it came from the new parent.
- Human correction revises explicitly named owning tasks, not checkpoint source.
  Recapture their target trees and deltas, then rematerialize affected consumers
  and checkpoints under the resolution contract. Final reconciliation selects
  one current revision per task; it never applies old and revised deltas together.

## Registered worktree lifecycle

- Persist each checkpoint as a role-tagged registered Git worktree with run id,
  checkpoint id, slice, revision, safe relative path, parent/tree SHA and lifecycle
  state. Creation is recoverable: interruption between Git creation and persistence
  is reconciled by exact Git registration/path, never treated as successful review.
  Verified enabling snapshots use the same registry/cleanup rules with an explicit
  enabling role and verification state; they cannot satisfy an adequacy review.
- `persistence/run-cleanup.ts` removes each registered checkpoint via Git,
  not its container. Retain legacy task/single/integration discovery for legacy
  runs; reject escaping paths and symlinks rather than broaden cleanup.
- `persistence/run-archive.ts` preserves checkpoint records/evidence and includes
  them in cleanup, but excludes checkpoint worktrees from task-id discovery and
  unlanded-patch composition. Use final integration/tree or task-only deltas;
  checkpoint snapshots must never be counted as a second delivered patch.
- `workflow/preflight-gate.ts` and acceptance-evidence search use explicit
  role/candidate-bound paths. Final coverage searches final integration, not every
  sibling task or checkpoint; slice coverage searches only its registered tree.
  A checkpoint may prove only its bound slice/candidate obligations.
- Update retention/worktree-presence and archive-compaction readers to recognize
  registered checkpoints. Missing/unregistered worktrees cannot satisfy evidence.
  After verified cleanup remove only the known empty checkpoint container.

## Review admission and identity

- Slice adequacy requires successful current checkpoint-bound verification.
  Final QA requires current canonical integration preflight. A slice receipt
  cannot stand in for final preflight or vice versa. Legacy admission is unchanged.
- Slice attempt key: `qa:<specHash>:<planHash>:slice:<sliceId>:<treeSha>`.
- Final attempt key: `qa:<specHash>:<planHash>:final:<treeSha>`.
- Operation ids additionally identify initial/follow-up packet index. Artifact
  hashes include checkpoint kind and evidence binding. Persist binding mismatch
  as failure; do not reuse a successful review after its receipts change.
- Reuse only completed matching attempts. Existing any-QA skip and phase-only
  artifact reuse remain legacy-only and cannot satisfy a different checkpoint.
- Resolve follow-up evidence through persisted bounded packets in the same
  candidate review. Store reservations, packet provenance and partial responses
  before additional dispatches; a partial review cannot count as PASS.
- Delivery/PR/status select exact current checkpoint/candidate identities and
  dispositions, never `qaReviews[0]` or an unrelated latest review.

## Budget arithmetic

S is the number of non-enabling slices (vertical plus activation) frozen in the
plan. Enabling slices consume no adequacy-review allocation. One final QA review
is mandatory even when S is zero.
R is the explicitly approved maximum additional candidate reviews per checkpoint,
an integer from 0 to 2. F is the explicitly approved finite nonnegative maximum
follow-up dispatches per candidate review. There are no inferred R/F defaults.
The review accepts explicit R=1/F=1 v1 policies for offline work, not absent-policy
defaults. Capacity always uses stored R/F, separate from resource authorization.

Required maximum logical dispatch allocation:

`(S + 1) * (R + 1) * (F + 1)`

The S slice checkpoints plus one final checkpoint each receive an initial review,
up to R additional candidate reviews, and up to F follow-ups per candidate review.
This is capacity reservation, not a requirement to spend every slot. For example,
S=2, R=0, F=1 requires capacity for six dispatches; three initial dispatches suffice
if no follow-ups are needed. The example does not approve those policy values.

- Planning rejects approved capacity below the formula. Separately approve finite
  aggregate token and physical-call limits; the formula cannot guarantee provider
  availability or sufficient tokens for every request.
- Initial dispatch and each follow-up consume allocation, including failed or
  interrupted dispatches. Identical operation replay consumes no new logical
  slot; governor retries still consume physical-call limits.
- A failed/interrupted dispatch has no reusable success. Recovery uses a fresh
  packet/operation slot within the approved allocation or halts when none remains.
- Candidate changes do not reset checkpoint or aggregate budgets. Extra candidate
  review capacity is not source-edit authorization or an autonomous repair budget.
- Exhaustion of any applicable limit halts visibly without accepting evidence,
  releasing dependents, or delivering Git changes.
- This deliberately replaces `QA_CRITIC_CAP=1` for the new policy and removes
  its any-QA skip. Spec/plan/code caps and legacy accounting remain unchanged.

## Human-only correction boundary

Active-task obligation command failures retain the existing bounded task repair
loop. Slice/final command failures escalate. A critic finding or disposition never
re-enters the task repair loop.

Adjudication and post-critic correction require a pending interrupt answered via
`answer`, or a new human-only action outside `MECHANICAL_CONTINUATION_ACTIONS`.
Never project these approvals as `resume` or `authorize`. Shell watch stops without
consuming them. Correction approval binds interrupt, candidate, edit paths and
reruns; a later resume can execute only the consumed explicit approval.

Use the reviewed wire response and correction transaction. Do not revive the
retired repair workflow through generic resume.

## Required boundary verification

- Correct an owning task after slice and final review: recapture its delta,
  rematerialize downstream tasks and prove final delivery retains the fix once.
  Direct checkpoint edits and stale task revisions cannot satisfy release.
- Two enabling siblings, and an enabling slice beside a reviewed predecessor,
  both contribute all edits to the successor parent and final reconstructed tree.
- An enabling predecessor feeds a vertical slice with two locally dependent tasks:
  both actual parents retain all enabling sibling edits; the later task adds the
  local delta onto the eligible base and final reconstruction preserves all edits.
- Legacy false coverage remains advisory only under legacy policy. New-policy
  false/error coverage emits FAILED, never a current PASSED, and blocks QA/delivery;
  restart cannot change policy or reinterpret a historical PASSED as quality trust.
- Two offline fixture report shapes normalize into the same contract;
  engine gates use no runner-name dispatch. Legacy parser behavior is preserved.
- Missing capabilities block planning; a capability label without exercised
  case evidence cannot discharge native activation/picker/focus obligations.
- Reject forged operation/tree/adapter bindings, same-title foreign-file results,
  skipped/missing/duplicate cases, malformed versions and exit-code-only reports.
- Preserve all attempts, test approved flaky-result semantics and exhausted
  execution limits; adapter/configuration changes invalidate affected evidence.
- Host-command timeout, oversized report, escaping artifact path and interrupted
  receipt persistence fail closed without dependency release or delivery.
- Two slices and final QA dispatch independently; the first review cannot satisfy
  later checkpoints even with the same spec or reused phase.
- Bounded follow-ups dispatch under distinct identities; exhaustion halts.
- Failure/restart consumes reservations without producing phantom success.
- Component success does not release dependents before checkpoint acceptance.
- Shell watch cannot answer/refute/approve correction; a real answer is required.
- Historical review/coverage events remain; readers select current evidence.
- An activation-only plan reserves its slice plus final review; enabling-to-
  activation plans release dependents only after activation acceptance.
- A predecessor slice with sibling edits feeds a single-edge downstream task;
  assert its actual persisted parent tree contains both siblings and final
  reconciliation preserves each change exactly once without conflict.
- Same-slice local dependency and multi-slice closure cases assert parent/delta
  provenance, not only command order. Stale closure on resume fails closed.
- Cleanup removes registered checkpoint worktrees individually. Archive patch
  excludes checkpoint duplicates; final coverage cannot read stale checkpoint
  assertions. Include interrupted registration, missing paths and containment.
