import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
	collectCumulativeTaskPackages,
	scopeSpecSummaryForTask,
	taskAuthoredWritePaths,
	taskReadPathPrefixes,
} from './task-scope.ts';

test('task read scope permits package prior art while writes remain task-authored', () => {
	const task = {
		targetPackage: 'services/billing',
		pathPrefixes: [
			'services/billing/src/billing/domain/elevation-summary.value-object.ts',
		],
	};

	assert.deepEqual(taskReadPathPrefixes(task), ['services/billing']);
	assert.deepEqual(taskAuthoredWritePaths({
		...task,
		authoredPaths: task.pathPrefixes,
	}), task.pathPrefixes);
});

test('collectCumulativeTaskPackages resolves targetPackage, upstream task dependencies, and run authorization', () => {
	const taskPlan = {
		tasks: [
			{ taskId: 'task-1', targetPackage: 'services/billing' },
			{ taskId: 'task-2', targetPackage: 'packages/managed-stateful-component', dependsOn: ['task-1'] },
			{ taskId: 'task-3', targetPackage: 'frontends/example-pwa-frontend', dependsOn: ['task-2'] },
		],
	};
	const authorization = {
		allowedPackages: [
			'frontends/example-pwa-frontend',
			'services/billing',
			'packages/managed-stateful-component',
		],
	};

	const packages = collectCumulativeTaskPackages(taskPlan.tasks[2], taskPlan, authorization);
	assert.deepEqual(packages, [
		'frontends/example-pwa-frontend',
		'packages/managed-stateful-component',
		'services/billing',
	]);

	// Without authorization, upstream dependsOn are still collected
	const upstreamOnly = collectCumulativeTaskPackages(taskPlan.tasks[1], taskPlan, null);
	assert.deepEqual(upstreamOnly, [
		'packages/managed-stateful-component',
		'services/billing',
	]);
});

test('manifest tasks restrict model writes to authored paths rather than broader discovery prefixes', () => {
	assert.deepEqual(
		taskAuthoredWritePaths({
			authoredPaths: ['tools/agent-sdlc/execution/task-executor.mjs'],
			pathPrefixes: ['tools/agent-sdlc'],
		}),
		['tools/agent-sdlc/execution/task-executor.mjs'],
	);
	assert.deepEqual(
		taskAuthoredWritePaths({
			authoredPaths: ['tools/agent-sdlc/execution/task-executor.mjs'],
			pathPrefixes: ['tools/agent-sdlc'],
			generatedOutputs: ['tools/agent-sdlc/generated/contracts.ts'],
		}),
		['tools/agent-sdlc/execution/task-executor.mjs', 'tools/agent-sdlc/generated/contracts.ts'],
	);
	assert.deepEqual(
		taskAuthoredWritePaths({
			pathPrefixes: ['tools/agent-sdlc'],
		}),
		['tools/agent-sdlc'],
	);
});

test('scopeSpecSummaryForTask scopes touched surfaces to task pathPrefixes and prepends task header', () => {
	const task = {
		taskId: 'example-pwa-frontend-task',
		title: 'PWA Frontend distance display',
		targetPackage: 'frontends/example-pwa-frontend',
		pathPrefixes: ['frontends/example-pwa-frontend'],
	};

	const specSummary = [
		'Goal: Add distance source indicators',
		'',
		'Touched Surfaces:',
		'services/billing/src/derive-effective-distance.helper.ts',
		'services/billing/src/billing.entity.ts',
		'frontends/example-pwa-frontend/src/domain/billing-log.ts',
		'frontends/example-pwa-frontend/src/ui/SessionMetadata.tsx',
		'',
		'Invariants & Constraints:',
		'Preserve bounded context separation',
	].join('\n');

	const scoped = scopeSpecSummaryForTask({ specSummary, task });

	assert.match(scoped, /### Current Task Scope: example-pwa-frontend-task/);
	assert.match(scoped, /Target Package: frontends\/example-pwa-frontend/);
	assert.match(scoped, /- frontends\/example-pwa-frontend/);
	assert.match(scoped, /Package-local files may be inspected for prior art/);
	assert.match(scoped, /do NOT modify files outside the authorized mutation path prefixes/);

	// Must include frontend touched surfaces
	assert.ok(scoped.includes('frontends/example-pwa-frontend/src/domain/billing-log.ts'));
	assert.ok(scoped.includes('frontends/example-pwa-frontend/src/ui/SessionMetadata.tsx'));

	// Must NOT include billing service surfaces in touched surfaces
	assert.ok(!scoped.includes('services/billing/src/derive-effective-distance.helper.ts'));
	assert.ok(!scoped.includes('services/billing/src/billing.entity.ts'));

	// Preserves other sections
	assert.ok(scoped.includes('Goal: Add distance source indicators'));
	assert.ok(scoped.includes('Invariants & Constraints:'));
	assert.ok(scoped.includes('Preserve bounded context separation'));
});
