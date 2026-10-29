import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli/cli.ts';
import { createPlanCriticInterrupt } from '../cli/hitl.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { SdlcError } from '../policy/errors.ts';
import {
	advanceSeed,
	checkpointState,
	cleanupRun,
	createSeedRun,
	sampleEnvelope,
} from '../testing/continuation-fixtures.mjs';

test('@ac AC-02 @ac AC-14 a stored envelope admits planning and a plan-critic residual waits for a human answer', async () => {
	const fixture = await createSeedRun({ label: 'envelope-planning', stateName: 'SPEC_APPROVED' });
	try {
		await advanceSeed(fixture, {
			to: 'SPEC_APPROVED',
			eventType: 'SPEC_APPROVED',
			updates: { approvedSpecHash: fixture.draftHash },
			payload: { approvedSpecHash: fixture.draftHash },
		});
		const envelope = sampleEnvelope(
			fixture.runId,
			fixture.draftHash,
			'1'.repeat(40),
			['packages/shared-base/'],
		);
		const envelopePath = path.join(fixture.paths.runtimeDir, 'envelope.json');
		fs.writeFileSync(envelopePath, JSON.stringify(envelope));
		const authorized = await runCli(
			['authorize', '--run', fixture.runId, '--envelope-file', envelopePath, '--json'],
			{
				rootDir: REPOSITORY_ROOT,
				governor: fixture.governor,
				gitCli: () => {
					throw new SdlcError('WORKTREE_FAILED', 'fixture stops before worktree creation');
				},
				execCli: () => {
					throw new SdlcError('HYDRATION_FAILED', 'fixture stops before install');
				},
			},
		);
		assert.ok(
			fixture.store
				.listEvents(fixture.runId)
				.some((event) => event.eventType === 'RUN_AUTHORIZED'),
			JSON.stringify(authorized.result.error ?? authorized.result.state),
		);
		const planned = fixture.store.getRun(fixture.runId);
		assert.ok(
			[
				'PLANNING_TASKS',
				'EVALUATING_POLICY',
				'REVIEWING_PLAN',
				'WAITING_FOR_PLAN_ACCEPTANCE',
				'PREPARING_WORKSPACE',
				'BLOCKED',
				'FAILED',
				'ESCALATED',
			].includes(planned.state),
			planned.state,
		);
	} finally {
		fixture.store.close();
		cleanupRun(fixture.runId);
	}

	const residual = await createSeedRun({
		label: 'plan-residual',
		stateName: 'REVIEWING_PLAN',
	});
	try {
		const current = residual.store.getRun(residual.runId);
		const interrupt = createPlanCriticInterrupt({
			runId: residual.runId,
			runtimeRevision: current.runtimeRevision + 1,
			taskPlanHash: 'a'.repeat(64),
			approvedPlanPolicyHash: 'b'.repeat(64),
			criticReport: { hasP1: true, findingsCount: 1 },
		});
		const requestArtifact = residual.artifacts.writeJson('plan-critic-interrupt', interrupt.payload);
		residual.runtime.transition(current, {
			to: 'WAITING_FOR_PLAN_ACCEPTANCE',
			eventType: 'PLAN_CRITIC_COMPLETED',
			causalId: interrupt.interruptId,
			updates: { pendingInterruptId: interrupt.interruptId },
			payload: { interruptId: interrupt.interruptId, hasP1: true },
			effects: {
				createInterrupt: {
					interruptId: interrupt.interruptId,
					runId: residual.runId,
					kind: 'plan_critic',
					stateHash: interrupt.stateHash,
					requestArtifact,
					createdAt: new Date().toISOString(),
				},
			},
		});
		await checkpointState(residual.runtime, residual.store.getRun(residual.runId));
		const status = await runCli(['status', '--run', residual.runId, '--json'], {
			rootDir: REPOSITORY_ROOT,
		});
		assert.equal(status.exitCode, 2, JSON.stringify(status.result.error ?? status.result.state));
		assert.deepEqual(status.result.continuation, {
			action: 'answer',
			reason: 'HUMAN_RESPONSE_REQUIRED',
		});
	} finally {
		residual.store.close();
		cleanupRun(residual.runId);
	}
});

test('@ac AC-13 @ac AC-14 both host documents describe the same continuation loop', () => {
	const required =
		'The host loop is approve, then authorize with an envelope, then resume until continuation.action is stop or answer by executing hostInvocation. The host does not keep its own retry count. Planning and plan critic run after the envelope is stored.';
	for (const relativePath of ['README.md', 'cli/README.md']) {
		const text = fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
		assert.ok(text.includes(required), relativePath);
	}
});

test('@ac AC-15 committed model limits do not increase and profiles stay coherent', async () => {
	const { loadPolicy } = await import('@evelbulgroz/model-usage-govenor/policy');
	const hostPolicyPath = path.join(REPOSITORY_ROOT, '.agents/model-usage-policy.json');
	const policyPath = fs.existsSync(hostPolicyPath)
		? hostPolicyPath
		: loadPolicy.DEFAULT_BUNDLED_POLICY_PATH;
	const current = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
	const parent = fs.existsSync(hostPolicyPath)
		? JSON.parse(
				execFileSync('git', ['show', 'HEAD:.agents/model-usage-policy.json'], {
					cwd: REPOSITORY_ROOT,
					encoding: 'utf8',
				}),
			)
		: current;
	const numbers = (value, prefix, out) => {
		if (typeof value === 'number' && Number.isFinite(value)) {
			out.push([prefix, value]);
			return;
		}
		if (Array.isArray(value)) {
			value.forEach((item, index) => numbers(item, `${prefix}[${index}]`, out));
			return;
		}
		if (value && typeof value === 'object') {
			for (const [key, item] of Object.entries(value)) {
				numbers(item, prefix ? `${prefix}.${key}` : key, out);
			}
		}
	};
	const currentNumbers = [];
	const parentNumbers = [];
	numbers(current.instance, 'instance', currentNumbers);
	numbers(parent.instance, 'instance', parentNumbers);
	for (const [profileName, profile] of Object.entries(current.profiles)) {
		numbers(profile.limits, `profiles.${profileName}.limits`, currentNumbers);
		numbers(parent.profiles[profileName].limits, `profiles.${profileName}.limits`, parentNumbers);
	}
	for (const route of current.routes) {
		const parentRoute = parent.routes.find((candidate) => candidate.id === route.id);
		if (!parentRoute) continue;
		numbers(route, `routes.${route.id}`, currentNumbers);
		numbers(parentRoute, `routes.${route.id}`, parentNumbers);
	}
	const parentByKey = new Map(parentNumbers);
	for (const [key, value] of currentNumbers) {
		assert.ok(
			value <= parentByKey.get(key),
			`${key} increased`,
		);
	}
	for (const profile of Object.values(current.profiles)) {
		const limits = profile.limits;
		assert.ok(
			limits.maxTotalTokens >=
				limits.maxPhysicalAttempts * (limits.maxPromptTokens + limits.maxCompletionTokens),
		);
	}
});

test('@ac AC-14 fixture source file strictly contains zero forbidden vendor tokens', () => {
	const selfContent = fs.readFileSync(import.meta.filename, 'utf8');
	const forbiddenTokens = ['Cop' + 'ilot', 'Anti' + 'gravity', 'Gem' + 'ini', 'Gr' + 'ok'];
	for (const token of forbiddenTokens) {
		assert.equal(
			selfContent.includes(token),
			false,
			`Fixture source must not contain forbidden vendor string '${token}'`,
		);
	}
});
