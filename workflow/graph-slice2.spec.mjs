import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';

import {
	citingSpecWriteAction,
	completeProposal,
	leanWriteAction,
} from '../testing/test-support.mjs';
import { conditioningProposal, makeGraphFixture, reachSpecApproved } from '../testing/graph-fixtures.mjs';

test('Slice 2 graph end-to-end execution completes through READY_FOR_GIT_APPROVAL', async () => {
	const script = [
		conditioningProposal(), // for spec drafting
		leanWriteAction(
			'apps/services/conditioning/src/feature.ts',
			'export const feature = true;\n',
		),
		citingSpecWriteAction(),
		{ action: { kind: 'complete', summary: 'Done' } },
		{ action: { kind: 'complete', summary: 'Audit confirmed' } },
		// Reviewer model step:
		{
			status: 'PASS',
			summary: 'Implementation looks solid and complies with bounded-context guardrails',
			findings: [],
		},
	];

	const fixture = makeGraphFixture('slice2-e2e', script, { profile: 'slice2' });
	try {
		const approved = await reachSpecApproved(fixture);

		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning'],
			maxSemanticRepairs: 2,
		});

		const terminal = await fixture.runtime.authorize(approved, envelope);
		assert.equal(
			terminal.state,
			'READY_FOR_GIT_APPROVAL',
			JSON.stringify({
				lastError: terminal.lastError,
				failurePacket: terminal.lastError?.metadata?.failurePacketArtifact
					? fixture.artifacts.readJson(
							terminal.lastError.metadata.failurePacketArtifact,
						)
					: null,
			}),
		);
		assert.ok(terminal.worktreePath);
		assert.ok(terminal.targetTreeSha);
		assert.ok(terminal.preflightBindingArtifact);

		// Verify 5-point binding artifact
		const binding = fixture.artifacts.readJson(terminal.preflightBindingArtifact);
		assert.equal(binding.baseCommitSha, fixture.baseCommitSha);
		assert.equal(binding.targetTreeSha, terminal.targetTreeSha);
		assert.equal(binding.status, 'OK');
		assert.equal(binding.canonical, true);
		assert.ok(binding.preflightResultHash);
		assert.ok(binding.command);

		// Verify event progression
		const events = fixture.store.listEvents(fixture.runId);
		const eventTypes = events.map((e) => e.eventType);
		assert.ok(eventTypes.includes('RUN_AUTHORIZED'));
		assert.ok(eventTypes.includes('PLAN_FROZEN'));
		assert.ok(eventTypes.includes('WORKTREE_PREPARED'));
		assert.ok(eventTypes.includes('WORKTREE_HYDRATED'));
		assert.ok(eventTypes.includes('IMPLEMENTATION_COMPLETED'));
		assert.ok(eventTypes.includes('GENERATION_MATERIALIZED'));
		assert.ok(eventTypes.includes('REVIEW_EVALUATED'));
		assert.ok(eventTypes.includes('RUN_READY_FOR_GIT_APPROVAL'));

		assert.equal(terminal.taskPlanFrozen, true);
		assert.equal(terminal.approvedPlanPolicyHash, envelope.approvedPlanPolicyHash);
		const planReviews = fixture.store
			.listCriticReviews(fixture.runId)
			.filter((review) => review.phase === 'plan');
		assert.equal(planReviews.length, 1);
		assert.equal(planReviews[0].artifactHash, terminal.taskPlanHash);
		assert.equal(planReviews[0].attemptKey, `plan:${envelope.approvedPlanPolicyHash}`);

		const readyEvent = events.find((e) => e.eventType === 'RUN_READY_FOR_GIT_APPROVAL');
		assert.ok(readyEvent.payload.patchSummary !== undefined);
		assert.ok(readyEvent.payload.verificationEvidenceHash);

		// Verify generation 0 was persisted
		const gen0 = fixture.store.getGeneration(fixture.runId, 0);
		assert.ok(gen0);
		assert.equal(gen0.generation, 0);
		assert.equal(gen0.targetTreeSha, terminal.targetTreeSha);

		const featurePath = path.join(
			terminal.worktreePath,
			'apps/services/conditioning/src/feature.ts',
		);
		assert.equal(fs.readFileSync(featurePath, 'utf8'), 'export const feature = true;\n');
	} finally {
		fixture.close();
	}
});

test('@ac AC-02 reviewer P1 findings remain evidence-assessed advisories without repair authority', async () => {
	const script = [
		conditioningProposal(), // for spec drafting
		leanWriteAction(
			'apps/services/conditioning/src/feature.ts',
			'export const bad = true;\n',
		),
		citingSpecWriteAction(),
		{ action: { kind: 'complete', summary: 'Done' } },
		{ action: { kind: 'complete', summary: 'Audit confirmed' } },
		// Generation 0 Reviewer reports the two unsupported rerun-8 failure shapes.
		{
			status: 'PASS',
			summary: 'Potential state and coverage defects',
			findings: [
				{
					findingId: 'f-1',
					severity: 'P1',
					category: 'correctness',
					path: 'apps/services/conditioning/src/feature.ts',
					lineRange: [1, 1],
					evidence: 'export const bad = true;',
					failureMechanism: 'The state might be accessing an incorrect variable.',
					remediation: 'Revise state management.',
				},
				{
					findingId: 'f-2',
					severity: 'P1',
					category: 'test-coverage',
					path: 'apps/services/conditioning/src/feature.spec.ts',
					lineRange: [1, 1],
					evidence: 'expect(feature).toBe(true)',
					failureMechanism: 'The enabled state has no assertion.',
					remediation: 'Add an enabled-state assertion.',
				},
			],
		},
	];

	const fixture = makeGraphFixture('slice2-repair-pass', script, { profile: 'slice2' });
	try {
		const approved = await reachSpecApproved(fixture);

		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['apps/services/conditioning'],
			allowedPathPrefixes: ['apps/services/conditioning'],
			maxSemanticRepairs: 2,
		});

		const terminal = await fixture.runtime.authorize(approved, envelope);
		const reviewEvent = fixture.store
			.listEvents(fixture.runId)
			.find(
				(event) =>
					event.eventType === 'REVIEW_EVALUATED' &&
					event.payload?.status === 'ADVISORY',
			);
		assert.ok(reviewEvent);
		assert.equal(reviewEvent.payload.repairAuthorized, false);
		assert.equal(reviewEvent.payload.semanticAdvisories.length, 2);
		assert.equal(
			reviewEvent.payload.semanticAdvisories[0].assessment.reason,
			'CITATION_MATCHED',
		);
		assert.equal(
			reviewEvent.payload.semanticAdvisories[0].assessment.deterministicallyCorroborated,
			false,
		);
		assert.equal(
			reviewEvent.payload.semanticAdvisories[1].assessment.reason,
			'EVIDENCE_NOT_IN_CITED_RANGE',
		);

		assert.equal(terminal.state, 'READY_FOR_GIT_APPROVAL');
		assert.equal(terminal.activeGeneration, 0);
		assert.equal(fixture.store.getSemanticRepairsCount(fixture.runId), 0);

		const events = fixture.store.listEvents(fixture.runId);
		const readyEvent = events.find(
			(event) => event.eventType === 'RUN_READY_FOR_GIT_APPROVAL',
		);
		assert.equal(readyEvent.payload.semanticReviewAdvisories.length, 2);
		const eventTypes = events.map((e) => e.eventType);
		assert.equal(eventTypes.includes('REPAIR_STARTED'), false);
		assert.equal(eventTypes.includes('REPAIR_COMPLETED'), false);
		assert.ok(eventTypes.includes('RUN_READY_FOR_GIT_APPROVAL'));

		const gen0 = fixture.store.getGeneration(fixture.runId, 0);
		assert.ok(gen0);
		assert.equal(fixture.store.getGeneration(fixture.runId, 1), null);
	} finally {
		fixture.close();
	}
});

test('Slice 2 graph interrupts for high-risk review without repair retries', async () => {
	let preflightCounter = 0;
	const customExecCli = (cmd, args = [], opts = {}) => {
		if (cmd === 'pnpm' && args.includes('agent:preflight')) {
			preflightCounter++;
			// Fail preflight indicating failure in packages/ddd-base (high-risk)
			const error = new Error('Preflight failed');
			error.status = 1;
			error.stdout = 'FAIL packages/ddd-base/src/entity.ts: invariant violation\n';
			error.stderr = '';
			throw error;
		}
		return 'OK\n';
	};

	let implementerStep = 0;
	const roleHandler = (request) => {
		const respond = (output) =>
			Object.freeze({
				schemaVersion: '1.0.0',
				synthetic: true,
				output,
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: Object.freeze([]),
			});
		const role = request.attribution?.roleId ?? request.role;
		if (role === 'implementer' || role === 'repairer') {
			implementerStep++;
			if (implementerStep === 1) {
				return respond(
					leanWriteAction(
						'packages/ddd-base/src/feature.ts',
						'export const feature = true;\n',
					),
				);
			}
			if (implementerStep === 2) {
				return respond(citingSpecWriteAction('packages/ddd-base/src/feature.spec.ts'));
			}
			if (implementerStep === 3) {
				return respond({
					action: {
						kind: 'tool_call',
						toolName: 'run_allowlisted_command',
						parameters: {
							command: 'pnpm',
							args: ['--filter', '@example/ddd-base', 'test'],
						},
					},
				});
			}
			return respond({
				action: { kind: 'complete', summary: 'Implemented conditioning feature' },
			});
		}
		return respond({ status: 'PASS', summary: 'Review passes', findings: [] });
	};
	const script = [
		completeProposal({
			owningContext: 'Conditioning',
			touchedSurfaces: [
				'packages/ddd-base/src/feature.ts',
				'packages/ddd-base/src/feature.spec.ts',
			],
		}),
		...Array(20).fill(roleHandler),
	];

	const fixture = makeGraphFixture('slice2-highrisk-escalate',  script, { profile: 'slice2', 
		execCli: customExecCli,
	});

	try {
		const approved = await reachSpecApproved(fixture);

		const envelope = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: approved.approvedSpecHash,
			baseCommitSha: fixture.baseCommitSha,
			allowedPackages: ['packages/ddd-base'],
			allowedPathPrefixes: ['packages/ddd-base'],
			maxSemanticRepairs: 2,
		});

		const terminal = await fixture.runtime.authorize(approved, envelope);

		assert.equal(
			terminal.state,
			'RECONCILING_INTEGRATION',
			JSON.stringify(terminal.lastError ?? terminal),
		);
		assert.equal(
			fixture.store.getPendingInterrupt(fixture.runId)?.kind,
			'high_risk_review',
		);
		assert.equal(fixture.store.getSemanticRepairsCount(fixture.runId), 0);

		// High-risk review interrupts before canonical preflight.
		assert.equal(preflightCounter, 0);
	} finally {
		fixture.close();
	}
});

