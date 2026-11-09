import assert from 'node:assert/strict';
import test from 'node:test';
import {
	AdapterRegistrationSchema,
	BudgetLedgerSchema,
	CaseResultSchema,
	CandidateBindingSchema,
	ClosureRecordSchema,
	EvidenceReceiptSchema,
	EvidenceObligationSchema,
	EvidenceRequestSchema,
	EvidenceReportSchema,
	InvocationRecordSchema,
	QualityAnswerSchema,
	QualityPolicySchema,
	RetrievalRequestSchema,
	RetrievalResponseSchema,
	TaskRevisionSchema,
	adapterBindingHash,
	qualityPolicyHash,
	validateEvidenceReportForRequest,
	validateQualityPlan,
} from './quality-schema.ts';
import {
	assertTaskPlanHash,
	hashTaskPlanProjection,
	projectTaskPlan,
	TaskPlanV2Schema,
	validateTaskPlan,
} from './dag-schema.ts';
import { sha256 } from './primitives.ts';
import { commandRegistrationFixture } from '../../testing/command-registration-fixture.mjs';

const hash = (letter = 'a') => letter.repeat(64);
const tree = (letter = 'b') => letter.repeat(40);

function qualityPolicy(overrides = {}) {
	return {
		schemaVersion: '1.0.0',
		policyId: 'checkpoint-evidence-v1',
		additionalCandidateReviews: 0,
		followUpDispatches: 0,
		testRetryPolicy: 'clean-success',
		retrieval: {
			maxPacketBytes: 24_576,
			maxPacketLines: 1_000,
			maxTotalBytesPerCandidate: 49_152,
			maxTotalLinesPerCandidate: 2_000,
		},
		execution: { maxInvocations: 2, maxTotalDurationMs: 10_000 },
		review: { maxLogicalDispatches: 2, maxPhysicalCalls: 2, maxInputTokens: 1_000, maxOutputTokens: 1_000 },
		...overrides,
	};
}

function registration(overrides = {}) {
	return commandRegistrationFixture({ adapterId: 'unit-adapter', limits: { timeoutMs: 5_000, maxReportBytes: 20_000, maxArtifactBytes: 10_000, maxArtifacts: 4 }, ...overrides });
}

function obligation(bindingHash, overrides = {}) {
	return {
		obligationId: 'obligation-one',
		criterionId: 'AC-01',
		caseId: 'AC-01.1',
		owner: { kind: 'task', id: 'task-one' },
		observableOutcome: 'The result is visible.',
		setupAction: 'Open the screen and perform the action.',
		expectedResult: 'The expected result is displayed.',
		layer: 'unit',
		requiredCapabilities: [],
		implementationPaths: ['src/main.ts'],
		testCases: [{ file: 'src/main.spec.ts', caseKey: 'case-one' }],
		adapterBindingHash: bindingHash,
		profileId: 'unit',
		...overrides,
	};
}

function planFixture() {
	const policy = qualityPolicy();
	const adapter = registration();
	const binding = adapterBindingHash(adapter);
	return {
		schemaVersion: '2.0.0',
		runId: '2026-11-01-quality-fixture',
		planPolicyHash: hash('d'),
		baseCommitSha: tree(),
		slices: [{
			sliceId: 'slice-one',
			kind: 'vertical',
			goal: 'Implement the result flow.',
			acceptanceCriteria: ['AC-01'],
			dependsOn: [],
		}],
		tasks: [{
			taskId: 'task-one',
			title: 'Implement result flow',
			targetPackage: 'packages/example',
			pathPrefixes: ['src'],
			dependsOn: [],
			integrationOrder: 0,
			sliceId: 'slice-one',
			authoredPaths: ['src/main.ts', 'src/main.spec.ts'],
			generatedOutputs: [],
			deliveryLayers: ['application'],
			dependencyMutations: [],
			shadowPaths: { unhappy: 'error', timeout: 'timeout', empty: 'empty', boundary: 'edge' },
			verificationCommand: ['pnpm', 'run', 'test:unit'],
			generatorCommand: null,
			acceptanceCriteria: ['AC-01'],
		}],
		integrationOrder: ['task-one'],
		isParallel: false,
		createdAt: '2026-11-01T22:00:00.000Z',
		qualityPolicy: policy,
		qualityPolicyHash: qualityPolicyHashFor(policy),
		adapterBindings: [adapter],
		evidenceObligations: [obligation(binding)],
	};
}

function qualityPolicyHashFor(policy) {
	return sha256(policy);
}

test('closed schemas parse valid policies, registrations, obligations, plans and records', () => {
	const plan = planFixture();
	assert.equal(QualityPolicySchema.parse(plan.qualityPolicy).policyId, 'checkpoint-evidence-v1');
	assert.equal(AdapterRegistrationSchema.parse(plan.adapterBindings[0]).adapterId, 'unit-adapter');
	assert.equal(EvidenceObligationSchema.parse(plan.evidenceObligations[0]).caseId, 'AC-01.1');
	assert.equal(TaskPlanV2Schema.parse(plan).schemaVersion, '2.0.0');
	assert.equal(validateQualityPlan(plan, { criterionCases: { 'AC-01': ['AC-01.1'] } }).qualityPolicyHash, plan.qualityPolicyHash);
	const runtimePlan = validateTaskPlan(plan);
	assert.equal(runtimePlan.tasks[0].status, 'pending');
	assert.deepEqual(projectTaskPlan(runtimePlan), TaskPlanV2Schema.parse(plan));
	assert.equal(assertTaskPlanHash(runtimePlan, hashTaskPlanProjection(plan)), hashTaskPlanProjection(plan));
	assert.throws(() => assertTaskPlanHash(runtimePlan, hash('f')), /TaskPlan hash/);
	assert.equal(BudgetLedgerSchema.parse({
		schemaVersion: '1.0.0', runId: plan.runId, qualityPolicyHash: plan.qualityPolicyHash, revision: 0,
		counters: { executionInvocations: 0, executionDurationMs: 0, logicalDispatches: 0, physicalCalls: 0, inputTokens: 0, outputTokens: 0 },
		reservations: [],
	}).revision, 0);
	assert.equal(TaskRevisionSchema.parse({
		schemaVersion: '1.0.0', runId: plan.runId, taskPlanHash: hash(), taskId: 'task-one',
		executionRevision: 0, correctionId: null, parentTreeSha: tree(), targetTreeSha: null,
		patchHash: null, parentRevisionSetHash: hash('e'), status: 'executing', receiptHashes: [],
	}).status, 'executing');
});

test('policy and plan validation rejects missing, unknown, mismatched and under-budget data', () => {
	const plan = planFixture();
	assert.equal(QualityPolicySchema.safeParse(null).success, false);
	assert.equal(QualityPolicySchema.safeParse({}).success, false);
	assert.equal(QualityPolicySchema.safeParse({ ...plan.qualityPolicy, extra: true }).success, false);
	assert.equal(QualityPolicySchema.safeParse(qualityPolicy({ additionalCandidateReviews: 3 })).success, false);
	assert.equal(QualityPolicySchema.safeParse(qualityPolicy({ followUpDispatches: -1 })).success, false);
	assert.throws(() => TaskPlanV2Schema.parse({ ...plan, qualityPolicyHash: hash('f') }));
	assert.throws(() => TaskPlanV2Schema.parse({ ...plan, review: undefined, unknown: true }));
	assert.throws(() => validateQualityPlan({ ...plan, evidenceObligations: [] }));
	assert.throws(() => validateQualityPlan({ ...plan, evidenceObligations: [obligation(hash('f'))] }));
	assert.throws(() => validateQualityPlan({ ...plan, qualityPolicy: qualityPolicy({
		review: { ...plan.qualityPolicy.review, maxLogicalDispatches: 1 },
	}) }));
	assert.throws(() => validateQualityPlan(plan, { criterionCases: { 'AC-01': ['AC-01.1', 'AC-01.2'] } }));
});

test('adapter and obligation boundaries reject unsupported capabilities, empty payloads and escaping paths', () => {
	const adapter = registration();
	assert.equal(AdapterRegistrationSchema.safeParse({ ...adapter, argv: [] }).success, false);
	assert.equal(AdapterRegistrationSchema.safeParse({ ...adapter, argv: [], executable: { ...adapter.executable, path: 'relative' } }).success, false);
	const { kind, executable, pins, commandSha256, ...legacy } = adapter;
	assert.equal(AdapterRegistrationSchema.safeParse({
		...legacy, bundleFiles: [{ path: 'tools/adapter.mjs', sha256: hash() }], dependencyFiles: [], configurationFiles: [],
		qualificationArtifactHash: hash('c'),
	}).success, false);
	assert.equal(AdapterRegistrationSchema.safeParse({ ...adapter, surprise: true }).success, false);
	assert.equal(AdapterRegistrationSchema.safeParse({
		...adapter,
		profiles: [{ profileId: 'browser', layers: ['browser'], capabilities: ['native-file-picker'] }],
	}).success, false);
	assert.equal(EvidenceObligationSchema.safeParse(obligation(hash(), { implementationPaths: ['../outside'] })).success, false);
	assert.equal(EvidenceObligationSchema.safeParse(obligation(hash(), { layer: 'static' })).success, false);
	assert.equal(EvidenceObligationSchema.safeParse(obligation(hash(), { testCases: [] })).success, false);
});

test('case reports preserve explicit failure and reject retries normalized to a pass', () => {
	const passed = {
		file: 'src/main.spec.ts', caseKey: 'case-one', obligationIds: ['obligation-one'],
		exercisedCapabilities: [], outcome: 'passed',
		attempts: [{ index: 0, outcome: 'passed', durationMs: 1, artifactPaths: [] }],
	};
	assert.equal(CaseResultSchema.parse(passed).outcome, 'passed');
	assert.equal(CaseResultSchema.safeParse({ ...passed, attempts: [] }).success, false);
	assert.equal(CaseResultSchema.safeParse({
		...passed,
		attempts: [
			{ index: 0, outcome: 'failed', durationMs: 1, artifactPaths: [] },
			{ index: 1, outcome: 'passed', durationMs: 1, artifactPaths: [] },
		],
	}).success, false);
	assert.equal(CaseResultSchema.safeParse({ ...passed, outcome: 'failed', attempts: [] }).success, false);
	assert.equal(CaseResultSchema.safeParse({
		...passed,
		outcome: 'failed',
		attempts: [{ index: 0, outcome: 'failed', durationMs: 1, artifactPaths: [] }],
	}).success, true);
});

test('request-bound report validation rejects wrong identity but retains failed outcomes', () => {
	const plan = planFixture();
	const request = {
		schemaVersion: '1.0.0',
		operationId: 'operation-one',
		binding: {
			runId: plan.runId,
			approvedSpecHash: hash(),
			taskPlanHash: hash('d'),
			qualityPolicyHash: plan.qualityPolicyHash,
			checkpointId: 'checkpoint-one',
			checkpointKind: 'slice',
			ownerId: 'slice-one',
			candidateRevision: 0,
			baseCommitSha: tree(),
			treeSha: tree('c'),
			revisionSetHash: hash('e'),
			preparationHash: hash('f'),
		},
		adapterBindingHash: plan.evidenceObligations[0].adapterBindingHash,
		profileId: 'unit',
		obligations: plan.evidenceObligations,
		artifactDirectory: '/run/artifacts/operation-one',
	};
	const report = {
		schemaVersion: '1.0.0',
		operationId: request.operationId,
		requestHash: sha256(request),
		adapterBindingHash: request.adapterBindingHash,
		profileId: request.profileId,
		cases: [{
			file: 'src/main.spec.ts', caseKey: 'case-one', obligationIds: ['obligation-one'],
			exercisedCapabilities: [], outcome: 'failed',
			attempts: [{ index: 0, outcome: 'failed', durationMs: 2, artifactPaths: [] }],
		}],
		artifacts: [],
	};
	const invocation = {
		exitCode: 0, operationId: request.operationId, requestHash: report.requestHash,
		adapterBindingHash: request.adapterBindingHash,
	};
	assert.equal(validateEvidenceReportForRequest(report, request, invocation).cases[0].outcome, 'failed');
	assert.throws(() => validateEvidenceReportForRequest({
		...report, cases: [{ ...report.cases[0], file: 'src/foreign.spec.ts' }],
	}, request, invocation), /case set|foreign case/);
	assert.equal(EvidenceReportSchema.safeParse({ ...report, unknown: true }).success, false);
	assert.throws(() => validateEvidenceReportForRequest(report, request, { ...invocation, exitCode: 1 }));
	assert.equal(EvidenceRequestSchema.safeParse({ ...request, artifactDirectory: 'relative/path' }).success, false);
	assert.equal(CandidateBindingSchema.parse(request.binding).checkpointKind, 'slice');
	assert.equal(InvocationRecordSchema.parse({
		schemaVersion: '1.0.0', operationId: request.operationId, requestHash: report.requestHash,
		bindingHash: hash('e'), adapterBindingHash: request.adapterBindingHash,
		observedArgv: ['node', 'tools/adapter.mjs'], worktreeRegistryId: 'worktree-one',
		startedAt: '2026-11-01T22:00:00.000Z', finishedAt: '2026-11-01T22:00:01.000Z',
		exitCode: 0, reportHash: hash('c'), artifactManifestHash: hash('d'), status: 'completed',
		retryOf: null, failureReason: null,
	}).status, 'completed');
	assert.equal(EvidenceReceiptSchema.parse({
		schemaVersion: '1.0.0', operationId: request.operationId, requestHash: report.requestHash,
		bindingHash: hash('e'), adapterBindingHash: request.adapterBindingHash,
		invocationRecordHash: hash('c'), reportHash: hash('d'), artifactManifestHash: hash('f'),
		dischargedObligationIds: ['obligation-one'], status: 'passed',
	}).status, 'passed');
	assert.equal(ClosureRecordSchema.parse({
		schemaVersion: '1.0.0',
		binding: { ...request.binding, checkpointKind: 'final', ownerId: null },
		selectedRevisions: [{ taskId: 'task-one', executionRevision: 0, patchHash: hash('d') }],
		registryId: 'final-worktree', status: 'accepted', receiptHashes: [hash('c')],
		reviewOperationIds: ['review-one'],
	}).status, 'accepted');
	assert.equal(RetrievalResponseSchema.parse({
		schemaVersion: '1.0.0', requestHash: hash(), fileHash: hash('b'),
		ranges: [{ start: 1, end: 2, text: 'expected assertion' }],
		omittedRanges: [], unresolvedHelpers: [], outcome: 'complete',
	}).outcome, 'complete');
});

test('answer and retrieval contracts reject null, empty and malformed boundaries', () => {
	assert.equal(QualityAnswerSchema.safeParse(null).success, false);
	assert.equal(QualityAnswerSchema.safeParse({
		schemaVersion: '1.0.0', answerId: 'answer-one', interruptId: 'interrupt-one',
		bindingHash: hash(), findingIds: ['finding-one'], action: 'refute',
		rationale: 'The preserved assertion addresses the finding.', evidenceHashes: [], correction: null,
	}).success, false);
	assert.equal(QualityAnswerSchema.safeParse({
		schemaVersion: '1.0.0', answerId: 'answer-two', interruptId: 'interrupt-one',
		bindingHash: hash(), findingIds: ['finding-one'], action: 'approve-correction',
		rationale: 'The operator approved scoped correction.', evidenceHashes: [],
		correction: {
			owners: [{ taskId: 'task-one', expectedRevision: 0, editPaths: ['src/main.ts'] }],
			rerunObligationIds: ['obligation-one'], maxSourceEditIterations: 2,
			expectedBudgetLedgerHash: hash('c'),
		},
	}).success, true);
	assert.equal(RetrievalRequestSchema.safeParse({
		schemaVersion: '1.0.0', operationId: 'op-one', reviewOperationId: 'review-one',
		bindingHash: hash(), obligationId: 'obligation-one', file: 'src/test.ts',
		selector: { kind: 'lines', start: 5, end: 4 },
	}).success, false);
});
