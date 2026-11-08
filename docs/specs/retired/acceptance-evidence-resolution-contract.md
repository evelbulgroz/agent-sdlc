# Acceptance evidence prerequisite resolution contract

Proposed companion to
[acceptance-evidence-and-qa-quality-gates.md](acceptance-evidence-and-qa-quality-gates.md)
and its [checkpoint contract](acceptance-evidence-checkpoint-contract.md).
This records design choices and activation prerequisites. The offline engine port
and fixtures are implemented; host changes, runs, Git and spending still require
separate authorization. The engine stays framework-neutral.
The [wire revision](acceptance-evidence-wire-contract.md) records reviewed offline
versions, fields, limits and durable correction transitions.

## Contract decisions

### Versioned obligations and evidence port

- Specify versioned request/report schemas with stable obligation and file/case
  identities, adapter/configuration hashes, candidate binding, explicit outcomes
  and complete attempt records. Apply the checkpoint contract's independent
  engine-observed invocation checks; a report cannot attest its own authorization.
- Define required fields, outcome enums, transport/result paths, size limits,
  idempotency and error semantics before implementation. Reject unsupported
  versions, missing identities, duplicate/foreign results and incomplete reports.
- Bump the strict task-plan schema for obligations. Keep legacy decoding and
  persisted historical evidence; do not silently migrate resumes to new policy.
- Verify positive schema round-trips and negative binding/version/identity cases
  using offline fixtures. Approving schemas does not authorize an execution.

### Capability vocabulary

- Start with a small extensible vocabulary of observable execution properties,
  not framework names: native browser execution, file-picker activation and focus
  navigation are motivating examples, not approved wire identifiers.
- Define each capability's scope, required case evidence and qualification
  fixtures. Layer requirements and capabilities are related but not synonyms:
  a browser runner alone does not prove an activation or focus assertion.
- Separate host-declared support, reported exercised capability and independently
  reviewed action/assertion adequacy. Unknown or unqualified capabilities cannot
  discharge requirements; missing support blocks planning without downgrading.

### Host-command reference adapters

- Qualify one browser adapter in a host with existing browser tooling and one
  adapter using existing unit-test tooling. They emit the same normalized contract
  despite different raw formats. No runner-name dispatch belongs in engine gates.
- Select exact argv, configuration and contained artifact paths with the host
  operator. Explicitly authorize and freeze those bindings before execution.
  Host source changes require separate approval; this draft changes no host.
- Use existing dependencies and runner configuration. Do not discover commands,
  dynamically load host plugins or add engine-side Playwright parsing.
- Qualification must preserve file/case identity, every attempt and explicit
  failed/skipped/not-run outcomes. Retain bounded raw fixtures for audit.

### Initial retry and flaky-result policy

- Propose clean successful execution as the initial discharge rule. If a test
  attempt fails and a runner retry passes, retain both and block the obligation;
  the adapter must not normalize that execution to an unconditional success.
- Infrastructure retries require explicit finite execution limits and recorded
  reasons. They cannot hide a test failure, reset budgets or fabricate a complete
  report. A process success with incomplete evidence still fails.
- A blocked task command retains existing authorized task-local repair. A new
  clean verification after permitted correction may discharge the obligation;
  old failed attempts remain historical evidence, not permanent run poisoning.
  Slice/final failures still escalate; critic decisions never enter task repair.
- More permissive flaky-test semantics require later policy approval supported by
  qualification. Execution retries and governor physical retries have separate
  accounting from logical QA review/follow-up slots.

### Bounded evidence retrieval

- Define a request by operation/packet id, obligation, authorized file, candidate
  hash and source range or helper reference. Responses preserve source provenance,
  included/omitted context, unresolved references and artifact hashes.
- Approve finite per-packet and aggregate byte/line/dispatch limits. Persist each
  request/response before additional retrieval; interrupted packets are not PASS.
- Retrieval adds no read permission. Stale source, forbidden paths, unavailable
  helpers or exhausted limits yield `insufficient_evidence`, not inferred absence.
- Test fourth-assertion retrieval, shared helpers, containment and interruption
  offline before hosted semantic evaluation.

### Human-only adjudication and correction

- Specify `answer` responses bound to pending interrupt, current candidate and
  finding ids. Refutation requires recorded rationale and case-relevant evidence;
  model agreement alone cannot dismiss a semantic gap.
- Correction approval names allowed edit paths, required reruns and remaining
  repair/review limits. It does not expand the run envelope, change obligations
  or reset budgets. Changed scope/plan requires renewed authorization.
- Bind correction to owning task ids and their current execution revisions,
  following the task-delta correction contract below. No edits to a checkpoint
  or final integration snapshot are accepted as authored delivery changes.
- Record answer consumption durably and idempotently. Reject stale candidate,
  foreign finding, replay with changed contents and scope-expanding answers.
- Pending human decisions never project mechanical `resume` or `authorize`.
  After durable consumption, mechanical resume may finish that exact recorded
  decision; it grants no new editing authority. Initial execution plus at most two
  recovery failures is allowed. Deterministic provenance/contract failures halt
  immediately; manual resume cannot bypass the halt. Use the reviewed wire
  correction executor/transaction contract.
- Failed or unprovable corrections create a new candidate-bound, confirm-only
  interrupt. Confirmation acknowledges the halt, never accepts staged revisions.
  Neither replay nor confirmation repeats edits/QA or refills budgets; starting
  another correction against invalidated selections is not supported.

### Task-delta correction and downstream rematerialization

- Reopen explicitly approved existing owning tasks as new execution revisions.
  Keep frozen task identities, DAG, integration order and path scopes. Ambiguous
  ownership or a required new task halts for operator-approved replanning; do not
  silently append a correction task or mutate the frozen plan.
- Invalidate owning-task completion and all consuming same-slice/downstream task
  revisions, closure snapshots, receipts and review dispositions before edits.
  Block dependent release and delivery. Preserve historical revisions and spent
  budgets; reopening for human-approved correction is not autonomous task repair.
- Materialize each revised owning task from its actual current parent tree and
  its previous task delta, preserving existing authored behavior before applying
  the approved correction. When predecessor revisions change, rematerialize in
  frozen order. A stale delta may only be reapplied with checked provenance as
  input to a fresh revision, never relabeled as an already completed new result.
  Conflicts halt without automatic conflict resolution or scope expansion.
- Edit only that owning-task worktree within its approved paths. Execute required
  verification and capture a fresh `targetTreeSha`, delta hash and execution
  revision from the actual `parentTreeSha`. Persist the selection of the new
  revision only when successful task completion and the whole correction complete
  atomically. Staged revisions support restart but never win the current index.
- Rebuild candidate snapshots from the correction-local staged revision map.
  Rematerialize every
  affected consumer from the new eligible closure, rerun task verification and
  capture its fresh parent/target delta before marking it complete. Any source
  edits needed in consumers require explicit correction scope, not automatic repair.
  Unaffected tasks remain reusable only with unchanged parent/delta provenance.
- Slice correction reconstructs and re-reviews the affected slice before release.
  Final correction uses the same owning-task path, rebuilds affected slice closures
  and final integration, and repeats required reviews/preflight within remaining
  budgets. Never patch final integration as a shortcut.
- Final reconstruction applies one selected revision per task exactly once.
  Assert tree equality with the corrected candidate; the fix must survive delivery
  and archive patch composition. Dirty snapshots or stale/mixed revision bindings
  fail closed. Include crash/restart between invalidation, capture and selection.

### Policy-scoped coverage gates and compatibility tests

- The failed-result rule applies to the new quality policy only. Frozen policy
  selects routing and event semantics before coverage evaluation and on resume.
  Legacy runs retain advisory false coverage and historical event vocabulary;
  label it explicitly, never interpret a legacy PASSED event as new-policy trust.
- Keep the false-coverage assertions in `workflow/preflight-gate.spec.mjs` and
  `workflow/graph-slice3.spec.mjs` as explicitly legacy fixtures, not new-policy
  acceptance expectations. Reusing a test file does not reuse its old gate rule.
- Add new-policy counterparts for false coverage and evaluation errors: emit
  `AC_COVERAGE_FAILED`, no PASSED for that candidate/evaluation, no QA advancement
  or delivery. Test both local-commit authorization modes and resumed entry.
  A successful earlier candidate event remains historical, not current success.
- Verify positive new-policy coverage independently; it still cannot substitute
  for adequacy. Test missing/unknown policy handling as fail-closed except for
  explicit versioned legacy decoding. Adoption requires reapproval/replanning and
  fresh evidence; a restart cannot silently switch semantics.

## Proposed capacity and resource policy

Trial R=1 and F=1: reserve `4 * (S + 1)` logical dispatches, where S counts all
non-enabling slices. This permits one additional candidate review and one
follow-up per candidate review; it requires neither spending every slot nor
autonomous correction. The review accepts these explicit offline v1 values,
not inferred defaults; capacity checks still use stored R/F.

- Approve R/F explicitly in frozen policy. Preserve checkpoint accounting and
  failure/exhaustion semantics from the checkpoint contract.
- Before hosted qualification, obtain separate finite credit/invocation ceilings.
  Measure packet sizes, token usage, latency and physical calls under those limits.
  A bounded evaluation can halt inconclusively; it must not raise its own ceiling.
- Use measurements to propose finite production token/physical-call and execution
  limits. Validate reserved logical capacity against the approved resource envelope;
  reject insufficient capacity rather than silently shrink required reviews.
  Resource exhaustion can still occur and always halts.
- No spec acceptance, example budget or adapter qualification authorizes a run,
  provider spend, host edits or Git delivery.

## Qualification and rollout gates

Freeze and hash a corpus covering adequate assertions, omitted decisive context,
weak assertions, named seeded defects and malformed/forged execution reports.
Keep fixtures and expected outcomes separate from generated reviewer decisions.

- Deterministic gate: every required negative fixture blocks, every supported
  normalization fixture preserves identity/outcomes/attempts, and positive bound
  receipts pass. Offline routing replay is token-free; failures prevent pilot
  qualification, without weakening assertions or editing quality baselines.
- Semantic evaluation: separately governed reviewers assess the frozen corpus.
  Record confirmed/refuted/unresolved outcomes, false positives, false negatives,
  uncertainty, defect detection and cost. Define denominators and retain examples;
  unresolved outcomes cannot be counted as correct detections or clean passes.
- After measurement, propose numeric thresholds, sample requirements and reviewer/
  provider configuration for an explicitly approved opt-in pilot. Do not invent
  universal reliability thresholds from an unmeasured or small corpus.
- A missed defect on the qualification corpus blocks qualification pending review;
  a false positive or uncertainty requires analysis rather than an automatic
  policy relaxation. Preserve the result when refining or expanding the corpus.
- Default activation is a separate later decision requiring measured pilot
  evidence and explicit approval. No silent legacy adoption, baseline mutation
  or merging qualification canaries. A passing corpus proves neither universal
  adequacy nor merge trust.

## Approval and implementation sequence

1. Review exact schemas, capability definitions, retrieval limits, clean-success
   policy and human-control response/executor contract. Resolve wire choices before
   the implementation task manifest is frozen; record accepted/proposed values.
   Use the wire revision as the concrete approval candidate, not a run permission.
2. Implement the engine port and two fake-argv fixture report shapes. Run offline
   schema, normalization, binding, lifecycle and human-control boundary checks.
   Integration must also satisfy the parent spec's implementation done bar.
3. Separately authorize real unit/browser adapters in fitness-app and finite
   semantic qualification, then measure detection,
   uncertainty and resource use. Failed or exhausted qualification stays blocked.
4. Approve production limits, numeric pilot gates and opt-in deployment based on
   results. Default activation remains outside initial implementation acceptance.

The spec becomes implementation-ready only after wire/policy contracts and
implementation scope are approved. Host execution bindings and finite runtime
ceilings must be approved before any real host run, not before offline coding.
Readiness is not rollout readiness: later
qualification and pilot gates remain explicit prerequisites to activation.
