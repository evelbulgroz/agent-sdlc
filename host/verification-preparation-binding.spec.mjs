import assert from 'node:assert/strict';
import test from 'node:test';
import {
	assertPreparationSelectionBinding,
	computePreparationPolicyHash,
	computePreparationSelectionBinding,
	freezePreparationSelection,
} from './verification-preparation.ts';

const BASE = {
	id: 'build-base',
	targetPackages: ['packages/consumer', 'packages/app'],
	packagePath: 'packages/base',
	argv: ['pnpm', '--filter', '@fx/base', 'build'],
	outputPathPrefixes: ['dist'],
};
const CONSUMER = {
	id: 'build-consumer',
	targetPackages: ['packages/consumer'],
	packagePath: 'packages/consumer',
	argv: ['pnpm', '--filter', '@fx/consumer', 'build'],
	outputPathPrefixes: ['dist'],
	dependsOn: ['build-base'],
};
const CONFIG = { builds: [BASE, CONSUMER] };
const TASKS = [
	{ taskId: 'task-0', targetPackage: 'packages/base' },
	{ taskId: 'task-1', targetPackage: 'packages/consumer' },
	{ taskId: 'task-2', targetPackage: 'packages/app' },
];

test('selection binding records per-task closures and the union for final verification', () => {
	const binding = computePreparationSelectionBinding(CONFIG, TASKS);
	assert.deepEqual(Object.keys(binding.tasks).sort(), ['task-1', 'task-2']);
	assert.deepEqual(binding.tasks['task-1'].steps.map((step) => step.id), ['build-base', 'build-consumer']);
	assert.deepEqual(binding.tasks['task-2'].steps.map((step) => step.id), ['build-base']);
	assert.deepEqual(binding.final.steps.map((step) => step.id), ['build-base', 'build-consumer']);
	assert.match(binding.digest, /^[0-9a-f]{64}$/);
	assert.equal(computePreparationSelectionBinding(undefined, TASKS).digest, null);
	assert.equal(computePreparationSelectionBinding(CONFIG, [{ taskId: 't', targetPackage: 'packages/other' }]).digest, null);
});

test('@ac AC-02 @case AC-02.3 changed selection or dependency ordering fails task-plan validation', () => {
	const frozen = computePreparationSelectionBinding(CONFIG, TASKS).digest;
	assert.equal(assertPreparationSelectionBinding(CONFIG, TASKS, frozen).digest, frozen);
	const changedSelection = { builds: [{ ...BASE, targetPackages: ['packages/consumer'] }, CONSUMER] };
	const changedOrdering = { builds: [{ ...BASE, dependsOn: ['build-consumer'] }, { ...CONSUMER, dependsOn: [] }] };
	const changedTargets = TASKS.map((task) => (task.taskId === 'task-2' ? { ...task, targetPackage: 'packages/other' } : task));
	for (const [config, tasks] of [[changedSelection, TASKS], [changedOrdering, TASKS], [CONFIG, changedTargets], [undefined, TASKS]]) {
		assert.throws(
			() => assertPreparationSelectionBinding(config, tasks, frozen),
			(error) => error.code === 'AUTHORIZATION_INVALID' && /frozen task plan binding; reauthorize/.test(error.message),
		);
	}
	assert.throws(() => assertPreparationSelectionBinding(CONFIG, TASKS, null), /frozen task plan binding/);
	assert.equal(assertPreparationSelectionBinding(undefined, TASKS, undefined).digest, null);
});

test('plan freeze refuses to derive a selection from a policy that differs from the authorized one', () => {
	const profile = { verificationPreparation: CONFIG };
	const authorized = computePreparationPolicyHash(CONFIG);
	assert.equal(freezePreparationSelection(profile, authorized, TASKS).digest, computePreparationSelectionBinding(CONFIG, TASKS).digest);
	assert.throws(() => freezePreparationSelection(profile, null, TASKS), /differs from the authorized binding/);
	assert.throws(() => freezePreparationSelection({}, authorized, TASKS), /differs from the authorized binding/);
	assert.equal(freezePreparationSelection({}, undefined, TASKS).digest, null);
});
