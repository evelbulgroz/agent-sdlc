import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolvePreflightWorktree, shouldDeferGitMaterialization } from '../workflow/node-helpers.ts';
import { executePreflightForSnapshot } from '../workflow/preflight-gate.ts';
import { advanceAfterGreenPreflight } from '../workflow/nodes/review-qa.ts';
import { createDefaultAuthorizationEnvelope } from '../policy/authorization.ts';
import { canonicalJson, sha256 } from '../policy/contracts.ts';
import {
	createHighRiskReviewInterrupt,
	validatePendingResponse,
} from '../cli/hitl.ts';
import { reconcileTasks } from '../workflow/reconciliation.ts';
import { makeFixture } from '../testing/test-support.mjs';

test('@ac AC-06 manifest orchestration remains detached until graph preflight approves the reconciled tree', async () => {
	const fixture = makeFixture('atomic-orchestration', [
		{ status: 'PASS', summary: 'Atomic orchestration is valid', findings: [] },
	]);
	const baseCommitSha = 'a'.repeat(40);
	const reconciledTreeSha = 'b'.repeat(40);
	const gitCalls = [];
	try {
		const initial = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: [
				'# Intent',
				'',
				'## Goal',
				'Prove bounded task atomicity',
				'## Non goals',
				'- No remote operations',
				'## Owning context',
				'Agent SDLC tooling',
				'## Touched surfaces',
				'- tools/agent-sdlc',
				'## Invariants & constraints',
				'- Preflight precedes git materialization',
				'## Public contract impact',
				'None',
				'## Acceptance criteria',
				'1. AC-06: Atomic orchestration is preserved. Given reconciled task trees. Then canonical preflight runs before git materialization.',
				'## Failure defenses',
				'- Reject non-canonical preflight evidence',
				'## Verification plan',
				'- Run atomic-orchestration.spec.mjs',
				'## Unresolved questions',
				'_None_',
				'## Assumptions',
				'_None_',
			].join('\n\n'),
		});
		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '1'.repeat(64),
			taskManifestHash: '2'.repeat(64),
			baseCommitSha,
			isParallel: false,
			tasks: [
				{
					taskId: 'task-a',
					title: 'Enabling task',
					targetPackage: 'tools',
					pathPrefixes: ['tools/agent-sdlc'],
					dependsOn: [],
					status: 'completed',
					integrationOrder: 0,
					worktreeSubdir: 'worktrees/task-a',
					baseCommitSha,
					parentTreeSha: baseCommitSha,
					targetTreeSha: 'c'.repeat(40),
				},
				{
					taskId: 'task-b',
					title: 'Vertical task',
					targetPackage: 'tools',
					pathPrefixes: ['tools/agent-sdlc'],
					dependsOn: ['task-a'],
					status: 'completed',
					integrationOrder: 1,
					worktreeSubdir: 'worktrees/task-b',
					baseCommitSha,
					parentTreeSha: 'c'.repeat(40),
					targetTreeSha: 'd'.repeat(40),
				},
			],
			integrationOrder: ['task-a', 'task-b'],
			createdAt: new Date().toISOString(),
		};
		const gitCli = (command, args, options = {}) => {
			gitCalls.push({ command, args, cwd: options.cwd });
			if (args[0] === 'rev-parse') return `${baseCommitSha}\n`;
			if (args[0] === 'worktree' && args[1] === 'add') {
				fs.mkdirSync(args[3], { recursive: true });
				return '';
			}
			if (args[0] === 'diff-tree' && args[1] === '-p') {
				return 'diff --git a/tools/agent-sdlc/a.mjs b/tools/agent-sdlc/a.mjs\n+x';
			}
			if (args[0] === 'diff-tree' && args[1] === '--name-only') {
				return 'tools/agent-sdlc/a.mjs\n';
			}
			if (args[0] === 'write-tree') return `${reconciledTreeSha}\n`;
			return '';
		};

		const reconciled = await reconcileTasks({
			runId: fixture.runId,
			taskPlan,
			runtimeStore: fixture.store,
			gitCli,
			taskPlanFrozen: true,
			snapshot: { taskPlanFrozen: true },
		});
		assert.equal(shouldDeferGitMaterialization({ taskManifestHash: '2'.repeat(64) }), true);
		assert.equal(
			gitCalls.some(({ args }) =>
				['branch', 'commit', 'push'].includes(args[0]),
			),
			false,
		);
		assert.equal(
			resolvePreflightWorktree({
				worktreePath: '/task-worktree',
				integrationWorktreePath: reconciled.integrationWorktreePath,
			}),
			reconciled.integrationWorktreePath,
		);
		assert.equal(reconciled.reconciledTreeSha, reconciledTreeSha);
		const proofPath = path.join(
			reconciled.integrationWorktreePath,
			'tools/agent-sdlc/atomic-proof.spec.mjs',
		);
		fs.mkdirSync(path.dirname(proofPath), { recursive: true });
		fs.writeFileSync(
			proofPath,
			"test('@ac AC-06 atomic proof', () => { assert.equal(true, true); });\n",
		);

		const taskManifestHash = '2'.repeat(64);
		const authorization = createDefaultAuthorizationEnvelope({
			runId: fixture.runId,
			approvedSpecHash: initial.draftHash,
			taskManifestHash,
			baseCommitSha,
			allowedPackages: ['tools'],
			allowedPathPrefixes: ['tools/agent-sdlc'],
		});
		fixture.store.saveAuthorization(authorization);
		fixture.store.saveTaskPlan(taskPlan);
		const verifying = {
			...initial,
			state: 'VERIFYING_PREFLIGHT',
			runtimeRevision: initial.runtimeRevision + 1,
			approvedSpecHash: initial.draftHash,
			taskManifestHash,
			taskPlanHash: taskPlan.planPolicyHash,
			taskPlanFrozen: true,
			integrationWorktreePath: reconciled.integrationWorktreePath,
			worktreePath: reconciled.integrationWorktreePath,
			targetTreeSha: reconciledTreeSha,
			updatedAt: new Date().toISOString(),
		};
		fixture.store.database
			.prepare(
				`UPDATE runs SET
					runtime_revision = ?, state = ?, state_json = ?, state_hash = ?,
					semantic_repairs_count = ?, updated_at = ?
				WHERE run_id = ?`,
			)
			.run(
				verifying.runtimeRevision,
				verifying.state,
				canonicalJson(verifying),
				sha256(verifying),
				verifying.semanticRepairsCount ?? 0,
				verifying.updatedAt,
				fixture.runId,
			);
		const preflightCalls = [];
		fixture.runtime.execCli = (command, args, options) => {
			preflightCalls.push({ command, args, cwd: options.cwd });
			fs.mkdirSync(
				path.join(options.cwd, 'tools'),
				{ recursive: true },
			);
			fs.writeFileSync(
				path.join(options.cwd, 'tools/.agent-preflight-last.json'),
				JSON.stringify({
					status: 'OK',
					canonical: true,
					base: baseCommitSha,
					gitHeadSha: baseCommitSha,
					exitCode: 0,
				}),
			);
			return 'agent-preflight: RESULT status=OK canonical=true\n';
		};
		fixture.runtime.gitCli = (_command, args) => {
			if (args[0] === 'rev-parse') return `${baseCommitSha}\n`;
			if (args[0] === 'diff') return '';
			return '';
		};
		const reviewed = await executePreflightForSnapshot(fixture.runtime, verifying);
		assert.equal(
			reviewed.snapshot.state,
			'REVIEWING_QA',
			JSON.stringify(fixture.store.listEvents(fixture.runId).slice(-1)[0]),
		);
		const result = await advanceAfterGreenPreflight(
			fixture.runtime,
			reviewed.snapshot,
		);
		assert.equal(
			result.snapshot.state,
			'READY_FOR_GIT_APPROVAL',
			JSON.stringify(result.snapshot.lastError ?? result.snapshot),
		);
		assert.equal(preflightCalls.length, 1);
		assert.equal(preflightCalls[0].cwd, reconciled.integrationWorktreePath);
		assert.equal(
			gitCalls.some(({ args }) =>
				['branch', 'commit', 'push'].includes(args[0]),
			),
			false,
		);
	} finally {
		fixture.close();
	}
});

test('high-risk review must be explicitly approved before reconciliation continues', () => {
	const request = createHighRiskReviewInterrupt({
		runId: '2026-09-27-high-risk-review',
		runtimeRevision: 8,
		taskPlanHash: 'b'.repeat(64),
		tasks: [
			{
				taskId: 'auth-task',
				sliceId: 'auth-slice',
				targetTreeSha: 'a'.repeat(40),
				pathPrefixes: ['services/authentication'],
			},
		],
	});
	const interrupt = {
		interruptId: request.interruptId,
		stateHash: request.stateHash,
		kind: 'high_risk_review',
	};
	const response = {
		schemaVersion: '1.0.0',
		interruptId: request.interruptId,
		stateHash: request.stateHash,
		taskPlanHash: request.payload.taskPlanHash,
		action: 'approve',
	};
	assert.equal(
		validatePendingResponse({
			state: { taskPlanHash: request.payload.taskPlanHash },
			interrupt,
			request: request.payload,
			response,
		}).response.action,
		'approve',
	);
	assert.throws(
		() =>
			validatePendingResponse({
				state: { taskPlanHash: request.payload.taskPlanHash },
				interrupt,
				request: request.payload,
				response: { ...response, taskPlanHash: 'c'.repeat(64) },
			}),
		(error) => error.code === 'STALE_RESPONSE',
	);
	assert.throws(
		() =>
			validatePendingResponse({
				state: { taskPlanHash: request.payload.taskPlanHash },
				interrupt,
				request: request.payload,
				response: { ...response, action: 'escalate' },
			}),
		/approve or cancel/,
	);
});
