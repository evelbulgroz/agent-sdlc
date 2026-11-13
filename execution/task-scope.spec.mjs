import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import {
	collectCumulativeTaskPackages,
	formatTaskScope,
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

test('removed paths stay out of the authored write set and are listed for deletion', () => {
	const task = {
		authoredPaths: ['services/billing/src/keep.ts'],
		pathPrefixes: ['services/billing', 'services/billing/src/old.ts'],
		removedPaths: ['services/billing/src/old.ts'],
	};
	assert.deepEqual(taskAuthoredWritePaths(task), ['services/billing/src/keep.ts']);
	const scoped = scopeSpecSummaryForTask({ specSummary: 'Goal: retire the sibling', task });
	assert.match(
		scoped,
		/Authorized Mutation Path Prefixes:\n- services\/billing\/src\/keep\.ts\nDelete before completing:\n- services\/billing\/src\/old\.ts\n/,
	);
	assert.match(scoped, /Those files must be absent/);
	assert.equal(scoped.includes('\n- services/billing\n'), false);
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

test('@ac AC-05 formatTaskScope forbids a second declaration and states the line-shift repair', () => {
	const header = formatTaskScope({
		taskId: 'store-task',
		title: 'Wire the store',
		targetPackage: 'pkg',
		authoredPaths: ['pkg/src/store.ts'],
		pathPrefixes: ['pkg'],
	});
	assert.match(header, /a copied class with the same name is a duplicate, not a reuse\./);
	assert.match(header, /A quality-gate line shift fails the task even when the package tests pass\./);
	assert.match(header, /same number of replacement lines/);
	assert.match(header, /Authorized Mutation Path Prefixes:\n- pkg\/src\/store\.ts/);
	assert.match(header, /do NOT modify files outside the authorized mutation path prefixes/);
});

test('@ac AC-06 the task-scope files stay within the navigability budget', () => {
	for (const name of ['task-scope.ts', 'task-scope.spec.mjs']) {
		const data = fs.readFileSync(new URL(name, import.meta.url));
		let lines = 0;
		for (const byte of data) if (byte === 10) lines += 1;
		assert.ok(lines <= 500 && data.length <= 20480, `${name} ${lines} lines ${data.length} bytes`);
	}
});
