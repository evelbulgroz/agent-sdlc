import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
	createAcceptanceEvidenceValidator,
} from './task-acceptance-evidence.ts';
import {
	promptBlocks,
} from './minimal-prompt.ts';
import {
	failedCommand,
	loopInput,
	openLoop,
	readTranscripts,
	sizedLog,
} from '../testing/minimal-executor-fixtures.mjs';

test('@ac AC-04 @case AC-04.1 a 12000 byte verification log is inlined in the next prompt', async () => {
	const log = sizedLog(12_000);
	let checks = 0;
	const loop = openLoop({
		label: 'inline-log',
		script: [
			{ action: { kind: 'complete', summary: 'done' } },
			{ action: { kind: 'complete', summary: 'done' } },
		],
		execCli: () => {
			checks += 1;
			if (checks === 1) throw failedCommand(log);
			return '';
		},
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'completed');
		assert.equal(loop.governor.calls.length, 2);
		assert.ok(loop.governor.calls[1].prompt.includes(log));
		assert.match(loop.governor.calls[1].prompt, /expected 1/);
		assert.match(loop.governor.calls[1].prompt, /expected 2/);
		assert.match(loop.governor.calls[1].prompt, /tests failed/);
	} finally {
		await loop.close();
	}
});

test('@ac AC-04 @case AC-04.2 a 40000 byte verification log is paged and its tail stays in the prompt', async () => {
	const log = sizedLog(40_000);
	let checks = 0;
	const loop = openLoop({
		label: 'paged-log',
		script: [
			{ action: { kind: 'complete', summary: 'done' } },
			{ action: { kind: 'complete', summary: 'done' } },
		],
		execCli: () => {
			checks += 1;
			if (checks === 1) throw failedCommand(log);
			return '';
		},
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'completed');
		const prompt = loop.governor.calls[1].prompt;
		const tail = prompt.split('\n').slice(-40).join('\n');
		assert.match(tail, /expected 1/);
		assert.match(tail, /expected 2/);
		assert.match(tail, /tests failed/);
		const match = prompt.match(/\.tmp\/executor-pages\/\S+/);
		assert.ok(match);
		assert.equal(fs.readFileSync(path.join(loop.worktreeDir, match[0]), 'utf8'), log);
	} finally {
		await loop.close();
	}
});

test('@ac AC-05 verification retries stop after two further attempts', async () => {
	const loop = openLoop({
		label: 'retry-cap',
		script: [
			{ action: { kind: 'complete', summary: 'done' } },
			{ action: { kind: 'complete', summary: 'done' } },
			{ action: { kind: 'complete', summary: 'done' } },
			{ action: { kind: 'complete', summary: 'must not run' } },
		],
		execCli: () => {
			throw failedCommand('tests failed');
		},
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'failed');
		assert.equal(result.failureReason, 'verification-failed');
		assert.equal(result.attempts, 3);
		assert.equal(loop.governor.calls.length, 3);
		const transcripts = readTranscripts(loop.fixture.artifacts.artifactsDir);
		assert.equal(transcripts.length, 3);
		assert.equal(transcripts.every((item) => item.passed === false), true);
	} finally {
		await loop.close();
	}
});

test('a written missing spec replaces the stale verification block', async () => {
	const missing = 'src/missing.spec.ts';
	const feedback =
		`ac-coverage failed\n[execution-evidence] Touched test file is missing from the worktree: '${missing}'`;
	let checks = 0;
	const loop = openLoop({
		label: 'stale-missing-file',
		script: [
			{ action: { kind: 'complete', summary: 'no file' } },
			{
				action: {
					kind: 'tool_call',
					toolName: 'write_file',
					parameters: {
						path: missing,
						content: 'export const ready = true;\n',
						acknowledgedShrink: false,
					},
				},
			},
			{ action: { kind: 'tool_call', toolName: 'read_file', parameters: { path: missing } } },
			{ action: { kind: 'complete', summary: 'done' } },
		],
		completionValidator: () => {
			checks += 1;
			if (checks === 1) return { pass: false, summary: feedback };
			return { pass: true, summary: 'ok' };
		},
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'completed');
		const beforeWrite = loop.governor.calls[1].promptBlocks.at(-1);
		const afterWrite = loop.governor.calls[2].promptBlocks.at(-1);
		const afterRead = loop.governor.calls[3].promptBlocks.at(-1);
		assert.equal(beforeWrite, `### Verification\n${feedback}`);
		assert.match(afterWrite, /A tool result has since written that file/);
		assert.equal(afterWrite.includes('missing from the worktree'), false);
		assert.equal(afterRead, afterWrite);
	} finally {
		await loop.close();
	}
});

test('a page write failure stops the attempt and is not retried', async () => {
	const loop = openLoop({
		label: 'page-write',
		script: [
			{ action: { kind: 'tool_call', toolName: 'read_file', parameters: { path: 'big.txt' } } },
			{ action: { kind: 'complete', summary: 'must not run' } },
		],
	});
	try {
		fs.writeFileSync(path.join(loop.worktreeDir, '.tmp'), 'not-a-directory');
		fs.writeFileSync(path.join(loop.worktreeDir, 'big.txt'), 'y'.repeat(40_000));
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'failed');
		assert.equal(result.failureReason, 'page-write-failed');
		assert.equal(loop.governor.calls.length, 1);
		assert.equal(readTranscripts(loop.fixture.artifacts.artifactsDir).length, 1);
	} finally {
		await loop.close();
	}
});

test('acceptance evidence binds the evidence command JSON when verification output is paged', async () => {
	const title = 'observable behavior @ac AC-21';
	const testPath = 'apps/services/example/src/anchor.spec.ts';
	const verification = ['pnpm', '--filter', '@fitness-app/example', 'test'];
	const evidence = [
		'pnpm',
		'--filter',
		'@fitness-app/example',
		'run',
		'test:unit',
		'src/anchor.spec.ts',
		'--reporter=json',
	];
	const report = JSON.stringify({
		testResults: [{ assertionResults: [{ status: 'passed', title }] }],
	});
	const calls = [];
	const loop = openLoop({
		label: 'evidence-json',
		script: [{ action: { kind: 'complete', summary: 'done' } }],
		execCli: (command, args, options) => {
			calls.push({ command, args, ci: options?.env?.CI ?? null });
			if (args?.includes('--reporter=json')) return report;
			return sizedLog(40_000);
		},
	});
	const absolutePath = path.join(loop.worktreeDir, testPath);
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	fs.writeFileSync(
		absolutePath,
		`it('${title}', () => { expect(true).toBe(true); });\n`,
	);
	loop.executor.completionValidator = createAcceptanceEvidenceValidator({
		acceptanceCriteria: [
			'AC-21: The anchor stays. Given a stored anchor. Then the helper returns that anchor.',
		],
		worktreeDir: loop.worktreeDir,
		authoredTestPaths: [testPath],
		allowedPathPrefixes: ['apps/services/example'],
		acceptanceEvidenceCommand: evidence,
	});
	try {
		const result = await loop.executor.execute(
			loopInput(loop.worktreeDir, {
				verificationCommands: [verification],
				acceptanceEvidenceCommand: evidence,
				acceptanceCriteria: [
					'AC-21: The anchor stays. Given a stored anchor. Then the helper returns that anchor.',
				],
			}),
		);
		assert.equal(result.status, 'completed');
		assert.equal(result.failureReason, null);
		assert.equal(loop.governor.calls.length, 1);
		assert.deepEqual(
			calls.map((call) => [call.command, ...call.args]),
			[verification, evidence],
		);
		assert.equal(calls[0].ci, null);
		assert.equal(calls[1].ci, 'true');
		const prompt = loop.governor.calls[0].prompt;
		assert.equal(prompt.includes(report), false);
		assert.equal(prompt.includes('"testResults"'), false);
	} finally {
		await loop.close();
	}
});

test('a failed evidence command retries as verification-failed', async () => {
	const evidence = ['pnpm', '--filter', '@fitness-app/example', 'run', 'test:unit', '--reporter=json'];
	const loop = openLoop({
		label: 'evidence-fail',
		script: [
			{ action: { kind: 'complete', summary: 'done' } },
			{ action: { kind: 'complete', summary: 'done' } },
			{ action: { kind: 'complete', summary: 'done' } },
		],
		execCli: (command, args) => {
			if (args?.includes('--reporter=json')) throw failedCommand('');
			return '';
		},
	});
	try {
		const result = await loop.executor.execute(
			loopInput(loop.worktreeDir, { acceptanceEvidenceCommand: evidence }),
		);
		assert.equal(result.status, 'failed');
		assert.equal(result.failureReason, 'verification-failed');
		assert.equal(result.attempts, 3);
	} finally {
		await loop.close();
	}
});

test('empty evidence stdout fails the acceptance check', async () => {
	const title = 'observable behavior @ac AC-21';
	const testPath = 'apps/services/example/src/anchor.spec.ts';
	const evidence = ['pnpm', 'run', 'test:unit', '--reporter=json'];
	const loop = openLoop({
		label: 'evidence-empty',
		script: [
			{ action: { kind: 'complete', summary: 'done' } },
			{ action: { kind: 'complete', summary: 'done' } },
			{ action: { kind: 'complete', summary: 'done' } },
		],
		execCli: () => '',
	});
	const absolutePath = path.join(loop.worktreeDir, testPath);
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	fs.writeFileSync(absolutePath, `it('${title}', () => { expect(true).toBe(true); });\n`);
	loop.executor.completionValidator = createAcceptanceEvidenceValidator({
		acceptanceCriteria: [
			'AC-21: The anchor stays. Given a stored anchor. Then the helper returns that anchor.',
		],
		worktreeDir: loop.worktreeDir,
		authoredTestPaths: [testPath],
		allowedPathPrefixes: ['apps/services/example'],
		acceptanceEvidenceCommand: evidence,
	});
	try {
		const result = await loop.executor.execute(
			loopInput(loop.worktreeDir, { acceptanceEvidenceCommand: evidence }),
		);
		assert.equal(result.status, 'failed');
		assert.equal(result.failureReason, 'evidence-failed');
		assert.match(loop.governor.calls[1].prompt, /execution-evidence/);
	} finally {
		await loop.close();
	}
});

test('@ac AC-02 verification retries preserve compacted tool history instead of resetting with amnesia', async () => {
	let checks = 0;
	const loop = openLoop({
		label: 'preserve-history-across-attempts',
		script: [
			{
				action: {
					kind: 'tool_call',
					toolName: 'write_file',
					parameters: { path: 'src/feature.ts', content: 'export const x = 1;\n', acknowledgedShrink: false },
				},
			},
			{ action: { kind: 'complete', summary: 'attempt 1 complete' } },
			{ action: { kind: 'complete', summary: 'attempt 2 complete' } },
		],
		execCli: () => {
			checks += 1;
			if (checks === 1) throw failedCommand('attempt 1 test failed');
			return '';
		},
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'completed');
		assert.equal(result.attempts, 2);
		const attempt2Prompt = loop.governor.calls[2].prompt;
		assert.match(attempt2Prompt, /write_file/);
		assert.match(attempt2Prompt, /src\/feature\.ts/);
		assert.match(attempt2Prompt, /attempt 1 test failed/);
	} finally {
		await loop.close();
	}
});

test('@ac AC-03 @case AC-03.1 two-call AUDIT_REQUIRED gate challenges first clean completion and completes on unchanged second completion', async () => {
	let verifyRuns = 0;
	const loop = openLoop({
		label: 'audit-gate-unchanged',
		script: [
			{ action: { kind: 'complete', summary: 'first complete' } },
			{ action: { kind: 'complete', summary: 'confirmed after audit' } },
		],
		execCli: () => {
			verifyRuns += 1;
			return 'ok';
		},
	});
	try {
		const targetFile = path.join(loop.worktreeDir, 'src/item.ts');
		fs.mkdirSync(path.dirname(targetFile), { recursive: true });
		fs.writeFileSync(targetFile, 'export const item = 1;\n');
		const result = await loop.executor.execute(
			loopInput(loop.worktreeDir, {
				authoredPaths: ['src/item.ts'],
				auditGate: true,
			}),
		);
		assert.equal(result.status, 'completed');
		assert.equal(result.attempts, 1);
		assert.equal(loop.governor.calls.length, 2);
		assert.equal(verifyRuns, 1);
		assert.match(loop.governor.calls[1].prompt, /AUDIT_REQUIRED/);
	} finally {
		await loop.close();
	}
});

test('@ac AC-03 @case AC-03.2 editing a file during the audit turn invalidates the digest and re-runs verification on the next complete', async () => {
	let verifyRuns = 0;
	const loop = openLoop({
		label: 'audit-gate-edited',
		script: [
			{ action: { kind: 'complete', summary: 'first complete' } },
			{
				action: {
					kind: 'tool_call',
					toolName: 'write_file',
					parameters: { path: 'src/item.ts', content: 'export const item = 2;\n', acknowledgedShrink: false },
				},
			},
			{ action: { kind: 'complete', summary: 'complete after audit edit' } },
		],
		execCli: () => {
			verifyRuns += 1;
			return 'ok';
		},
	});
	try {
		const targetFile = path.join(loop.worktreeDir, 'src/item.ts');
		fs.mkdirSync(path.dirname(targetFile), { recursive: true });
		fs.writeFileSync(targetFile, 'export const item = 1;\n');
		const result = await loop.executor.execute(
			loopInput(loop.worktreeDir, {
				authoredPaths: ['src/item.ts'],
				auditGate: true,
			}),
		);
		assert.equal(result.status, 'completed');
		assert.equal(result.attempts, 1);
		assert.equal(verifyRuns, 2);
	} finally {
		await loop.close();
	}
});
