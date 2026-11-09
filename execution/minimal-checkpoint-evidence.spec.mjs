import assert from 'node:assert/strict';
import test from 'node:test';
import { loopInput, openLoop, readTranscripts } from '../testing/minimal-executor-fixtures.mjs';

for (const limit of [undefined, 1, 2]) {
	test(`audit-required evidence failures consume the ${limit ?? 'default'} attempt allowance`, async () => {
		let checks = 0;
		const loop = openLoop({ label: 'audit-evidence-budget',
			script: Array.from({ length: 8 }, () => ({ action: { kind: 'complete', summary: 'candidate' } })),
			completionValidator: () => {
				checks++;
				return { pass: false, auditRequired: true, summary: 'Required evidence is absent' };
			},
		});
		try {
			const result = await loop.executor.execute({
				...loopInput(loop.worktreeDir), auditGate: true,
				...(limit === undefined ? {} : { maxSourceEditIterations: limit }),
			});
			const expected = limit ?? 3;
			assert.deepEqual(result, { status: 'failed', failureReason: 'evidence-failed', attempts: expected, lastSummary: 'candidate' });
			assert.equal(checks, expected);
			assert.equal(loop.governor.calls.length, expected);
			assert.deepEqual(readTranscripts(loop.fixture.artifacts.artifactsDir).map(entry => entry.attempt),
				Array.from({ length: expected }, (_, index) => index + 1));
		} finally { await loop.close(); }
	});

	test(`missing authored files consume the ${limit ?? 'default'} attempt allowance`, async () => {
		let commands = 0;
		const loop = openLoop({ label: 'missing-file-budget',
			script: Array.from({ length: 8 }, () => ({ action: { kind: 'complete', summary: 'candidate' } })),
			execCli: () => { commands++; return ''; },
		});
		try {
			const result = await loop.executor.execute({
				...loopInput(loop.worktreeDir), auditGate: true,
				authoredPaths: ['src/missing.ts'], authoredTestPaths: ['src/missing.spec.ts'],
				...(limit === undefined ? {} : { maxSourceEditIterations: limit }),
			});
			const expected = limit ?? 3;
			assert.deepEqual(result, { status: 'failed', failureReason: 'evidence-failed', attempts: expected, lastSummary: 'candidate' });
			assert.equal(loop.governor.calls.length, expected);
			assert.equal(commands, 0);
			assert.equal(readTranscripts(loop.fixture.artifacts.artifactsDir).length, expected);
		} finally { await loop.close(); }
	});
}

test('different failed gates share the same two-repair budget and a clean self-audit does not consume it', async () => {
	let evidenceChecks = 0, checkpointChecks = 0;
	const loop = openLoop({ label: 'mixed-gate-budget',
		script: Array.from({ length: 4 }, () => ({ action: { kind: 'complete', summary: 'candidate' } })),
		completionValidator: () => ++evidenceChecks === 1
			? { pass: false, auditRequired: true, summary: 'Required evidence is absent' } : { pass: true },
	});
	try {
		const result = await loop.executor.execute({
			...loopInput(loop.worktreeDir), auditGate: true,
			verifyCheckpointEvidence: async () => {
				if (++checkpointChecks === 1) throw new Error('Named obligation failed');
			},
		});
		assert.deepEqual(result, { status: 'completed', failureReason: null, attempts: 3 });
		assert.equal(evidenceChecks, 3);
		assert.equal(checkpointChecks, 2);
		assert.equal(loop.governor.calls.length, 4);
		assert.match(loop.governor.calls[3].prompt, /AUDIT_REQUIRED/);
		assert.deepEqual(readTranscripts(loop.fixture.artifacts.artifactsDir).map(entry => entry.passed),
			[false, false, true]);
	} finally { await loop.close(); }
});

test('a clean informational self-audit stays inside a single approved source-edit iteration', async () => {
	const loop = openLoop({ label: 'single-approved-audit', script: [
		{ action: { kind: 'complete', summary: 'candidate' } },
		{ action: { kind: 'complete', summary: 'audited unchanged candidate' } },
	] });
	try {
		const result = await loop.executor.execute({
			...loopInput(loop.worktreeDir), auditGate: true, maxSourceEditIterations: 1,
		});
		assert.deepEqual(result, { status: 'completed', failureReason: null, attempts: 1 });
		assert.equal(loop.governor.calls.length, 2);
		assert.match(loop.governor.calls[1].prompt, /AUDIT_REQUIRED/);
	} finally { await loop.close(); }
});

test('failing task obligation remains inside the bounded task repair loop', async () => {
	const loop = openLoop({ label: 'checkpoint-repair', script: [
		{ action: { kind: 'complete', summary: 'first candidate' } },
		{ action: { kind: 'complete', summary: 'repaired candidate' } },
	] });
	try {
		let checks = 0;
		const result = await loop.executor.execute({
			...loopInput(loop.worktreeDir), maxSourceEditIterations: 2,
			verifyCheckpointEvidence: async () => {
				if (++checks === 1) throw new Error('Named obligation did not pass');
			},
		});
		assert.equal(result.status, 'completed');
		assert.equal(result.attempts, 2);
		assert.equal(checks, 2);
		assert.equal(loop.governor.calls.length, 2);
	} finally { await loop.close(); }
});

test('evidence timeout exhausts the approved edit cap without a third edit', async () => {
	const loop = openLoop({ label: 'checkpoint-timeout', script: [
		{ action: { kind: 'complete', summary: 'first' } },
		{ action: { kind: 'complete', summary: 'second' } },
		{ action: { kind: 'complete', summary: 'unauthorized third' } },
	] });
	try {
		const result = await loop.executor.execute({
			...loopInput(loop.worktreeDir), maxSourceEditIterations: 2,
			verifyCheckpointEvidence: async () => { throw new Error('Evidence command timed out'); },
		});
		assert.equal(result.status, 'failed');
		assert.equal(result.failureReason, 'evidence-failed');
		assert.equal(result.attempts, 2);
		assert.equal(loop.governor.calls.length, 2);
	} finally { await loop.close(); }
});

test('zero or expanded human edit approvals fail before any model call', async () => {
	const loop = openLoop({ label: 'checkpoint-edit-limits', script: [] });
	try {
		for (const maxSourceEditIterations of [0, 3]) {
			await assert.rejects(loop.executor.execute({
				...loopInput(loop.worktreeDir), maxSourceEditIterations,
			}), /iteration|attempt|limit/i);
		}
		assert.equal(loop.governor.calls.length, 0);
	} finally { await loop.close(); }
});

test('@ac AC-03 a static coverage miss skips the verification command and consumes a normal attempt', async () => {
	let commands = 0;
	let statics = 0;
	const validator = Object.assign(() => ({ pass: true }), {
		staticCheck: () => (++statics < 3 ? 'ac-coverage failed\n[uncovered] AC-01' : null),
	});
	const loop = openLoop({ label: 'static-precheck-repair',
		script: Array.from({ length: 8 }, () => ({ action: { kind: 'complete', summary: 'candidate' } })),
		execCli: () => { commands++; return ''; },
		completionValidator: validator,
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.deepEqual(result, { status: 'completed', failureReason: null, attempts: 3 });
		assert.equal(statics, 3);
		assert.match(loop.governor.calls[1].prompt, /\[uncovered\] AC-01/);
		assert.equal(commands, 1);
	} finally { await loop.close(); }
});

test('@ac AC-03 a persistent static coverage miss exhausts the two-repair budget without running verification', async () => {
	let commands = 0;
	const loop = openLoop({ label: 'static-precheck-exhausted',
		script: Array.from({ length: 8 }, () => ({ action: { kind: 'complete', summary: 'candidate' } })),
		execCli: () => { commands++; return ''; },
		completionValidator: Object.assign(() => ({ pass: true }), { staticCheck: () => 'ac-coverage failed' }),
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.deepEqual(result, { status: 'failed', failureReason: 'evidence-failed', attempts: 3, lastSummary: 'candidate' });
		assert.equal(commands, 0);
		assert.equal(loop.governor.calls.length, 3);
	} finally { await loop.close(); }
});
