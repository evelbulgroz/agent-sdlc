# Acceptance evidence wire contract proposal

Offline implementation contract for the
[quality-gates draft](acceptance-evidence-and-qa-quality-gates.md),
[checkpoint contract](acceptance-evidence-checkpoint-contract.md) and
[resolution contract](acceptance-evidence-resolution-contract.md).
No execution, host edits, provider spend or Git permission is granted.

## Versions, primitives and hashing

- Reviewed offline versions: task-plan `2.0.0`, host profile `1.4.0`, quality policy
  `checkpoint-evidence-v1`, and the record versions below. Preserve task-plan
  `1.0.0` and host `1.2.0`/`1.3.0` decoding as explicit legacy paths.
- All new objects are closed: reject unknown fields and versions. Fields are
  required unless marked optional; nullability is explicit. Arrays of identities
  contain no duplicates. Numbers are finite integers unless stated otherwise.
- `Id` follows existing `IDENTIFIER_PATTERN`; task/slice ids retain the existing
  lowercase 64-character DAG pattern. `Hash` is lowercase SHA-256; `Tree`/`Commit`
  use the existing 40-character Git SHA contract. `Time` is UTC ISO-8601.
- `RelPath` is repository-relative POSIX syntax, not a glob: reject absolute paths,
  empty segments, `.`/`..`, backslashes, NUL and symlink traversal. Artifact paths
  use the same syntax relative to their designated operation directory.
- Structured hashes use existing `canonicalJson`/`sha256` in
  `policy/contracts/primitives.ts`. Raw files, patches, executable bundles and
  reports use SHA-256 over exact bytes, not normalized text. A hash-bearing record
  is hashed without its own hash field. Array order is significant.
- Separate immutable planning data from execution records. `taskPlanHash` hashes
  the immutable approved plan projection, including obligations, policy and adapter
  bindings, but excluding task status, parent/target trees and revision selection.
  Persist that projection; do not hash the mutable runtime plan on resume.
- Additive migrations create new revision/closure/receipt/answer/budget records.
  Do not overwrite old events or reinterpret legacy coverage as new-policy trust.
  Unknown policy is invalid; absent policy is legacy only through an explicitly
  supported legacy schema decoder, never a fallback for a malformed new plan.
- Legacy canonical hashes omit new policy fields; do not add null/default v1
  fields to legacy hash projections.

## Frozen policy and host registration

`QualityPolicy`:

```text
schemaVersion: "1.0.0"
policyId: "checkpoint-evidence-v1"
additionalCandidateReviews: integer from 0 to 2
followUpDispatches: nonnegative integer
testRetryPolicy: "clean-success"
retrieval: { maxPacketBytes: 24576, maxPacketLines: 1000,
             maxTotalBytesPerCandidate: 49152, maxTotalLinesPerCandidate: 2000 }
execution: { maxInvocations: positive integer, maxTotalDurationMs: positive integer }
review: { maxLogicalDispatches: positive integer, maxPhysicalCalls: positive integer,
          maxInputTokens: positive integer, maxOutputTokens: positive integer }
```

Offline approval uses explicit R=1/F=1 and the shown retrieval caps/clean-success.
R/F remain stored fields, never absent-policy defaults.
Retrieval totals include initial and follow-up source packets; metadata and model
prompt overhead are separately charged to token/input limits. Exhaustion halts.
Production execution/review numeric ceilings must be operator-supplied and finite.
Schema/unit implementation can proceed without selecting a production envelope;
no hosted run starts without it. Offline fixtures use finite test ceilings.
Validate `maxLogicalDispatches >= (S + 1) * (R + 1) * (F + 1)` using stored values;
explicit R=1/F=1 yields `4 * (S + 1)`.
Logical capacity is not a guarantee of sufficient provider tokens or availability.

Host `1.4.0` adds `evidenceAdapters: AdapterRegistration[]`. Canonical preflight
configuration remains separate and mandatory at final integration.

```text
AdapterRegistration:
  adapterId: Id
  protocolVersion: "1.0.0"
  bundleFiles: [{ path: RelPath, sha256: Hash }]
  dependencyFiles: [{ path: RelPath, sha256: Hash }]
  configurationFiles: [{ path: RelPath, sha256: Hash }]
  argv: nonempty string[]
  profiles: [{ profileId: Id, layers: Layer[], capabilities: Capability[] }]
  qualificationArtifactHash: Hash
  qualificationArtifact: { path: RelPath, sha256: Hash }  # required to execute; sha256 == qualificationArtifactHash
  limits: { timeoutMs: positive integer, maxReportBytes: positive integer,
            maxArtifactBytes: positive integer, maxArtifacts: positive integer }
```

`Layer = "unit" | "integration" | "browser" | "static"`.
The initial closed capability vocabulary is:

| Capability | Meaning and required qualification |
|---|---|
| `native-browser` | Actual browser execution, not jsdom; distinguish both in fixtures. |
| `native-file-picker` | Browser file-chooser activation by the declared action; reject programmatic input assignment as equivalent evidence. |
| `focus-navigation` | Real browser keyboard/focus traversal and restoration; synthetic clicks alone cannot qualify it. |
| `static-check` | Executed deterministic check with identified file/case outcomes; exit code alone cannot qualify it. |

Browser-native capabilities require the browser layer; picker/focus also require
`native-browser`. Static layer requires `static-check`. Browser layer alone
discharges neither picker nor focus. Unit/integration may have empty capabilities.
Expanding the vocabulary requires a new reviewed protocol version, not silently
accepting unknown strings. These capabilities constrain execution, not semantics:
adequacy review still checks actions and assertions against the obligation.

Hash the entire registration as `adapterBindingHash`. Qualification binds bundle,
configuration and profile/capabilities, not adapter name alone. Freeze the approved
host registration outside model-writeable source and verify byte hashes before
each invocation. Host-dependent preparation/runtime inputs are also frozen below.
Changing runner packages, configuration or bundle invalidates qualification/binding.
An unbounded or mutable adapter dependency cannot qualify by hashing its entrypoint
alone. Require a reproducible bundle with no external code dependencies, or list
the complete regular-file dependency closure in dependencyFiles and verify it.
Runtime executable/version inputs are part of preparationHash. Dependency files
may be copied into an approved contained bundle; symlinked dependency discovery
is not an engine responsibility. Empty dependencyFiles is valid only for a
self-contained bundle plus the explicitly bound runtime.

## Obligations and candidate identity

Task-plan `2.0.0` adds `qualityPolicy`, `qualityPolicyHash`,
`adapterBindings: AdapterRegistration[]`, and `evidenceObligations: Obligation[]`.
Task runtime fields move into versioned execution records; DAG/slices stay frozen.

```text
Obligation:
  obligationId: Id
  criterionId: "AC-NN"
  caseId: "AC-NN.N" | null
  owner: { kind: "task" | "slice", id: Id }
  observableOutcome: nonempty string
  setupAction: nonempty string
  expectedResult: nonempty string
  layer: Layer
  requiredCapabilities: Capability[]
  implementationPaths: RelPath[]
  testCases: [{ file: RelPath, caseKey: Id }]
  adapterBindingHash: Hash
  profileId: Id
```

Criterion/case identifiers use the existing AC grammar, including its supported
digit lengths; the notation above is descriptive, not a new fixed-width regex.
Require at least one implementation path and test case. `caseKey` is a stable
host-authored case identity within file/profile, not a displayed title. Map titles
only inside the host adapter; ambiguous mapping fails. Multiple cases may jointly
discharge an obligation; each must pass. A case may serve multiple obligations
only through explicit frozen mappings, never inferred from matching titles.
Cases lacking `AC-NN.N` retain criterion-level obligations with `caseId: null`.
Validate criterion/case existence and ownership against the approved spec/slices.
Enabling slices own no acceptance obligations; ordinary verification still runs.
Final integration executes every obligation using its original identity.

```text
CandidateBinding:
  runId: Id
  approvedSpecHash: Hash
  taskPlanHash: Hash
  qualityPolicyHash: Hash
  checkpointId: Id
  checkpointKind: "task" | "enabling" | "slice" | "final"
  ownerId: Id | null
  candidateRevision: nonnegative integer
  baseCommitSha: Commit
  treeSha: Tree
  revisionSetHash: Hash
  preparationHash: Hash
```

Final has null owner; other kinds identify task/slice. `revisionSetHash` hashes
ordered selected task revisions/deltas in that candidate. `preparationHash` hashes
the authorized hydration recipe, dependency/configuration inputs and permitted
generated verification outputs. Engine records actual paths outside the wire
binding; a host cannot choose a worktree by returning a path.

Capture task source trees before verification. Reject tracked source changes or
unauthorized untracked source before/after execution. Authorized generated outputs
are classified explicitly, never ignored by broad globs. A changed source/tree
requires a fresh execution revision; changed preparation invalidates receipts.

## Host-command request and report

Use one bounded JSON request on stdin and exactly one JSON report on stdout.
Stderr is bounded diagnostics, not execution evidence. Spawn approved argv without
a shell in the engine-selected worktree. No interpolation, command discovery or
host-module import into engine core. Use a fresh registered operation-artifact
directory; the engine communicates its absolute path solely as an output capability.
This directory grants no source write rights.

Executable qualification requires a canonical absolute `argv[0]` (no symlink
aliases or PATH discovery) and `executableSha256` binding its exact regular-file
bytes. The optional schema field preserves historical registration hashes when
omitted, but execution and receipt reuse require it. An interpreter binary is
qualified separately from hashed adapter bundle/dependency/configuration files;
all are part of the frozen registration hash and require offline qualification
and reapproval if changed. Existing legacy verification commands are unaffected.

On Linux, clean up the detached process group on success as well as failure and
timeout, before observing source. A bounded cleanup that cannot establish stopped
group members yields incomplete evidence. This is not a sandbox: descendants
can escape by calling `setsid`; hosts must exclude that behavior during
qualification or supply external containment.

```text
EvidenceRequest:
  schemaVersion: "1.0.0"
  operationId: Id
  binding: CandidateBinding
  adapterBindingHash: Hash
  profileId: Id
  obligations: Obligation[]
  artifactDirectory: absolute engine-issued path

EvidenceReport:
  schemaVersion: "1.0.0"
  operationId: Id
  requestHash: Hash
  adapterBindingHash: Hash
  profileId: Id
  cases: CaseResult[]
  artifacts: [{ path: RelPath, sha256: Hash, sizeBytes: nonnegative integer }]

CaseResult:
  file: RelPath
  caseKey: Id
  obligationIds: Id[]
  exercisedCapabilities: Capability[]
  outcome: "passed" | "failed" | "skipped" | "not-run" | "incomplete"
  attempts: [{ index: nonnegative integer,
              outcome: "passed" | "failed" | "skipped" | "incomplete",
              durationMs: nonnegative integer, artifactPaths: RelPath[] }]
```

Require every expected file/case/profile once with exact obligation mappings.
Adapters filter unrelated runner cases out of normalized `cases`, retaining raw
reports in artifacts; they cannot filter expected failures or retry attempts.
Attempt indices start at zero, contiguous. Passed results require nonempty attempts
all passed, required capabilities and process exit zero. Failed/incomplete attempts
cannot become passed via a final retry. Skipped/not-run cannot discharge anything.
Incomplete, missing or contradicted outcomes fail validation.

Persist `InvocationRecord` with schema `1.0.0`, operationId, requestHash, bindingHash,
adapterBindingHash, observedArgv, worktreeRegistryId, startedAt, finishedAt nullable,
exitCode nullable, reportHash nullable, artifactManifestHash nullable, and status:
`reserved | running | completed | failed | interrupted`.
Include `retryOf: Id | null` and `failureReason: string | null` to preserve bounded
infrastructure retry provenance, without storing unrestricted diagnostic output.
Engine-observed facts, not host claims, establish freshness/binding.
Each artifact must be a regular contained non-symlink file within declared limits;
verify raw hashes/size. Sanitize diagnostics; no environment/credential dumps.

Operations are persisted/reserved before spawn. Reuse only complete matching
receipts. A missing completion after crash is interrupted, never success. Retrying
uses a fresh charged execution operation; replaying a completed request does not
respawn it. Conflicting content for an existing operation id is rejected.
Test failures use the existing task repair boundary; infrastructure failures
permit only explicitly budgeted retries. No layer-specific exception bypasses QA.

`EvidenceReceipt` (`1.0.0`) contains operationId, requestHash, bindingHash,
adapterBindingHash, invocationRecordHash, reportHash, artifactManifestHash,
dischargedObligationIds and status `passed | failed | incomplete`. The engine
creates it after validation, never the host. Passed requires all requested cases
and process success; partial successes are diagnostic, not checkpoint acceptance.
Hash/persist the receipt with observations; publication and checkpoint completion
are atomic or recoverably ordered so a missing receipt never permits release.

`BudgetLedger` (`1.0.0`) contains runId, qualityPolicyHash, revision, counters
`executionInvocations`, `executionDurationMs`, `logicalDispatches`, `physicalCalls`,
`inputTokens`, `outputTokens`, and reservations
`[{ operationId, kind: execution | review | follow-up, checkpointId,
candidateRevision, status: reserved | consumed | interrupted }]`.
Counters are nonnegative integers. Reserve atomically before dispatch; reconciliation
with governor usage may increase charged cost, never erase interrupted work.
Keep per-checkpoint candidate/follow-up reservations to enforce R/F as well as
aggregate limits. Duration/token overrun stops further dispatch and keeps the gate
blocked; approval of a wire ceiling does not itself authorize provider usage.

## Task revisions, closures and correction transactions

```text
TaskRevision:
  schemaVersion: "1.0.0"
  runId: Id
  taskPlanHash: Hash
  taskId: Id
  executionRevision: nonnegative integer
  correctionId: Id | null
  parentTreeSha: Tree
  targetTreeSha: Tree | null
  patchHash: Hash | null
  parentRevisionSetHash: Hash
  status: "materializing" | "executing" | "verifying" | "completed" | "invalidated" | "failed"
  receiptHashes: Hash[]

ClosureRecord:
  schemaVersion: "1.0.0"
  binding: CandidateBinding
  selectedRevisions: [{ taskId: Id, executionRevision: nonnegative integer,
                        patchHash: Hash }]
  registryId: Id
  status: "building" | "verifying" | "reviewing" | "verified" | "accepted" | "invalidated" | "failed"
  receiptHashes: Hash[]
  reviewOperationIds: Id[]
```

Completed task revisions require non-null target/patch and current mandatory
receipts. Selection is a separate durable index keyed by run/task, not mutation of
historical revisions. Select at most one completed current revision per task.
Closures enumerate all transitive predecessor-slice tasks plus their own slice
tasks in frozen global order, including enabling siblings. Enabling becomes
`verified` with no adequacy review; non-enabling becomes `accepted` after review/
disposition clearance. Final also requires canonical preflight and final QA.

```text
QualityAnswer:
  schemaVersion: "1.0.0"
  answerId: Id
  interruptId: Id
  bindingHash: Hash
  findingIds: Id[]
  action: "refute" | "confirm" | "approve-correction"
  rationale: nonempty string
  evidenceHashes: Hash[]
  correction: null | {
    owners: [{ taskId: Id, expectedRevision: nonnegative integer,
               editPaths: RelPath[] }],
    rerunObligationIds: Id[],
    maxSourceEditIterations: integer from 1 to 2,
    expectedBudgetLedgerHash: Hash
  }
```

Only approve-correction grants scoped editing and has non-null correction.
For refute, each evidence hash identifies a closed JSON claim record:
`{schemaVersion:"1.0.0",bindingHash,findingId,rationale,evidenceHashes:Hash[]}`.
Rationale and underlying preserved evidence are nonempty; cover every frozen claim
on the exact candidate. Deterministic failures and insufficient execution cannot
be refuted. Confirm keeps blockers. Deterministic interrupts expose `failureId`
instead of critic findings; approve-correction must echo it in `findingIds`.
Failed corrections permit only confirm acknowledgement, never clearance.
Reject foreign/stale ids, scope, revision, budget and evidence before recording
the immutable CLI response. Pending decisions never project resume/authorize;
consumed decisions may resume only their bounded recorded completion.

Consume an answer in a compare-and-swap transaction on pending interrupt, current
binding, expected task revisions and budget-ledger hash. Identical answerId/content
replay returns its recorded result; changed content is invalid. Persist answer hash,
correctionId, owning revisions and affected-consumer set; remove their completion/
selection eligibility and invalidate closures/receipts/dispositions in that same
transaction. Delivery remains blocked while any correction is incomplete.

Correction states are `approved -> invalidated -> materializing -> executing ->
verifying -> rebuilding -> completed`, with `failed`/`interrupted` exits that keep
the blocker. Each transition is durable before its side effects. Resume verifies
registry/source/revision provenance, never assumes an interrupted edit succeeded.

Reapply prior owning deltas as checked inputs onto the actual new parent, edit only
approved owning-task paths, verify and capture fresh deltas. In frozen order,
rematerialize affected consumers from the new eligible closure, reapply checked
old deltas only as inputs, verify and recapture fresh parent/target records.
Conflicts halt; consumer edits need explicit scope. Store in-progress and completed
staged revisions for recovery, but they never win the durable current index.
Rebuild candidate snapshots using a correction-local staged revision map, rerun
invalidated obligations/reviews/preflight within remaining limits, then atomically
complete the correction and select all its completed current task revisions.
Before that transaction, no dependent release or closure acceptance is published.
No direct snapshot edits, appended tasks, mixed old/new closure trust or reset budgets.

## Retrieval, errors and acceptance before activation

`RetrievalRequest` (`1.0.0`) has operationId, reviewOperationId, bindingHash,
obligationId, file, and selector `{ kind: "lines", start: positive integer,
end: positive integer }` or `{ kind: "helper", symbol: nonempty string }`.
`RetrievalResponse` echoes requestHash and has fileHash, ranges
`[{start,end,text}]`, omittedRanges `[{start,end}]`, unresolvedHelpers `string[]`,
and outcome `complete | partial | unavailable`. Engine resolves only authorized
candidate files; symbol lookup grants no wider import/read scope. Charge every
packet under F and retrieval limits; partial output alone cannot refute absence.

Use existing `SdlcError` categories with a bounded evidence `reason`:
`UNSUPPORTED_VERSION`, `UNSUPPORTED_CAPABILITY`, `BINDING_MISMATCH`,
`CASE_IDENTITY_MISMATCH`, `INCOMPLETE_REPORT`, `COMMAND_FAILED`,
`EXECUTION_INTERRUPTED`, `CONTAINMENT_VIOLATION`, `BUDGET_EXHAUSTED`,
`STALE_ANSWER`, `RECONCILIATION_CONFLICT`. Schema errors block planning;
execution errors block their checkpoint; stale answers change no state.
New-policy coverage false/error emits FAILED; legacy expectations remain separated.

Offline approval covers this package's port, schemas, fixture commands, gates,
correction and persistence, not qualified host adapters. Before activation:
authorize exact host argv/dependency/preparation closure, qualified unit/browser
adapters, finite execution/review ceilings, bounded semantic evaluation and measured
pilot thresholds. Fitness-app remains the reference host; its adapters and all host
edits require separate authorization. No host argv, rollout or provider spend is approved.
