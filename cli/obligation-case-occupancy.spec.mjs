import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkSpecRun } from './commands/maintenance.ts';
import { occupiedObligationCases } from './obligation-case-occupancy.ts';
import { prepareStartObligations, productObligationsPath, qualityPlanForStoredObligations, writeProductObligations } from './product-obligations-file.ts';

const document = {
	schemaVersion: '1.0.0',
	obligations: [{
		obligationId: 'month-default',
		criterionId: 'AC-01',
		caseId: 'AC-01.1',
		ownerTaskId: 'task-0',
		layer: 'unit',
		profileId: 'unit',
		testFile: 'pkg/widget.spec.ts',
		caseKey: 'month-default',
		observableOutcome: 'The month control is selected.',
		setupAction: 'Open the landing page.',
		expectedResult: 'Month is the selected range.',
	}],
};

test('a missing test file is free and an existing case id is occupied', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case-occupancy-'));
	try {
		assert.deepEqual(occupiedObligationCases(root, document), []);
		fs.mkdirSync(path.join(root, 'pkg'));
		fs.writeFileSync(path.join(root, 'pkg/widget.spec.ts'), [
			'test("other @case AC-02.1", () => {});',
			'// @case AC-01.1 stays in a comment',
			'// test("month @case AC-01.1", () => {});',
			'const sample = "test(\\"month @case AC-01.1\\", () => {})";',
		].join('\n'));
		assert.deepEqual(occupiedObligationCases(root, document), []);
		fs.writeFileSync(path.join(root, 'pkg/widget.spec.ts'), 'test(`month @case ${"AC-01.1"}`, () => {});\n');
		const rendered = occupiedObligationCases(root, document);
		assert.equal(rendered[0].count, 1);
		assert.match(rendered[0].remedy, /already appears 1 time/);
		fs.writeFileSync(path.join(root, 'pkg/widget.spec.ts'), 'test.each([1])("month @case AC-01.1", () => {});\n');
		assert.equal(occupiedObligationCases(root, document)[0].count, 1);
		fs.writeFileSync(path.join(root, 'pkg/widget.spec.ts'), 'test.concurrent("already @case AC-01.1", () => {});\n');
		assert.equal(occupiedObligationCases(root, document)[0].count, 1);
		fs.writeFileSync(path.join(root, 'pkg/widget.spec.ts'), 'test.concurrent.each([1])("already @case AC-01.1", () => {});\n');
		assert.equal(occupiedObligationCases(root, document)[0].count, 1);
		fs.writeFileSync(path.join(root, 'pkg/widget.spec.ts'), 'test("month @case AC-01.1", () => {});\ntest("again @case AC-01.1", () => {});\n');
		const [finding] = occupiedObligationCases(root, document);
		assert.equal(finding.caseId, 'AC-01.1');
		assert.equal(finding.testFile, 'pkg/widget.spec.ts');
		assert.equal(finding.count, 2);
		assert.match(finding.remedy, /already appears 2 times/);
		assert.match(finding.remedy, /keep the existing tests/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a title expression that can supply a case tag fails closed', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case-occupancy-tag-'));
	try {
		fs.mkdirSync(path.join(root, 'pkg'));
		const file = path.join(root, 'pkg/widget.spec.ts');
		fs.writeFileSync(file, 'test(() => {});\ntest(function month() {});\n');
		assert.deepEqual(occupiedObligationCases(root, document), []);
		fs.writeFileSync(file, 'const tag = "@case AC-01.1";\ntest(`month ${tag}`, () => {});\n');
		const interpolated = occupiedObligationCases(root, document);
		assert.equal(interpolated[0].count, 0);
		assert.match(interpolated[0].remedy, /cannot be resolved/);
		assert.match(interpolated[0].remedy, /keep the existing tests/);
		fs.writeFileSync(file, 'test(tag, () => {});\n');
		assert.equal(occupiedObligationCases(root, document)[0].count, 0);
		fs.writeFileSync(file, 'test(`month @case ${id}`, () => {});\n');
		const unresolved = occupiedObligationCases(root, document);
		assert.equal(unresolved[0].caseId, 'AC-01.1');
		assert.equal(unresolved[0].count, 0);
		assert.match(unresolved[0].remedy, /cannot be resolved/);
		assert.match(unresolved[0].remedy, /keep the existing tests/);
		fs.writeFileSync(file, 'test(`month @case ${id}`, () => {});\ntest("month @case AC-01.1", () => {});\n');
		const counted = occupiedObligationCases(root, document);
		assert.equal(counted[0].count, 1);
		assert.match(counted[0].remedy, /already appears 1 time/);
		fs.writeFileSync(file, "test('month @case ' + caseId, () => {});\n");
		const concatenated = occupiedObligationCases(root, document);
		assert.equal(concatenated[0].count, 0);
		assert.match(concatenated[0].remedy, /cannot be resolved/);
		fs.writeFileSync(file, "test.each(['AC-01.1'])('month @case %s', () => {});\n");
		const placeholder = occupiedObligationCases(root, document);
		assert.equal(placeholder[0].count, 0);
		assert.match(placeholder[0].remedy, /cannot be resolved/);
		assert.match(placeholder[0].remedy, /keep the existing tests/);
		fs.writeFileSync(file, "test('month @case ' + 'AC-01.1', () => {});\n");
		const folded = occupiedObligationCases(root, document);
		assert.equal(folded[0].count, 1);
		assert.match(folded[0].remedy, /already appears 1 time/);
		fs.writeFileSync(file, [
			'test.each`',
			'  value',
			'  ${1}',
			"`('renders @case AC-01.1', () => {});",
			'',
		].join('\n'));
		const tagged = occupiedObligationCases(root, document);
		assert.equal(tagged[0].count, 1);
		assert.match(tagged[0].remedy, /already appears 1 time/);
		fs.writeFileSync(file, [
			'test.each`',
			'  id',
			'  ${"AC-01.1"}',
			"`('month @case $id', () => {});",
			'',
		].join('\n'));
		const taggedHole = occupiedObligationCases(root, document);
		assert.equal(taggedHole[0].count, 0);
		assert.match(taggedHole[0].remedy, /cannot be resolved/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('occupancy does not follow a symlink or leave the repository', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case-occupancy-link-'));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'case-occupancy-outside-'));
	try {
		fs.writeFileSync(path.join(outside, 'widget.spec.ts'), 'test("month @case AC-01.1", () => {});\n');
		fs.mkdirSync(path.join(root, 'pkg'));
		fs.symlinkSync(path.join(outside, 'widget.spec.ts'), path.join(root, 'pkg/widget.spec.ts'));
		const linked = occupiedObligationCases(root, document);
		assert.equal(linked[0].count, 0);
		assert.match(linked[0].remedy, /not a regular file/);
		fs.rmSync(path.join(root, 'pkg/widget.spec.ts'));
		fs.symlinkSync(outside, path.join(root, 'linked'));
		const parent = occupiedObligationCases(root, {
			...document,
			obligations: [{ ...document.obligations[0], testFile: 'linked/widget.spec.ts' }],
		});
		assert.equal(parent[0].count, 0);
		assert.match(parent[0].remedy, /not a regular file/);
		const escaped = occupiedObligationCases(root, {
			...document,
			obligations: [{ ...document.obligations[0], testFile: 'pkg/../../outside.spec.ts' }],
		});
		assert.match(escaped[0].remedy, /outside the repository/);
		assert.equal(fs.readFileSync(path.join(outside, 'widget.spec.ts'), 'utf8').includes('@case AC-01.1'), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

const criterion = 'AC-01: The month is selected. Given the landing page. Then the month control is selected. Cases: AC-01.1: month is the default.';
const draft = {
	goal: 'Show the month.',
	acceptanceCriteria: [criterion],
	touchedSurfaces: ['pkg/widget.spec.ts'],
};
const taskManifest = {
	schemaVersion: '1.0.0',
	slices: [{ sliceId: 'behavior', kind: 'vertical', acceptanceCriteria: ['AC-01'] }],
	tasks: [{ taskId: 'landing-task', sliceId: 'behavior', acceptanceCriteria: ['AC-01'] }],
};

function host(root) {
	fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
	fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
	fs.writeFileSync(path.join(root, 'pkg/pin.txt'), 'pin\n');
	fs.writeFileSync(path.join(root, '.agents/sdlc-host.json'), JSON.stringify({
		schemaVersion: '1.7.0',
		profileId: 'demo',
		repositoryId: 'demo',
		adapter: 'default',
		productEvidence: {
			packageRoot: 'pkg',
			commands: {
				unit: {
					argv: [process.execPath, 'pin.txt', '{reportPath}'],
					cwd: 'pkg',
					layer: 'unit',
					pins: [{ file: 'pin.txt' }],
				},
			},
		},
	}));
}

test('start rejects an occupied case id and a stored quality plan does not', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case-occupancy-start-'));
	const obligationsFile = path.join(root, 'obligations.json');
	try {
		host(root);
		const owned = {
			...document,
			obligations: [{ ...document.obligations[0], ownerTaskId: 'landing-task' }],
		};
		fs.writeFileSync(obligationsFile, JSON.stringify(owned));
		const admitted = prepareStartObligations({
			rootDir: root, draft, taskManifest, obligationsFile,
		});
		assert.equal(admitted.obligations[0].caseId, 'AC-01.1');
		fs.mkdirSync(path.dirname(productObligationsPath(root, '2026-11-25-occupancy')), { recursive: true });
		writeProductObligations(root, '2026-11-25-occupancy', admitted);
		fs.writeFileSync(path.join(root, 'pkg/widget.spec.ts'), 'test("month @case AC-01.1", () => {});\n');
		const plan = qualityPlanForStoredObligations({
			rootDir: root, runId: '2026-11-25-occupancy', draft, taskManifest,
		});
		assert.equal(plan.evidenceObligations[0].caseId, 'AC-01.1');
		assert.throws(
			() => prepareStartObligations({ rootDir: root, draft, taskManifest, obligationsFile }),
			/already appears 1 time in pkg\/widget\.spec\.ts/,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('check-spec reports an occupied case id and does not scan when no obligations file is passed', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'case-occupancy-check-'));
	try {
		host(root);
		fs.mkdirSync(path.join(root, 'tools'));
		fs.writeFileSync(path.join(root, 'tools/widget.spec.ts'), 'test("month @case AC-01.1", () => {});\n');
		fs.writeFileSync(path.join(root, '.agents/sdlc-host.json'), JSON.stringify({
			...JSON.parse(fs.readFileSync(path.join(root, '.agents/sdlc-host.json'), 'utf8')),
			workspace: { repositoryScopes: ['tools'], allowedPathRoots: ['tools'] },
		}));
		const obligationsFile = path.join(root, 'obligations.json');
		fs.writeFileSync(obligationsFile, JSON.stringify({
			...document,
			obligations: [{ ...document.obligations[0], testFile: 'tools/widget.spec.ts' }],
		}));
		const goal = [
			'# Intent', '', '## Goal', '', 'Show the month.', '',
			'## Non-goals', '', '- No deploy', '',
			'## Owning context', '', 'tools', '',
			'## Touched surfaces', '', '- tools/widget.spec.ts', '',
			'## Invariants and constraints', '', '- Fail closed', '',
			'## Public contract impact', '', 'None. The page stays local.', '',
			'## Acceptance criteria', '', `1. ${criterion}`, '',
			'## Failure defenses', '', '- Reject empty input', '',
			'## Verification plan', '', '- Run the widget spec', '',
			'## Unresolved questions', '', '_None_', '',
			'## Assumptions', '', '_None_', '',
		].join('\n');
		const checked = checkSpecRun({
			command: 'check-spec',
			values: new Map([['--goal', goal], ['--obligations-file', obligationsFile]]),
			booleans: new Set(),
		}, { rootDir: root });
		assert.equal(checked.ready, false);
		assert.equal(checked.productObligations.occupiedCases[0].caseId, 'AC-01.1');
		assert.equal(checked.productObligations.occupiedCases[0].count, 1);
		const withoutFile = checkSpecRun({
			command: 'check-spec',
			values: new Map([['--goal', goal]]),
			booleans: new Set(),
		}, { rootDir: root });
		assert.equal(withoutFile.productObligations, undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
