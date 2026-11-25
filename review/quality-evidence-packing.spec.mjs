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

function writeCitedTree(root, spec) {
	fs.mkdirSync(path.join(root, 'review'));
	fs.writeFileSync(path.join(root, 'review/critic-budget.spec.mjs'), spec);
	fs.writeFileSync(path.join(root, 'review/critic-budget.ts'), 'export const budget = 1;\n');
}

const citedSpec = `import assert from 'node:assert/strict';
test('shows the month @case AC-01.1', () => { assert.equal(1, 1); });
test('unrelated sentinel @case AC-09.9', () => { assert.equal(2, 2); });
`;

test('checkpoint packet includes obligated test excerpts and the implementation source once', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-packet-excerpt-'));
	try {
		writeCitedTree(root, citedSpec);
		const packet = packQualityEvidencePacket({
			worktreeDir: root,
			obligations: [obligation],
			receipts: [{ receiptHash: 'b'.repeat(64), completion: completion() }],
			policy,
		});
		assert.equal(packet.status, 'complete', packet.reason ?? '');
		assert.equal(packet.files.length, 2);
		assert.equal(packet.lineCount, packet.files.reduce((sum, file) => sum + file.content.split('\n').length, 1));
		const packedSpec = packet.files.find((file) => file.path.endsWith('.spec.mjs'));
		assert.match(packedSpec.content, /@case AC-01\.1/);
		assert.equal(packedSpec.content.includes('unrelated sentinel'), false);
		assert.equal(packet.files.find((file) => file.path.endsWith('.ts')).content, 'export const budget = 1;\n');
		assert.match(packet.text, /"caseKey":"case-1"/);
		assert.match(packet.text, /"outcome":"passed"/);
		assert.match(packet.text, /"exercisedCapabilities":\[\]/);
		assert.match(packet.text, /"sources":\{"review\/critic-budget.spec.mjs":"/);
		assert.match(packet.text, /"implementationPaths":\["review\/critic-budget.ts"\]/);
		assert.match(packet.text, /"receiptHash":"b{64}"/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('checkpoint packet includes each shared source file once regardless of obligation count', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-packet-shared-'));
	try {
		writeCitedTree(root, citedSpec);
		const many = Array.from({ length: 12 }, (_, index) => ({
			...obligation,
			obligationId: `obligation-${index}`,
			testCases: [{ file: 'review/critic-budget.spec.mjs', caseKey: `case-${index}` }],
		}));
		const base = completion();
		const completionFor = {
			...base,
			receipt: { ...base.receipt, dischargedObligationIds: many.map((item) => item.obligationId) },
			report: {
				cases: many.map((item, index) => ({
					...base.report.cases[0],
					caseKey: `case-${index}`,
					obligationIds: [item.obligationId],
				})),
			},
		};
		const packet = packQualityEvidencePacket({
			worktreeDir: root,
			obligations: many,
			receipts: [{ receiptHash: 'b'.repeat(64), completion: completionFor }],
			policy,
		});
		assert.equal(packet.status, 'complete', packet.reason ?? '');
		assert.equal(packet.text.split('"sources"').length, 2);
		assert.ok(packet.byteCount <= policy.retrieval.maxPacketBytes);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('checkpoint packet excerpts a cited test from a file larger than the packet ceiling', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-packet-large-'));
	try {
		fs.mkdirSync(path.join(root, 'review'));
		const spec = `${'// pad the mature suite\n'.repeat(2000)}${citedSpec}`;
		assert.ok(Buffer.byteLength(spec, 'utf8') > policy.retrieval.maxPacketBytes);
		fs.writeFileSync(path.join(root, 'review/critic-budget.spec.mjs'), spec);
		const sameFile = {
			...obligation,
			implementationPaths: ['review/critic-budget.spec.mjs'],
		};
		const packet = packQualityEvidencePacket({
			worktreeDir: root,
			obligations: [sameFile],
			receipts: [{ receiptHash: 'b'.repeat(64), completion: completion() }],
			policy,
		});
		assert.equal(packet.status, 'complete', packet.reason ?? '');
		assert.ok(packet.byteCount <= policy.retrieval.maxPacketBytes);
		assert.match(packet.files[0].content, /@case AC-01\.1/);
		assert.equal(packet.files[0].content.includes('pad the mature suite'), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('checkpoint packet names a cited case that has no excerpt', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-packet-missing-'));
	try {
		fs.mkdirSync(path.join(root, 'review'));
		fs.writeFileSync(path.join(root, 'review/critic-budget.spec.mjs'), 'test("other @case AC-02.1", () => {});\n');
		fs.writeFileSync(path.join(root, 'review/critic-budget.ts'), 'export const budget = 1;\n');
		const packet = packQualityEvidencePacket({
			worktreeDir: root,
			obligations: [obligation],
			receipts: [{ receiptHash: 'b'.repeat(64), completion: completion() }],
			policy,
		});
		assert.equal(packet.status, 'insufficient_evidence');
		assert.match(packet.reason, /Obligated case AC-01\.1 has no excerpt in review\/critic-budget\.spec\.mjs/);
		assert.equal(packet.reason.includes('unavailable'), false);
		assert.equal(packet.text, '');
		assert.deepEqual(packet.files, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
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
