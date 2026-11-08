import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sha256 } from '../policy/contracts/primitives.ts';
import { CommandRegistrationSchema } from '../policy/contracts/quality-evidence-schema.ts';
import { commandBindingHash, recordPins } from './command-evidence.ts';
import { hashEvidenceBytes } from './evidence-files.ts';
import { executeEvidence } from './evidence-port.ts';
import { fixture } from './evidence-port-fixture.mjs';

// Rebinds the standard fixture to a `command` registration that needs no bundle files or qualification artifact.
function commandFixture(f) {
	fs.writeFileSync(path.join(f.root, 'src/corpus.json'), '[]');
	const executable = { path: fs.realpathSync(process.execPath), sha256: hashEvidenceBytes(fs.readFileSync(process.execPath)) };
	const pins = recordPins(f.root, 'src', [{ file: 'corpus.json' }]);
	const argv = [executable.path, 'run.mjs', '--out={reportPath}'];
	const registration = CommandRegistrationSchema.parse({
		kind: 'command', adapterId: 'fake-command', protocolVersion: '1.0.0', argv, cwd: 'src', reportFormat: 'junit',
		retries: 0, executable, pins, commandSha256: commandBindingHash(argv, executable.sha256, pins),
		profiles: f.registration.profiles, limits: f.registration.limits,
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

const ran = (outcome, exitCode = 0) => async () => ({
	exitCode, cases: [{ identity: 'AC-01.1', outcome, message: '', attempts: 1 }], reportBytes: Buffer.from('<testsuites/>'),
});

test('@ac AC-11 @case AC-11.1 a command registration validates without bundle files or qualification artifact', async () => {
	await fixture(async (f) => {
		const registration = commandFixture(f);
		for (const key of ['bundleFiles', 'executableSha256', 'qualificationArtifact']) assert.equal(key in registration, false);
	});
});

test('@ac AC-04 @case AC-04.2 a passing command case discharges its obligation through the injected runner', async () => {
	await fixture(async (f) => {
		const registration = commandFixture(f);
		const spawn = Object.assign(() => assert.fail('command evidence must not spawn an adapter'), { runCommand: ran('passed') });
		const result = await executeEvidence(f.request, registration, f.context, spawn, f.store);
		assert.equal(result.receipt.status, 'passed');
		assert.deepEqual(result.receipt.dischargedObligationIds, ['obligation-1']);
	});
});

test('@ac AC-04 @case AC-04.3 failed cases, a non-zero exit and a missing runner never discharge', async () => {
	for (const [outcome, exitCode] of [['failed', 1], ['passed', 1], ['not-run', 1]]) {
		await fixture(async (f) => {
			const registration = commandFixture(f);
			const spawn = Object.assign(() => assert.fail('no spawn'), { runCommand: ran(outcome, exitCode) });
			const result = await executeEvidence(f.request, registration, f.context, spawn, f.store);
			assert.notEqual(result.receipt.status, 'passed');
			assert.deepEqual(result.receipt.dischargedObligationIds, []);
		});
	}
	await fixture(async (f) => {
		const registration = commandFixture(f);
		const result = await executeEvidence(f.request, registration, f.context, () => assert.fail('no spawn'), f.store);
		assert.equal(f.completion().invocation.failureReason, 'unqualified-evidence-executable');
	});
});

test('@ac AC-06 @case AC-06.3 a pinned file changed by the run fails the evidence closed', async () => {
	await fixture(async (f) => {
		const registration = commandFixture(f);
		const runCommand = async (...args) => {
			fs.writeFileSync(path.join(f.root, 'src/corpus.json'), '[1]');
			return ran('passed')(...args);
		};
		const result = await executeEvidence(f.request, registration, f.context, Object.assign(() => {}, { runCommand }), f.store);
		assert.equal(f.completion().invocation.failureReason, 'PINNED_FILE_MODIFIED');
		assert.deepEqual(result.receipt.dischargedObligationIds, []);
	});
});
