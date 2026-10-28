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
		targetPackage: 'apps/services/conditioning',
		pathPrefixes: [
			'apps/services/conditioning/src/conditioning/domain/elevation-summary.value-object.ts',
		],
	};

	assert.deepEqual(taskReadPathPrefixes(task), ['apps/services/conditioning']);
	assert.deepEqual(taskAuthoredWritePaths({
		...task,
		authoredPaths: task.pathPrefixes,
	}), task.pathPrefixes);
});

test('collectCumulativeTaskPackages resolves targetPackage, upstream task dependencies, and run authorization', () => {
	const taskPlan = {
		tasks: [
			{ taskId: 'task-1', targetPackage: 'apps/services/conditioning' },
			{ taskId: 'task-2', targetPackage: 'packages/managed-stateful-component', dependsOn: ['task-1'] },
			{ taskId: 'task-3', targetPackage: 'apps/frontends/example-pwa-frontend', dependsOn: ['task-2'] },
		],
	};
	const authorization = {
		allowedPackages: [
			'apps/frontends/example-pwa-frontend',
			'apps/services/conditioning',
			'packages/managed-stateful-component',
		],
	};

	const packages = collectCumulativeTaskPackages(taskPlan.tasks[2], taskPlan, authorization);
	assert.deepEqual(packages, [
		'apps/frontends/example-pwa-frontend',
		'apps/services/conditioning',
		'packages/managed-stateful-component',
	]);

	// Without authorization, upstream dependsOn are still collected
	const upstreamOnly = collectCumulativeTaskPackages(taskPlan.tasks[1], taskPlan, null);
	assert.deepEqual(upstreamOnly, [
		'apps/services/conditioning',
		'packages/managed-stateful-component',
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
		targetPackage: 'apps/frontends/example-pwa-frontend',
		pathPrefixes: ['apps/frontends/example-pwa-frontend'],
	};

	const specSummary = [
		'Goal: Add distance source indicators',
		'',
		'Touched Surfaces:',
		'apps/services/conditioning/src/derive-effective-distance.helper.ts',
		'apps/services/conditioning/src/conditioning.entity.ts',
		'apps/frontends/example-pwa-frontend/src/domain/conditioning-log.ts',
		'apps/frontends/example-pwa-frontend/src/ui/SessionMetadata.tsx',
		'',
		'Invariants & Constraints:',
		'Preserve bounded context separation',
	].join('\n');

	const scoped = scopeSpecSummaryForTask({ specSummary, task });

	assert.match(scoped, /### Current Task Scope: example-pwa-frontend-task/);
	assert.match(scoped, /Target Package: apps\/frontends\/example-pwa-frontend/);
	assert.match(scoped, /- apps\/frontends\/example-pwa-frontend/);
	assert.match(scoped, /Package-local files may be inspected for prior art/);
	assert.match(scoped, /do NOT modify files outside the authorized mutation path prefixes/);

	// Must include frontend touched surfaces
	assert.ok(scoped.includes('apps/frontends/example-pwa-frontend/src/domain/conditioning-log.ts'));
	assert.ok(scoped.includes('apps/frontends/example-pwa-frontend/src/ui/SessionMetadata.tsx'));

	// Must NOT include conditioning service surfaces in touched surfaces
	assert.ok(!scoped.includes('apps/services/conditioning/src/derive-effective-distance.helper.ts'));
	assert.ok(!scoped.includes('apps/services/conditioning/src/conditioning.entity.ts'));

	// Preserves other sections
	assert.ok(scoped.includes('Goal: Add distance source indicators'));
	assert.ok(scoped.includes('Invariants & Constraints:'));
	assert.ok(scoped.includes('Preserve bounded context separation'));
});
