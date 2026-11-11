import assert from 'node:assert/strict';
import test from 'node:test';
import {
	classifyIntegrationDiagnostics,
	validIntegrationDiagnostics,
} from './integration-diagnostics.ts';

const floor = (paths) => ({ schemaVersion: '1', coverageFloor: { pass: false, paths } });

test('a coverage floor failure classifies the reported paths', () => {
	const diagnostics = floor(['pkg/src/orphan.ts']);
	assert.deepEqual(validIntegrationDiagnostics({ integrationDiagnostics: diagnostics }).coverageFloor.paths, ['pkg/src/orphan.ts']);
	assert.deepEqual(classifyIntegrationDiagnostics(diagnostics), {
		category: 'coverage_floor_regression',
		targetPaths: ['pkg/src/orphan.ts'],
	});
});

test('a missing diagnostics object is unclassified', () => {
	assert.equal(validIntegrationDiagnostics(null), null);
	assert.equal(validIntegrationDiagnostics({}), null);
	assert.deepEqual(classifyIntegrationDiagnostics(null), { category: 'unclassified', targetPaths: [] });
	assert.deepEqual(classifyIntegrationDiagnostics(undefined), { category: 'unclassified', targetPaths: [] });
});

test('an empty path list, an unknown version, and an extra key drop the diagnostics', () => {
	assert.equal(validIntegrationDiagnostics({ integrationDiagnostics: floor([]) }), null);
	assert.equal(validIntegrationDiagnostics({ integrationDiagnostics: { schemaVersion: '2' } }), null);
	assert.equal(validIntegrationDiagnostics({
		integrationDiagnostics: { ...floor(['pkg/a.ts']), extra: true },
	}), null);
	assert.equal(classifyIntegrationDiagnostics([]).category, 'unclassified');
});

test('a changed clone outranks a line shift, and an unchanged move is a line shift', () => {
	const shift = classifyIntegrationDiagnostics({
		schemaVersion: '1',
		clones: [{ tool: 'jscpd', baseline: 'pkg/a.ts:1-2', observed: 'pkg/a.ts:8-9', textUnchanged: true }],
	});
	assert.equal(shift.category, 'baseline_clone_line_shift');
	assert.deepEqual([...shift.targetPaths], ['pkg/a.ts']);
	const mixed = classifyIntegrationDiagnostics({
		schemaVersion: '1',
		clones: [
			{ tool: 'jscpd', baseline: 'pkg/a.ts:1-2', observed: 'pkg/a.ts:8-9', textUnchanged: true },
			{ tool: 'jscpd', baseline: 'pkg/b.ts:1-2', observed: 'pkg/b.ts:1-2', textUnchanged: false },
		],
	});
	assert.equal(mixed.category, 'quality_regression');
	assert.deepEqual([...mixed.targetPaths], ['pkg/b.ts']);
});

test('coverage outranks contract drift and a passing floor is skipped', () => {
	const both = classifyIntegrationDiagnostics({
		schemaVersion: '1',
		coverageFloor: { pass: false, paths: ['pkg/cov.ts'] },
		contractDrift: { pass: false, paths: ['pkg/contract.ts'] },
	});
	assert.equal(both.category, 'coverage_floor_regression');
	const contract = classifyIntegrationDiagnostics({
		schemaVersion: '1',
		coverageFloor: { pass: true, paths: ['pkg/cov.ts'] },
		contractDrift: { pass: false, paths: ['pkg/contract.ts'] },
	});
	assert.equal(contract.category, 'contract_drift');
	assert.deepEqual([...contract.targetPaths], ['pkg/contract.ts']);
});
