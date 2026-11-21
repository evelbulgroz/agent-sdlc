import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commandBindingHash, recordPins, resolveExecutable } from '../host/command-evidence.ts';
import { CommandRegistrationSchema } from '../policy/contracts/quality-evidence-schema.ts';
import { createLocalEvidenceSpawn } from './local-evidence-spawn.ts';

function registration(root, script) {
	const argv = [process.execPath, script, '{reportPath}'];
	const executable = resolveExecutable(process.execPath, process.env.PATH ?? '');
	const pins = recordPins(root, 'pkg', [{ file: script }]);
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
		commandSha256: commandBindingHash(argv, executable.sha256, pins),
		profiles: [{ profileId: 'unit', layers: ['unit'], capabilities: [] }],
		limits: { timeoutMs: 10_000, maxReportBytes: 1_048_576, maxArtifactBytes: 16_777_216, maxArtifacts: 8 },
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

test('local evidence spawn fails closed when the command writes no report', async () => {
	const root = layout('process.exit(0);\n');
	try {
		const spawn = createLocalEvidenceSpawn();
		const ran = await spawn.runCommand(registration(root, 'write-junit.mjs'), {
			obligations: [{ caseId: 'AC-01.1' }],
		}, root);
		assert.equal(ran.failureReason, 'invalid-evidence');
		assert.deepEqual(ran.cases, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
