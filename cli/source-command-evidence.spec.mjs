import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sha256 } from '../policy/contracts/primitives.ts';
import { CommandRegistrationSchema } from '../policy/contracts/quality-evidence-schema.ts';
import { commandBindingHash, commandScope, recordPins, synthesizeCommandReport } from '../host/command-evidence.ts';
import { executeEvidence } from '../host/evidence-port.ts';
import { fixture } from '../host/evidence-port-fixture.ts';
import { createLocalEvidenceSpawn } from './local-evidence-spawn.ts';

const source = { file: 'src/check.spec.ts', criterionId: 'AC-01', caseId: 'AC-01.1' };
const pass = '<testcase file="src/check.spec.ts" name="@ac AC-01 @case AC-01.1 ready"/>';
const foreignPass = '<testcase file="src/other.spec.ts" name="@ac AC-01 @case AC-01.1 ready"/>';
const foreignFailure = '<testcase file="src/other.spec.ts" name="@ac AC-01 @case AC-01.1 ready"><failure/></testcase>';

function bind(f, body, code = 0, overrides = {}) {
	const script = `import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], ${JSON.stringify(body)});\nprocess.exit(${code});\n`;
	fs.writeFileSync(path.join(f.root, 'src/write-junit.mjs'), overrides.script ?? script);
	const argv = [process.execPath, 'write-junit.mjs', '{reportPath}'];
	const pins = recordPins(f.root, 'src', [{ file: 'write-junit.mjs' }]);
	const fields = {
		...f.registration, argv, pins, packageRoot: 'src', caseIdentity: 'case-file-criterion',
		limits: { ...f.registration.limits, ...overrides.limits },
	};
	const registration = CommandRegistrationSchema.parse({
		...fields, commandSha256: commandBindingHash(argv, fields.executable.sha256, pins, [], commandScope(fields)),
	});
	const hash = sha256(registration);
	f.request.adapterBindingHash = hash;
	for (const obligation of f.request.obligations) obligation.adapterBindingHash = hash;
	f.context.frozenAdapterBindingHash = hash;
	f.context.allowedArgv = [registration.argv];
	f.context.authorization.qualityPlan.adapterBindings = [structuredClone(registration)];
	f.context.authorization.qualityPlan.evidenceObligations = structuredClone(f.request.obligations);
	return registration;
}

test('@ac AC-01 @case AC-01.1 @case AC-01.2 checkpoint evidence scores the recorded report and does not spawn', async () => {
	await fixture(async (f) => {
		const registration = bind(f, `<testsuite>${pass}</testsuite>`, 0, {
			script: 'import fs from "node:fs"; fs.writeFileSync("src/SPAWNED", "1"); process.exit(1);\n',
		});
		fs.writeFileSync(path.join(f.root, 'src/task-report.xml'), `<testsuite>${pass}</testsuite>`);
		f.context.priorReportPath = 'src/task-report.xml';
		const result = await executeEvidence(f.request, registration, f.context, createLocalEvidenceSpawn(), f.store);
		assert.equal(result.receipt.status, 'passed');
		assert.equal(result.report.cases[0].file, source.file);
		assert.equal(fs.existsSync(path.join(f.root, 'src/SPAWNED')), false);
	});
	await fixture(async (f) => {
		const registration = bind(f, `<testsuite>${pass}</testsuite>`, 0, {
			script: 'import fs from "node:fs"; fs.writeFileSync("src/SPAWNED", "1"); process.exit(0);\n',
		});
		f.context.priorReportPath = 'src/missing-task-report.xml';
		const result = await executeEvidence(f.request, registration, f.context, createLocalEvidenceSpawn(), f.store);
		assert.equal(result.invocation.failureReason, 'invalid-evidence');
		assert.equal(fs.existsSync(path.join(f.root, 'src/SPAWNED')), false);
	});
});

test('real local command selection and receipt synthesis retain the matching source despite a foreign collision', async () => {
	await fixture(async (f) => {
		const registration = bind(f, `<testsuite>${foreignPass}${pass}</testsuite>`);
		const result = await executeEvidence(f.request, registration, f.context, createLocalEvidenceSpawn(), f.store);
		assert.equal(result.receipt.status, 'passed');
		assert.deepEqual(result.receipt.dischargedObligationIds, ['obligation-1']);
		assert.equal(result.report.cases[0].file, source.file);
		assert.equal(result.report.cases[0].caseKey, 'ready');
	});
});

test('real local source command preserves nonzero suite exit while the requested leaf remains passed', async () => {
	await fixture(async (f) => {
		const registration = bind(f, `<testsuite>${pass}${foreignFailure}</testsuite>`, 1);
		const result = await createLocalEvidenceSpawn().runCommand(registration, f.request, f.root);
		assert.equal(result.exitCode, 1);
		assert.equal(result.failureReason, undefined);
		assert.equal(result.cases[0].outcome, 'passed');
		assert.deepEqual(result.cases[0].source, source);
		const report = synthesizeCommandReport(registration, f.request, result.cases);
		assert.equal(report.cases[0].file, source.file);
		assert.throws(() => synthesizeCommandReport(registration, f.request, [
			{ ...result.cases[0], source: { ...source, file: 'src/other.spec.ts' } },
		]), /invalid-evidence/);
		assert.throws(() => synthesizeCommandReport(registration, f.request, [
			{ ...result.cases[0], source: undefined },
		]), /invalid-evidence/);
	});
});

test('checkpoint evidence stores a duplicate case id instead of invalid-evidence', async () => {
	await fixture(async (f) => {
		const registration = bind(f, `<testsuite>${pass}${pass}</testsuite>`);
		const result = await executeEvidence(f.request, registration, f.context, createLocalEvidenceSpawn(), f.store);
		assert.equal(result.invocation.failureReason, 'REPORT_DUPLICATE_IDENTITY');
		assert.equal(result.report, null);
	});
});

test('real local command rejects wrong-source, matched duplicates, contradictory exits and unusable reports', async () => {
	const cases = [
		[`<testsuite>${foreignPass}</testsuite>`, 'REPORT_SOURCE_MISMATCH'],
		[`<testsuite>${pass.replace('@ac AC-01', '@ac AC-02')}</testsuite>`, 'REPORT_SOURCE_MISMATCH'],
		[`<testsuite>${pass}${pass}</testsuite>`, 'REPORT_DUPLICATE_IDENTITY'],
		[`<testsuite>${pass}${foreignFailure}</testsuite>`, 'REPORT_EXIT_CONTRADICTION'],
		['', 'REPORT_MALFORMED'],
		['<testsuite>', 'REPORT_MALFORMED'],
		['x'.repeat(17000), 'REPORT_OVERSIZED'],
	];
	for (const [body, reason] of cases) {
		await fixture(async (f) => {
			const registration = bind(f, body);
			const result = await createLocalEvidenceSpawn().runCommand(registration, f.request, f.root);
			assert.equal(result.failureReason, reason, body.slice(0, 100));
			assert.deepEqual(result.cases, []);
		});
	}
});

test('real local command marks absent cases not-run and enforces a finite process deadline', async () => {
	await fixture(async (f) => {
		const registration = bind(f, '<testsuite><testcase file="src/other.spec.ts" name="@ac AC-02 @case AC-02.1 other"/></testsuite>');
		const result = await createLocalEvidenceSpawn().runCommand(registration, f.request, f.root);
		assert.equal(result.exitCode, 0);
		assert.equal(result.cases[0].outcome, 'not-run');
		assert.deepEqual(synthesizeCommandReport(registration, f.request, result.cases).cases[0].attempts, []);
	});
	await fixture(async (f) => {
		const registration = bind(f, '', 0, { script: 'setInterval(() => {}, 1000);', limits: { timeoutMs: 100 } });
		const result = await createLocalEvidenceSpawn().runCommand(registration, f.request, f.root);
		assert.equal(result.failureReason, 'timeout');
		assert.equal(result.exitCode, null);
		assert.deepEqual(result.cases, []);
	});
});
