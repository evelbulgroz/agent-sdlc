import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256 } from './contracts/primitives.ts';
import { acceptProductObligations } from './product-quality-plan.ts';

const CRITERION = 'AC-01: The month is selected. Given the landing page. Then the month control is selected. Cases: AC-01.1: month is the default.';
const SECOND = 'AC-01: The month is selected. Given the landing page. Then the month control is selected. Cases: AC-01.1: month is the default; AC-01.2: week is available.';

function obligation(overrides = {}) {
	return {
		obligationId: 'month-default',
		criterionId: 'AC-01',
		caseId: 'AC-01.1',
		ownerTaskId: 'landing-task',
		layer: 'unit',
		profileId: 'unit',
		testFile: 'pkg/widget.spec.ts',
		caseKey: 'month-default',
		observableOutcome: 'The month control is selected.',
		setupAction: 'Open the landing page.',
		expectedResult: 'Month is the selected range.',
		...overrides,
	};
}

function document(rows = [obligation()]) {
	return { schemaVersion: '1.0.0', obligations: rows };
}

function manifest() {
	return {
		slices: [{ sliceId: 'behavior', kind: 'vertical', acceptanceCriteria: ['AC-01'] }],
		tasks: [{ taskId: 'landing-task', sliceId: 'behavior', acceptanceCriteria: ['AC-01'] }],
	};
}

function productEvidence(root) {
	fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
	fs.writeFileSync(path.join(root, 'pkg', 'pin.txt'), 'pin\n');
	return {
		packageRoot: 'pkg',
		commands: {
			unit: {
				argv: [process.execPath, 'pin.txt', '{reportPath}'],
				cwd: 'pkg',
				layer: 'unit',
				pins: [{ file: 'pin.txt' }],
				timeoutMs: 5000,
			},
		},
	};
}

function accept(root, overrides = {}) {
	const { productEvidence: evidence = productEvidence(root), ...rest } = overrides;
	return acceptProductObligations({
		rootDir: root,
		repositoryId: 'demo',
		productEvidence: evidence,
		criteria: [CRITERION],
		obligations: document(),
		taskManifest: manifest(),
		draft: { goal: 'Show the month.', acceptanceCriteria: [CRITERION], touchedSurfaces: ['pkg/widget.spec.ts'] },
		allowedPathPrefixes: ['pkg'],
		code: 'AUTHORIZATION_INVALID',
		...rest,
	});
}

test('acceptProductObligations builds a checkpoint plan for a covering obligations file', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-plan-'));
	try {
		const accepted = accept(root);
		assert.equal(accepted.plan.qualityPolicy.policyId, 'checkpoint-evidence-v1');
		assert.equal(accepted.plan.evidenceObligations.length, 1);
		assert.equal(accepted.plan.evidenceObligations[0].caseId, 'AC-01.1');
		assert.equal(accepted.plan.evidenceObligations[0].adapterBindingHash, sha256(accepted.plan.adapterBindings[0]));
		assert.equal(accepted.document.obligations[0].obligationId, 'month-default');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('acceptProductObligations keeps the legacy envelope when the host declares no product evidence', () => {
	const accepted = acceptProductObligations({
		rootDir: os.tmpdir(),
		repositoryId: 'demo',
		productEvidence: null,
		criteria: [CRITERION],
		obligations: null,
		taskManifest: null,
		draft: { goal: 'Show the month.', acceptanceCriteria: [CRITERION], touchedSurfaces: [] },
		allowedPathPrefixes: [],
		code: 'AUTHORIZATION_INVALID',
	});
	assert.equal(accepted.document, null);
	assert.equal(accepted.plan, undefined);
});

test('acceptProductObligations rejects a missing obligations file when product evidence is declared', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-plan-missing-'));
	assert.throws(
		() => accept(root, { obligations: null }),
		/product obligations file covering every acceptance case/,
	);
	fs.rmSync(root, { recursive: true, force: true });
});

test('acceptProductObligations rejects obligations without product evidence', () => {
	assert.throws(
		() => accept(os.tmpdir(), { productEvidence: null, obligations: document() }),
		/require productEvidence/,
	);
});

test('acceptProductObligations rejects a criterion that has no case', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-plan-nocase-'));
	const bare = 'AC-01: The month is selected. Given the landing page. Then the month control is selected.';
	assert.throws(
		() => accept(root, { criteria: [bare], draft: { goal: 'Show the month.', acceptanceCriteria: [bare], touchedSurfaces: ['pkg/widget.spec.ts'] } }),
		/at least one AC-NN\.N case/,
	);
	fs.rmSync(root, { recursive: true, force: true });
});

test('acceptProductObligations rejects a file that omits a declared case', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-plan-omit-'));
	assert.throws(
		() => accept(root, { criteria: [SECOND] }),
		/omits acceptance obligations/,
	);
	fs.rmSync(root, { recursive: true, force: true });
});

test('acceptProductObligations rejects an owner that does not own the criterion', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-plan-owner-'));
	assert.throws(
		() => accept(root, { obligations: document([obligation({ ownerTaskId: 'other-task' })]) }),
		/does not own AC-01/,
	);
	fs.rmSync(root, { recursive: true, force: true });
});

test('acceptProductObligations rejects a test file outside the authorized paths', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-plan-path-'));
	assert.throws(
		() => accept(root, { obligations: document([obligation({ testFile: 'other/widget.spec.ts' })]) }),
		/outside the authorized paths/,
	);
	fs.rmSync(root, { recursive: true, force: true });
});

test('acceptProductObligations accepts the implicit task-0 owner when no manifest is supplied', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-plan-implicit-'));
	try {
		fs.mkdirSync(path.join(root, 'policy'), { recursive: true });
		const criterion = CRITERION;
		const accepted = accept(root, {
			taskManifest: null,
			allowedPathPrefixes: ['policy'],
			criteria: [criterion],
			draft: { goal: 'Show the month.', acceptanceCriteria: [criterion], touchedSurfaces: ['policy/widget.ts'] },
			obligations: document([obligation({
				ownerTaskId: 'task-0',
				testFile: 'policy/widget.spec.ts',
			})]),
		});

		assert.equal(accepted.plan.evidenceObligations[0].owner.id, 'task-0');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('product plans freeze a sibling command root and source identity while leaving the default command unchanged', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-plan-sibling-'));
	t.after(() => fs.rmSync(root, { recursive: true }));
	const evidence = productEvidence(root);
	fs.mkdirSync(path.join(root, 'sibling'));
	fs.writeFileSync(path.join(root, 'sibling/pin.txt'), 'pin\n');
	const legacy = accept(root, { productEvidence: evidence }).plan.adapterBindings[0];
	assert.equal('packageRoot' in legacy, false);
	assert.equal('caseIdentity' in legacy, false);
	evidence.commands.node = {
		...evidence.commands.unit, cwd: 'sibling', packageRoot: 'sibling', caseIdentity: 'case-file-criterion',
	};
	const accepted = accept(root, {
		productEvidence: evidence, allowedPathPrefixes: ['pkg', 'sibling'], criteria: [SECOND],
		obligations: document([obligation(), obligation({
			obligationId: 'node-proof', caseId: 'AC-01.2', profileId: 'node', testFile: 'sibling/widget.spec.mjs',
		})]),
	});
	assert.deepEqual(accepted.plan.adapterBindings.find((item) => item.profiles[0].profileId === 'unit'), legacy);
	const node = accepted.plan.adapterBindings.find((item) => item.profiles[0].profileId === 'node');
	assert.equal(node.packageRoot, 'sibling');
	assert.equal(node.caseIdentity, 'case-file-criterion');
	assert.equal(node.pins[0].path, 'sibling/pin.txt');
	assert.equal(accepted.plan.evidenceObligations.find((item) => item.obligationId === 'node-proof').adapterBindingHash, sha256(node));
});
