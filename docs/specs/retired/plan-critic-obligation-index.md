# Intent

Status: retired 2026-11-28 (implemented on `e95e270`). This file is no longer a `check-spec` goal.

## Goal

`packPlanDocument` cites `taskPlanHash` and a compact obligation index, and it stops embedding `evidenceObligations` in the critic document. A plan that was over 20480 bytes only because of those records then fits. A plan that is still over 20480 bytes after that replacement throws `INVALID_CONTRACT`. The stored v2 projection, `hashTaskPlanProjection`, and the deterministic gates keep every obligation record. `PLAN_DOCUMENT_MAX_BYTES` stays 20480. The assembled-prompt ceiling stays 24576 bytes and 1000 lines.

Run `2026-11-26-eslint-gate-measurement` blocked with `INVALID_CONTRACT` before the plan critic. Rebuilding that run's plan through the current packer produces 26029 bytes. The immutable projection is 22312 bytes, of which `evidenceObligations` is 15180 bytes for 20 obligations. The wrapper task summary is 3696 bytes and does not contain obligation prose. Replacing the obligation records with the plan hash and a compact index measures 12425 bytes. The ceiling on that run was crossed by one full copy of the records. A schema-valid plan can still exceed 20480 bytes after the same replacement when another field is large. The fitting fixture and that rejection fixture are defined in the acceptance criteria.

## Non-goals

- Do not raise `PLAN_DOCUMENT_MAX_BYTES`, the 24576-byte prompt ceiling, or the 1000-line prompt ceiling.
- Do not edit `policy/task-planner/task-readiness.ts`, `policy/contracts/dag-schema.ts`, or the obligation schema.
- Do not change `packSpecDocument` or `buildPhasePrompt`'s obligations-hash branch.
- Do not remove the runtime task summary, `qualityPolicy`, or `adapterBindings` from the packed plan document.
- Do not add a new obligations-file hash. `taskPlanHash` already hashes the projection that contains the records.
- Do not copy acceptance-criterion sentences into the plan document. Slices and tasks store `AC-NN` ids. The spec critic already reviewed the sentences.

## Owning context

`review/critic-input-packing.ts` in agent-sdlc.

## Touched surfaces

- review/critic-input-packing.ts
- review/critic-input-packing.spec.mjs
- review/README.md
- workflow/nodes/planning.spec.mjs

## Invariants and constraints

- `PLAN_DOCUMENT_MAX_BYTES` remains 20480. A v2 critic document above that throws `INVALID_CONTRACT` and names the ceiling. A document of 20480 bytes is accepted.
- `buildPhasePrompt` still throws `INPUT_OVERSIZED` above 24576 bytes or 1000 lines, before a model call.
- `projectTaskPlan` and `hashTaskPlanProjection` are unchanged. The packer copies the projection for the critic document and omits `evidenceObligations` from that copy. It does not mutate the plan argument.
- The critic document carries `taskPlanHash` once, equal to `hashTaskPlanProjection` of the same plan. `planPolicyHash` stays beside it. They are different hashes.
- When `evidenceObligations` is present, the document carries `obligationIndex`: one object per stored obligation, in stored order, with `criterionId`, `caseId`, `ownerKind`, `ownerId`, and `profileId`. A null `caseId` is JSON null. The index does not include `testFile`, `testCases`, `implementationPaths`, `requiredCapabilities`, `observableOutcome`, `setupAction`, `expectedResult`, or `adapterBindingHash`.
- A schema `1.0.0` plan still packs the runtime task summary, gains no obligation index, and is not refused for the 20480-byte plan-document cap.
- `qualityPolicy`, `adapterBindings`, slices, and slice `acceptanceCriteria` ids stay in a v2 critic document. Wrapper `verificationCommand`, `worktreeSubdir`, and `humanReviewEvidence` stay when the input task carries them.
- `review/critic-input-packing.ts`, `review/critic-input-packing.spec.mjs`, and `review/README.md` each stay at or under 500 lines and 20480 bytes.

## Public contract impact

None. No host profile, HTTP, or OpenAPI change. `taskPlanHash` is computed by the same function. The plan-critic prompt body no longer contains obligation prose.

## Acceptance criteria

1. AC-01: The fitting packing fixture cites the task-plan hash and an obligation index instead of the obligation records. Given the schema-valid twenty-obligation packing fixture: schema 2.0.0, the same run, policy, and adapter as the existing packing fixture, one vertical slice whose goal is `Make the result visible.` and whose acceptance criteria are AC-01 through AC-20, one task that matches that fixture and whose `authoredPaths` includes `src/result.spec.mjs`, and twenty obligations with ids `obligation-ac-01` through `obligation-ac-20`, criterion ids AC-01 through AC-20, `caseId` null, owner kind `slice` and id `slice-a`, `testCases[0].file` equal to `src/result.spec.mjs`, the same prose, implementation path, layer, capabilities, and profile as that fixture, and 500 `x` characters appended to each `expectedResult`. Then `packPlanDocument` returns at most 20480 bytes, `taskPlanHash` equals `hashTaskPlanProjection` of that plan, `obligationIndex` has one object per obligation in stored order with `criterionId`, `caseId`, `ownerKind`, `ownerId`, and `profileId`, `evidenceObligations` is absent, the record strings `observableOutcome`, `setupAction`, and `expectedResult` are absent, and `src/result.spec.mjs` remains on the task `authoredPaths`. Cases: AC-01.1: this fixture packs at or under 20480 bytes; AC-01.2: all twenty index rows are present and the obligation records and their prose fields are absent; AC-01.3: the shared test path remains.
2. AC-02: The stored projection and both ceilings stay fail-closed. Given the fitting fixture, the same fixture with the slice goal replaced by 21000 `g` characters, and an assembled prompt of 24577 bytes. Then `projectTaskPlan` still returns every `evidenceObligations` record, `PLAN_DOCUMENT_MAX_BYTES` is 20480, a compact critic document of 20481 bytes throws `INVALID_CONTRACT`, a compact critic document of 20480 bytes is accepted, the 21000-character slice goal throws `INVALID_CONTRACT` without dropping that goal or another retained field, and `buildPhasePrompt` throws `INPUT_OVERSIZED` and reports the byte count. Cases: AC-02.1: the projection still holds every obligation record; AC-02.2: 20481 bytes is `INVALID_CONTRACT` and 20480 bytes is accepted; AC-02.3: 24577 assembled prompt bytes is `INPUT_OVERSIZED`; AC-02.4: the 21000-character slice goal is rejected and retained fields are not dropped to fit.
3. AC-03: A schema 1 plan keeps the runtime task summary and gains no index. Given a schema 1 plan whose tasks include `worktreeSubdir`, `humanReviewEvidence`, and `verificationCommand`, and which has no `evidenceObligations`. Then the packed document includes those three fields, has no `obligationIndex`, and is not refused for the 20480-byte plan-document cap. Cases: AC-03.1: the runtime fields remain; AC-03.2: no obligation index is added.
4. AC-04: Policy, bindings, slices, and supplied wrapper fields stay. Given the plan from AC-01 with `worktreeSubdir` set to `worktrees/task-a` and `humanReviewEvidence` set to `not_required`. Then the packed document still contains `qualityPolicy`, `adapterBindings`, each slice `acceptanceCriteria` id, wrapper `verificationCommand`, `worktreeSubdir` equal to `worktrees/task-a`, and `humanReviewEvidence` equal to `not_required`. Cases: AC-04.1: policy and adapter bindings remain; AC-04.2: slice criterion ids and the supplied wrapper fields remain.

## Failure defenses

- Omitting an index row, or shortening obligation prose inside the critic document, is not a success.
- A critic document that is still above 20480 bytes after the index replacement throws `INVALID_CONTRACT`. The packer does not drop `qualityPolicy`, `adapterBindings`, slices, or wrapper fields that the input carries. It does not invent `worktreeSubdir` or `humanReviewEvidence` when the input task omits them.
- The packer does not mutate the plan argument. `hashTaskPlanProjection` of the plan after packing equals the hash from before packing.
- Editing `policy/task-planner/task-readiness.ts` or `policy/contracts/dag-schema.ts` is outside this change. Those files are in `boundedPlanningHash`.
- A schema 1 plan does not start failing the 20480-byte plan-document cap.

## Verification plan

- `review/critic-input-packing.spec.mjs` proves AC-01, AC-02.1, AC-02.2, AC-02.4, AC-03, and AC-04.
- `review/critic-prompt.spec.mjs` proves AC-02.3.
- Package check: `pnpm run test:unit` in this package.

## Unresolved questions

_None_

## Assumptions

- The 26029-byte figure is the packed document for fitness-app run `2026-11-26-eslint-gate-measurement`, task-plan artifact `841c6f94b0587613be3f30936909e73bc370a17a8598e856cf340faa1bb5fb6b`, measured with the current packer on 2026-11-27. The stored projection's `evidenceObligations` field is 15180 bytes. The same replacement, hash plus index and no obligation records, measures 12425 bytes.
- The AC-01 fixture is schema-valid only with distinct obligation ids and criterion ids AC-01 through AC-20, listed on the slice. Two copies of obligation id `obligation-ac-01` fail `projectTaskPlan` with `duplicate obligation 'obligation-ac-01'`. Twenty short obligations without the `expectedResult` padding measured 12317 bytes on the packer before this replacement, under the cap. With 500 `x` characters on each `expectedResult`, that pre-change document measured 22317 bytes and `packPlanDocument` threw `INVALID_CONTRACT`. The embedded projection is 21655 bytes. After the index replacement that document is 4595 bytes, the prose is absent, and `src/result.spec.mjs` remains on `authoredPaths`.
- The same fixture with the slice goal replaced by 21000 `g` characters measures 24909 bytes for the immutable projection after the replacement, before the runtime wrapper. With the wrapper this spec keeps, the same replacement measures 25571 bytes. Both are above 20480. The padding does not change those two sizes, because the replacement drops `expectedResult`.
- The AC-01 task omits `worktreeSubdir` and `humanReviewEvidence`. Its wrapper omits both and keeps `verificationCommand`. Adding `worktreeSubdir` `worktrees/task-a` and `humanReviewEvidence` `not_required` leaves `taskPlanHash` unchanged, puts both values on the wrapper, and makes the compact document 4668 bytes.
- `taskPlanHash` for that run is `5343b3289d190e79dc34ff5e6013d063a5d9c8edc5a5667c916e0995ad564f4d`, the `quality_records` content hash of kind `task-plan`. `approvedPlanPolicyHash` is a different value.
- The plan rubric audits the task graph, complexity counts, slice `AC-NN` ownership, verification commands, shadows, and removed paths. It does not audit obligation prose. Occupancy, test-file scope, and `evaluateAcCoverage` read the stored plan or the test files.
