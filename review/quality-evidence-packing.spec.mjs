import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packQualityEvidencePacket } from './quality-evidence-packing.ts';

const obligation = {
	obligationId: 'obligation-1',
	criterionId: 'AC-01',
	caseId: 'AC-01.1',
	owner: { kind: 'slice', id: 'slice-one' },
	observableOutcome: 'The retry preserves the active review attempt.',
	setupAction: 'Create a review with one reserved attempt.',
	expectedResult: 'The same candidate is reused without a second dispatch.',
	layer: 'unit',
	requiredCapabilities: [],
	implementationPaths: ['review/critic-budget.ts'],
	testCases: [{ file: 'review/critic-budget.spec.mjs', caseKey: 'case-1' }],
	adapterBindingHash: 'a'.repeat(64),
	profileId: 'unit-profile',
};

function completion(outcome = 'passed') {
	return {
		invocation: { status: 'completed' },
		receipt: {
			status: 'passed',
			dischargedObligationIds: ['obligation-1'],
		},
		report: {
			cases: [{
				file: 'review/critic-budget.spec.mjs',
				caseKey: 'case-1',
				obligationIds: ['obligation-1'],
				outcome,
				exercisedCapabilities: [],
				attempts: [{ index: 0, outcome, durationMs: 1 }],
			}],
		},
		observations: { before: null, after: null, signal: null, durationMs: 1 },
	};
}

const policy = {
	retrieval: { maxPacketBytes: 24_576, maxPacketLines: 1_000 },
};

test('checkpoint packet includes case-focused source and normalized receipt outcomes', () => {
	const packet = packQualityEvidencePacket({
		worktreeDir: process.cwd(),
		obligations: [obligation],
		receipts: [{ receiptHash: 'b'.repeat(64), completion: completion() }],
		policy,
	});

	assert.equal(packet.status, 'complete');
	assert.equal(packet.files.length, 2);
	assert.equal(packet.lineCount, packet.files.reduce((sum, file) => sum + file.content.split('\n').length, 1));
	assert.match(packet.text, /"caseKey":"case-1"/);
	assert.match(packet.text, /"outcome":"passed"/);
	assert.match(packet.text, /"exercisedCapabilities":\[\]/);
	assert.match(packet.text, /"implementationSources":\[\{"path":"review\/critic-budget.ts","source":"/);
	assert.match(packet.text, /"receiptHash":"b{64}"/);
});

test('checkpoint packet rejects source paths traversing a symlinked parent directory', t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-packet-path-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, 'candidate'));
	fs.mkdirSync(path.join(root, 'outside'));
	fs.writeFileSync(path.join(root, 'outside/critic-budget.ts'), 'outside source');
	fs.writeFileSync(path.join(root, 'outside/critic-budget.spec.mjs'), 'outside test');
	fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'candidate/review'));
	const packet = packQualityEvidencePacket({
		worktreeDir: path.join(root, 'candidate'), obligations: [obligation],
		receipts: [{ receiptHash: 'b'.repeat(64), completion: completion() }], policy,
	});
	assert.equal(packet.status, 'insufficient_evidence');
	assert.equal(packet.text, '');
	assert.deepEqual(packet.files, []);
});

test('checkpoint packet rejects missing, failed, or non-discharging receipt evidence', () => {
	for (const receipt of [
		{ receiptHash: 'b'.repeat(64), completion: null },
		{ receiptHash: 'b'.repeat(64), completion: completion('failed') },
		{
			receiptHash: 'b'.repeat(64),
			completion: {
				...completion(),
				receipt: { status: 'passed', dischargedObligationIds: [] },
			},
		},
	]) {
		const packet = packQualityEvidencePacket({
			worktreeDir: process.cwd(),
			obligations: [obligation],
			receipts: [receipt],
			policy,
		});
		assert.equal(packet.status, 'insufficient_evidence');
		assert.equal(packet.files.length, 0);
	}
});
