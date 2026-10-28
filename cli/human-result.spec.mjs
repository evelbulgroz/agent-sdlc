import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { humanResult } from './human-result.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { projectHostInvocation } from './host-invocation.ts';

test('humanResult alerts about deferred critic failures only in successful completion output', () => {
	const criticFailures = [
		{
			phase: 'qa',
			code: 'GOVERNOR_ROUTES_EXHAUSTED',
			message: 'Critic unavailable after all configured provider routes failed',
		},
	];
	const completed = humanResult('resume', {
		runId: '2026-09-27-critic-alert',
		state: 'READY_FOR_GIT_APPROVAL',
		runtimeRevision: 12,
		criticFailures,
	});
	assert.match(completed, /Critic Alerts:/);
	assert.match(
		completed,
		/qa: Critic unavailable after all configured provider routes failed \(GOVERNOR_ROUTES_EXHAUSTED\)/,
	);

	const inProgress = humanResult('status', {
		runId: '2026-09-27-critic-alert',
		state: 'IMPLEMENTING',
		runtimeRevision: 5,
		criticFailures,
	});
	assert.doesNotMatch(inProgress, /Critic Alerts:/);
});

test('@ac AC-02 @case AC-02.2 AC-12: humanResult appends Recurrence Alert Banner only for eligible terminal commands when recommended keys exist', () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`recurrence-alert-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(path.join(tempRoot, '.agents/trace-findings'), { recursive: true });
	try {
		for (let i = 1; i <= 3; i++) {
			const runId = `2026-09-0${i}-recurrence-run-${i}`;
			fs.writeFileSync(
				path.join(tempRoot, `.agents/trace-findings/${runId}.json`),
				JSON.stringify({
					schemaVersion: '1.0.0',
					runId,
					analyzedAt: new Date().toISOString(),
					findings: [
						{
							findingId: `find-${i}`,
							roleId: 'implementer',
							signalType: 'tool_failure',
							category: 'test-runner-lookup',
							findingKey: '[implementer] tool_failure:test-runner-lookup',
							status: 'PROVISIONAL',
							attributionLayer: 'layer3',
							evidence: {},
						},
					],
				}),
			);
		}

		// 1. Eligible command 'start' concluding in READY_FOR_GIT_APPROVAL
		const startHuman = humanResult(
			'start',
			{
				runId: '2026-09-04-test-run',
				state: 'READY_FOR_GIT_APPROVAL',
				runtimeRevision: 1,
				frictionAdvisory: "💡 Trace friction detected (repairs: 1). Run 'agent-sdlc skills --run 2026-09-04-test-run' to analyze.",
			},
			tempRoot,
		);
		assert.match(startHuman, /💡 Trace friction detected \(repairs: 1\)/);
		assert.match(startHuman, /⚡ SDLC Skill Learning Alert: 1 recurring issue observed across ≥3 runs has reached the recommended threshold/);
		assert.match(startHuman, /agent-sdlc-trends --skills/);
		assert.match(startHuman, /agent-sdlc skills --apply --key "\[implementer\] tool_failure:test-runner-lookup"/);
		assert.equal(startHuman.includes('pnpm run agent:'), false);

		// 2. Eligible command 'authorize' concluding in DONE
		const doneHuman = humanResult(
			'authorize',
			{
				runId: '2026-09-04-test-run',
				state: 'DONE',
				runtimeRevision: 2,
			},
			tempRoot,
		);
		assert.match(doneHuman, /⚡ SDLC Skill Learning Alert: 1 recurring issue observed across ≥3 runs/);
		assert.match(doneHuman, /agent-sdlc skills --apply --key "\[implementer\] tool_failure:test-runner-lookup"/);
		assert.equal(doneHuman.includes('pnpm run agent:'), false);

		// 3. Ineligible command 'status' concluding in READY_FOR_GIT_APPROVAL (must NOT show banner)
		const statusHuman = humanResult(
			'status',
			{
				runId: '2026-09-04-test-run',
				state: 'READY_FOR_GIT_APPROVAL',
				runtimeRevision: 1,
			},
			tempRoot,
		);
		assert.doesNotMatch(statusHuman, /⚡ SDLC Skill Learning Alert/);

		// 4. Ineligible command 'skills' (must NOT show banner)
		const skillsHuman = humanResult(
			'skills',
			{
				runId: '2026-09-04-test-run',
				state: 'READY_FOR_GIT_APPROVAL',
				runtimeRevision: 1,
			},
			tempRoot,
		);
		assert.doesNotMatch(skillsHuman, /⚡ SDLC Skill Learning Alert/);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('@ac AC-02 @ac AC-03 @ac AC-07 @ac AC-08 @ac AC-15 human printer renders the hostInvocation argv', () => {
	const runId = '2026-09-27-printer-card';
	const stateHash = 'a'.repeat(64);
	const approvalHash = 'b'.repeat(64);
	const draftHash = 'c'.repeat(64);
	const approvalCard = projectHostInvocation(
		{ runId, state: 'WAITING_FOR_APPROVAL', pendingInterruptId: 'approval-1' },
		{
			pendingInterrupt: {
				interruptId: 'approval-1',
				kind: 'approval',
				stateHash,
				request: { draftHash, approval: { approvalHash }, stateHash },
			},
		},
	);
	const approvalText = humanResult('status', {
		runId,
		state: 'WAITING_FOR_APPROVAL',
		pendingInterrupt: {
			interruptId: 'approval-1',
			kind: 'approval',
			request: { approval: { approvalHash }, questions: [] },
		},
		hostInvocation: approvalCard,
		continuation: { action: 'answer', reason: 'HUMAN_RESPONSE_REQUIRED' },
	});
	const approvalCommand = approvalCard.argv.join(' ');
	assert.equal(approvalText.split(approvalCommand).length - 1, 1);
	assert.equal(approvalText.includes('--response reject'), false);
	assert.equal(approvalText.includes('--spec-hash'), false);

	const authorizeCard = projectHostInvocation({ runId, state: 'SPEC_APPROVED' });
	const authorizeText = humanResult('status', {
		runId,
		state: 'WAITING_FOR_AUTHORIZATION',
		pendingInterrupt: {
			interruptId: 'auth-1',
			kind: 'authorization',
			request: { baseCommitSha: '1'.repeat(40) },
		},
		hostInvocation: authorizeCard,
		continuation: { action: 'authorize', reason: 'AUTHORIZATION_REQUIRED' },
	});
	assert.equal(authorizeText.split(authorizeCard.argv.join(' ')).length - 1, 1);
	assert.equal(authorizeText.includes('--envelope-file'), false);

	const questionRequest = {
		questions: [
			{
				questionId: 'goal',
				prompt: 'What is the goal?',
				responseKind: 'text',
				required: true,
			},
		],
	};
	const questionCard = projectHostInvocation(
		{ runId, state: 'WAITING_FOR_ANSWERS', pendingInterruptId: 'question-1' },
		{
			pendingInterrupt: {
				interruptId: 'question-1',
				kind: 'questions',
				stateHash,
				request: questionRequest,
			},
		},
	);
	const questionText = humanResult('status', {
		runId,
		state: 'WAITING_FOR_ANSWERS',
		pendingInterrupt: {
			interruptId: 'question-1',
			kind: 'questions',
			request: questionRequest,
		},
		hostInvocation: questionCard,
	});
	assert.equal(questionText.split(questionCard.argv.join(' ')).length - 1, 1);

	const reconciliationRequest = {
		failingTaskId: 'task-a',
		conflictDetails: 'paths overlap',
		stateHash,
	};
	const reconciliationCard = projectHostInvocation(
		{ runId, state: 'RECONCILING_INTEGRATION', pendingInterruptId: 'reconcile-1' },
		{
			pendingInterrupt: {
				interruptId: 'reconcile-1',
				kind: 'reconciliation_conflict',
				stateHash,
				request: reconciliationRequest,
			},
		},
	);
	const reconciliationText = humanResult('status', {
		runId,
		state: 'RECONCILING_INTEGRATION',
		pendingInterrupt: {
			interruptId: 'reconcile-1',
			kind: 'reconciliation_conflict',
			request: reconciliationRequest,
		},
		hostInvocation: reconciliationCard,
	});
	assert.equal(reconciliationText.split(reconciliationCard.argv.join(' ')).length - 1, 1);
	assert.equal(reconciliationText.includes('<run-id>'), false);

	const planningCard = projectHostInvocation({ runId, state: 'PLANNING_TASKS' });
	const planningText = humanResult('resume', {
		runId,
		state: 'PLANNING_TASKS',
		hostInvocation: planningCard,
		continuation: { action: 'resume', reason: 'INFRASTRUCTURE_RETRY' },
	});
	assert.equal(planningText.split(planningCard.argv.join(' ')).length - 1, 1);
	assert.equal(planningText.includes('--retry'), false);
});
