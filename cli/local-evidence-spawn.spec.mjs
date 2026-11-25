import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commandBindingHash, recordPins, resolveExecutable } from '../host/command-evidence.ts';
import { CommandRegistrationSchema } from '../policy/contracts/quality-evidence-schema.ts';
import { createLocalEvidenceSpawn } from './local-evidence-spawn.ts';

function registration(root, script, extra = {}) {
	const argv = [process.execPath, script, '{reportPath}'];
	const executable = resolveExecutable(process.execPath, process.env.PATH ?? '');
	const pins = recordPins(root, 'pkg', [{ file: script }]);
	const scope = extra.caseIdentity ? { cwd: 'pkg', caseIdentity: extra.caseIdentity } : undefined;
	return CommandRegistrationSchema.parse({
		kind: 'command',
		adapterId: 'demo-unit',
		protocolVersion: '1.0.0',
		argv,
		cwd: 'pkg',
		reportFormat: 'junit',
		retries: 0,
		executable,
		pins,
		commandSha256: commandBindingHash(argv, executable.sha256, pins, [], scope),
		profiles: [{ profileId: 'unit', layers: ['unit'], capabilities: [] }],
		limits: { timeoutMs: 10_000, maxReportBytes: 1_048_576, maxArtifactBytes: 16_777_216, maxArtifacts: 8 },
		...extra,
	});
}

function layout(scriptBody) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-evidence-'));
	fs.mkdirSync(path.join(root, 'pkg'));
	fs.writeFileSync(path.join(root, 'pkg', 'write-junit.mjs'), scriptBody);
	return root;
}

test('local evidence spawn reads a junit report written to the substituted path', async () => {
	const root = layout(`import fs from 'node:fs';
fs.writeFileSync(process.argv[2], '<testsuite name="product"><testcase name="shows the month @case AC-01.1"></testcase></testsuite>');
`);
	try {
		const spawn = createLocalEvidenceSpawn();
		const ran = await spawn.runCommand(registration(root, 'write-junit.mjs'), {
			obligations: [{ caseId: 'AC-01.1' }],
			binding: { baseCommitSha: 'abc' },
		}, root);
		assert.equal(ran.exitCode, 0);
		assert.equal(ran.failureReason, undefined);
		assert.equal(ran.cases[0].identity, 'AC-01.1');
		assert.equal(ran.cases[0].outcome, 'passed');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function countingScript(exitExpression) {
	return `import fs from 'node:fs';
const countPath = new URL('./count.txt', import.meta.url);
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : '0') + 1;
fs.writeFileSync(countPath, String(count));
fs.writeFileSync(process.argv[2], '<testsuite name="product"><testcase name="shows the month @case AC-01.1"></testcase><testcase name="again @case AC-01.1"></testcase></testsuite>'.replace('again @case AC-01.1', ${exitExpression === 'duplicate' ? "'again @case AC-01.1'" : "'other'"}));
process.exit(${exitExpression === 'duplicate' ? '0' : exitExpression});
`;
}

test('local evidence spawn retries one contradictory exit and keeps a second disagreement', async () => {
	const root = layout(countingScript('1'));
	try {
		const spawn = createLocalEvidenceSpawn();
		const ran = await spawn.runCommand(registration(root, 'write-junit.mjs'), {
			obligations: [{ caseId: 'AC-01.1' }],
		}, root);
		assert.equal(ran.failureReason, 'REPORT_EXIT_CONTRADICTION');
		assert.equal(fs.readFileSync(path.join(root, 'pkg/count.txt'), 'utf8'), '2');
		assert.deepEqual(ran.cases, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('local evidence spawn accepts the second run when the first exit contradicted a passing report', async () => {
	const root = layout(countingScript('count === 1 ? 1 : 0'));
	try {
		const spawn = createLocalEvidenceSpawn();
		const ran = await spawn.runCommand(registration(root, 'write-junit.mjs'), {
			obligations: [{ caseId: 'AC-01.1' }],
		}, root);
		assert.equal(ran.failureReason, undefined);
		assert.equal(ran.exitCode, 0);
		assert.equal(ran.cases[0].outcome, 'passed');
		assert.equal(fs.readFileSync(path.join(root, 'pkg/count.txt'), 'utf8'), '2');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('local evidence spawn does not retry a duplicate hidden by a contradictory exit', async () => {
	const junit = '<testsuite><testcase file="pkg/widget.spec.ts" name="@ac AC-01 @case AC-01.1 month"></testcase><testcase file="pkg/widget.spec.ts" name="@ac AC-01 @case AC-01.1 month"></testcase></testsuite>';
	const root = layout(`import fs from 'node:fs';
const countPath = new URL('./count.txt', import.meta.url);
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : '0') + 1;
fs.writeFileSync(countPath, String(count));
fs.writeFileSync(process.argv[2], ${JSON.stringify(junit)});
process.exit(1);
`);
	try {
		const spawn = createLocalEvidenceSpawn();
		const ran = await spawn.runCommand(registration(root, 'write-junit.mjs', { caseIdentity: 'case-file-criterion' }), {
			obligations: [{
				caseId: 'AC-01.1',
				criterionId: 'AC-01',
				testCases: [{ file: 'pkg/widget.spec.ts', caseKey: 'month' }],
			}],
		}, root);
		assert.equal(ran.failureReason, 'REPORT_DUPLICATE_IDENTITY');
		assert.equal(fs.readFileSync(path.join(root, 'pkg/count.txt'), 'utf8'), '1');
		assert.deepEqual(ran.cases, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('local evidence spawn does not score a retried exit against the previous report', async () => {
	const root = layout(`import fs from 'node:fs';
const countPath = new URL('./count.txt', import.meta.url);
const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : '0') + 1;
fs.writeFileSync(countPath, String(count));
if (count === 1) {
  fs.writeFileSync(process.argv[2], '<testsuite name="product"><testcase name="shows the month @case AC-01.1"></testcase></testsuite>');
  process.exit(1);
}
process.exit(0);
`);
	try {
		const spawn = createLocalEvidenceSpawn();
		const ran = await spawn.runCommand(registration(root, 'write-junit.mjs'), {
			obligations: [{ caseId: 'AC-01.1' }],
		}, root);
		assert.equal(ran.failureReason, 'REPORT_MISSING');
		assert.equal(fs.readFileSync(path.join(root, 'pkg/count.txt'), 'utf8'), '2');
		assert.deepEqual(ran.cases, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('local evidence spawn does not retry a duplicate case id', async () => {
	const root = layout(countingScript('duplicate'));
	try {
		const spawn = createLocalEvidenceSpawn();
		const ran = await spawn.runCommand(registration(root, 'write-junit.mjs'), {
			obligations: [{ caseId: 'AC-01.1' }],
		}, root);
		assert.equal(ran.failureReason, 'REPORT_DUPLICATE_IDENTITY');
		assert.equal(fs.readFileSync(path.join(root, 'pkg/count.txt'), 'utf8'), '1');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('local evidence spawn fails closed when the command writes no report', async () => {
	const root = layout('process.exit(0);\n');
	try {
		const spawn = createLocalEvidenceSpawn();
		const ran = await spawn.runCommand(registration(root, 'write-junit.mjs'), {
			obligations: [{ caseId: 'AC-01.1' }],
		}, root);
		assert.equal(ran.failureReason, 'REPORT_MISSING');
		assert.deepEqual(ran.cases, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
