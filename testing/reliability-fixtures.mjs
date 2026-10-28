// Shared builders for the reliability specs.
import { RELIABILITY_SCHEMA_VERSION, sha256 } from '../policy/contracts.ts';

export const HASH = 'a'.repeat(64);
export const SHA = 'b'.repeat(40);

export function mutationAttempt(taskId, index, status = 'accepted') {
	return {
		schemaVersion: RELIABILITY_SCHEMA_VERSION,
		attemptId: `${taskId}-mutation-${index}`,
		runId: '2026-09-29-reliability-test',
		taskId,
		roleId: 'implementer',
		stepIndex: index,
		toolName: 'replace_in_file',
		path: 'tools/example.mjs',
		status,
		rejectionCategory:
			status === 'accepted' ? null : 'STALE_LITERAL_REPLACEMENT',
		routeId: 'route-a',
		modelId: 'model-a',
		occurredAt: `2026-09-29T00:00:0${index}.000Z`,
	};
}

export function verificationAttempt(
	taskId,
	attempt,
	status,
	phase = 'post-implementation',
) {
	return {
		schemaVersion: RELIABILITY_SCHEMA_VERSION,
		attemptId: `${taskId}-verification-${attempt}`,
		runId: '2026-09-29-reliability-test',
		taskId,
		command: ['pnpm', 'run', 'agent:test-sdlc'],
		attempt,
		phase,
		status,
		exitCode: status === 'passed' ? 0 : 1,
		occurredAt: `2026-09-29T00:01:0${attempt}.000Z`,
	};
}

export function taskSummary(overrides = {}) {
	return {
		taskId: 'task-a',
		status: 'completed',
		dispatched: true,
		inconclusive: false,
		targetPackage: 'tools',
		complexityBand: 'medium',
		deliveryLayers: ['tooling'],
		highRisk: false,
		mutationAttempts: [mutationAttempt('task-a', 1)],
		verificationAttempts: [verificationAttempt('task-a', 1, 'passed')],
		repairInvoked: false,
		routeSequence: ['route-a'],
		modelSequence: ['model-a'],
		failover: false,
		latencyMs: 100,
		inputTokens: 10,
		outputTokens: 5,
		costMicrousd: 50,
		...overrides,
	};
}

export function runSummary(runId, tasks, failures = []) {
	const summary = {
		schemaVersion: RELIABILITY_SCHEMA_VERSION,
		runId,
		evidenceHash: null,
		runStatus: 'READY_FOR_GIT_APPROVAL',
		tasks,
		failures,
		routeOperations: [],
	};
	summary.evidenceHash = sha256(summary);
	return summary;
}

export function eligibleReadiness() {
	return {
		slices: [
			{
				sliceId: 'canary',
				kind: 'vertical',
				goal: 'Exercise one bounded change',
				acceptanceCriteria: ['AC-01', 'AC-02'],
				dependsOn: [],
			},
		],
		tasks: [
			{
				taskId: 'canary-task',
				targetPackage: 'tools',
				authoredPaths: ['tools/example.mjs', 'tools/example.spec.mjs'],
				pathPrefixes: ['tools/example.mjs', 'tools/example.spec.mjs'],
				generatedOutputs: [],
				dependencyMutations: [],
				deliveryLayers: ['tooling'],
				complexityScore: 8,
				contractProducer: false,
				highRisk: false,
			},
		],
	};
}

export function canaryEvidence(overrides = {}) {
	return {
		state: {
			runId: '2026-09-29-canary',
			state: 'READY_FOR_GIT_APPROVAL',
			workflowHash: HASH,
			semanticRepairsCount: 0,
			lastError: null,
		},
		tasks: [
			{ ...eligibleReadiness().tasks[0], status: 'completed', repairCount: 0 },
		],
		mutationAttempts: [mutationAttempt('canary-task', 1)],
		verificationAttempts: [verificationAttempt('canary-task', 1, 'passed')],
		reconciliation: { status: 'RECONCILIATION_COMPLETED' },
		preflight: { status: 'OK', canonical: true },
		implementerOperations: [{ synthetic: false }],
		qaDivergences: [],
		authorization: { baseCommitSha: SHA },
		plan: { planPolicyHash: HASH, taskManifestHash: HASH },
		...overrides,
	};
}

export const bindings = {
	repositoryId: 'agent-sdlc',
	workflowHash: HASH,
	boundedPlanningHash: HASH,
	implementerRoleHash: HASH,
	modelPolicyHash: HASH,
};

export function routeStratum(routeId, terminalAttempts, completions, firstPasses) {
	return {
		complexityBand: 'medium',
		targetPackage: 'tools',
		deliveryLayers: ['tooling'],
		highRisk: false,
		routeId,
		modelId: 'same-model',
		failover: false,
		terminalAttempts,
		completion: {
			numerator: completions,
			denominator: terminalAttempts,
			exclusions: 0,
			rate: `${((completions / terminalAttempts) * 100).toFixed(2)}%`,
		},
		validEdit: { numerator: 5, denominator: 5, exclusions: 0, rate: '100.00%' },
		firstPassVerification: {
			numerator: firstPasses,
			denominator: terminalAttempts,
			exclusions: 0,
			rate: `${((firstPasses / terminalAttempts) * 100).toFixed(2)}%`,
		},
		repairSuccess: {
			numerator: 0,
			denominator: 0,
			exclusions: 5,
			rate: 'not-applicable',
		},
		latencyMs: { count: 5, total: 500, mean: 100 },
		inputTokens: { count: 5, total: 50, mean: 10 },
		outputTokens: { count: 5, total: 25, mean: 5 },
		costMicrousd: { count: 5, total: 250, mean: 50 },
	};
}
