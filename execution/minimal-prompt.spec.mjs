import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
	MinimalExecutor,
} from './minimal-executor.ts';
import {
	compactToolCallEntry,
	formatAllowlistedCommands,
	formatWorkingSetBlock,
	promptBlocks,
} from './minimal-prompt.ts';
import {
	computeWorktreeDigest,
} from './minimal-verification.ts';
import {
	replaceSnapshotRangeTool,
} from './tool-mutations.ts';
import {
	readFileTool,
} from './tool-read.ts';
import {
	loopInput,
	openLoop,
} from '../testing/minimal-executor-fixtures.mjs';

function createTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-tools-test-'));
}

test('later prompts keep earlier tool-result blocks byte-identical', async () => {
	const read = {
		action: { kind: 'tool_call', toolName: 'read_file', parameters: { path: 'note.txt' } },
	};
	const loop = openLoop({
		label: 'cache-blocks',
		script: [structuredClone(read), structuredClone(read), { action: { kind: 'complete', summary: 'done' } }],
	});
	try {
		fs.writeFileSync(path.join(loop.worktreeDir, 'note.txt'), 'same-bytes\n');
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'completed');
		assert.equal(loop.governor.calls[0].promptBlocks, undefined);
		const second = loop.governor.calls[1];
		const third = loop.governor.calls[2];
		assert.equal(second.promptBlocks.join('\n'), second.prompt);
		assert.equal(third.promptBlocks.join('\n'), third.prompt);
		assert.equal(third.promptBlocks[0], second.promptBlocks[0]);
		assert.equal(third.promptBlocks[1], second.promptBlocks[1]);
		assert.equal(third.promptBlocks.length, second.promptBlocks.length + 1);
		assert.match(third.prompt, /### Tool results/);
		assert.match(third.prompt, /same-bytes/);
	} finally {
		await loop.close();
	}
});

test('verification feedback stays outside the cached tool prefix', async () => {
	let checks = 0;
	const read = {
		action: { kind: 'tool_call', toolName: 'read_file', parameters: { path: 'note.txt' } },
	};
	const loop = openLoop({
		label: 'cache-tail',
		script: [
			{ action: { kind: 'complete', summary: 'not yet' } },
			structuredClone(read),
			structuredClone(read),
			{ action: { kind: 'complete', summary: 'done' } },
		],
		completionValidator: () => {
			checks += 1;
			if (checks === 1) return { pass: false, summary: 'missing case ids' };
			return { pass: true, summary: 'ok' };
		},
	});
	try {
		fs.writeFileSync(path.join(loop.worktreeDir, 'note.txt'), 'same-bytes\n');
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'completed');
		assert.equal(loop.governor.calls[0].promptCacheBreakpoint, undefined);
		const feedbackOnly = loop.governor.calls[1];
		const firstTool = loop.governor.calls[2];
		const secondTool = loop.governor.calls[3];
		assert.equal(feedbackOnly.promptCacheBreakpoint, 0);
		assert.match(feedbackOnly.promptBlocks.at(-1), /^### Verification\nmissing case ids$/);
		assert.equal(firstTool.promptCacheBreakpoint, 1);
		assert.equal(secondTool.promptCacheBreakpoint, 2);
		assert.equal(secondTool.promptBlocks[0], firstTool.promptBlocks[0]);
		assert.equal(secondTool.promptBlocks[1], firstTool.promptBlocks[1]);
		assert.equal(secondTool.promptBlocks.at(-1), firstTool.promptBlocks.at(-1));
		assert.equal(secondTool.promptBlocks.length, firstTool.promptBlocks.length + 1);
		assert.match(secondTool.prompt, /### Tool results/);
		assert.match(secondTool.prompt, /same-bytes/);
	} finally {
		await loop.close();
	}
});

test('acceptance criteria carry the case citation rule in the standing prompt', () => {
	const executor = new MinimalExecutor({});
	const withCases = executor.promptBlocks({
		taskId: 'weather-capture-task',
		acceptanceCriteria: [
			'AC-04: Archive failure does not fail the write. Given the archive port times out. Then weather.status is unavailable. Cases: AC-04.1: a timeout stores reason timeout; AC-04.2: HTTP 429 stores reason archive.',
			'AC-06: Overview keeps the summary. Given a ready snapshot. Then the overview omits series.',
		],
	}, '', []);
	const head = withCases[0];
	const criteriaAt = head.indexOf('1. AC-04: Archive failure');
	const ruleAt = head.indexOf('Each case of AC-04');
	assert.ok(criteriaAt >= 0);
	assert.ok(ruleAt > criteriaAt);
	assert.match(head, /it\('@ac AC-04 @case AC-04\.1 \.\.\.'\)/);
	assert.match(head, /The case ids are AC-04\.1, AC-04\.2/);
	assert.match(head, /it\('@ac AC-06 \.\.\.'\)/);
	assert.match(head, /AC-06 has no cases\. Do not add @case/);
	assert.match(head, /direct expect\(/);
	assert.match(head, /\$\{caseId\} does not count/);
	assert.equal(head.includes('AC-01.1'), false);
	const withoutCases = executor.promptBlocks({ taskId: 'no-criteria', acceptanceCriteria: [] }, '', []);
	assert.equal(withoutCases[0].includes('Do not add @case'), false);
	assert.equal(withoutCases[0].includes('AC-01.1'), false);
});

test('@ac AC-01 @case AC-01.1 @case AC-01.2 @case AC-01.3 prompt lists allowlisted commands, renders working set, and compacts stale payloads', async () => {
	const bigPayload = `export const body = '${'Z'.repeat(5_000)}';\n`;
	const loop = openLoop({
		label: 'working-set-compaction',
		script: [
			{ action: { kind: 'tool_call', toolName: 'read_file', parameters: { path: 'src/target.ts' } } },
			{
				action: {
					kind: 'tool_call',
					toolName: 'write_file',
					parameters: { path: 'src/target.ts', content: bigPayload, acknowledgedShrink: true },
				},
			},
			{ action: { kind: 'tool_call', toolName: 'list_dir', parameters: { path: 'src' } } },
			{ action: { kind: 'complete', summary: 'done' } },
		],
	});
	try {
		const targetFile = path.join(loop.worktreeDir, 'src/target.ts');
		fs.mkdirSync(path.dirname(targetFile), { recursive: true });
		fs.writeFileSync(targetFile, 'export const initial = 1;\n'.repeat(5));
		const result = await loop.executor.execute(
			loopInput(loop.worktreeDir, {
				targetedVerificationCommand: ['pnpm', '--filter', 'pkg', 'run', 'test:unit', 'src/target.spec.ts'],
				generatorCommand: ['pnpm', '--filter', 'pkg', 'run', 'build:contracts'],
				authoredPaths: ['src/target.ts'],
			}),
		);
		assert.equal(result.status, 'completed');
		const finalPrompt = loop.governor.calls[3].prompt;
		assert.match(finalPrompt, /Allowlisted commands:/);
		assert.match(finalPrompt, /pnpm --filter pkg run test:unit src\/target\.spec\.ts/);
		assert.match(finalPrompt, /pnpm --filter pkg run build:contracts/);
		assert.match(finalPrompt, /### Working set/);
		assert.match(finalPrompt, /expected_file_hash:/);
		const toolResultsBlock = loop.governor.calls[3].promptBlocks.slice(1, 4).join('\n');
		assert.equal(toolResultsBlock.includes('Z'.repeat(5_000)), false);
		assert.match(toolResultsBlock, /"contentBytes":/);
		assert.match(toolResultsBlock, /\[collapsed: superseded by later tool call on src\/target\.ts\]/);
	} finally {
		await loop.close();
	}
});

test('@ac AC-01 @case AC-01.1 formatAllowlistedCommands renders targeted, verification, and generator commands once', () => {
	const rendered = formatAllowlistedCommands({
		targetedVerificationCommand: ['pnpm', '--filter', 'pkg', 'run', 'test:unit', 'src/a.spec.ts'],
		verificationCommands: [
			['pnpm', '--filter', 'pkg', 'test'],
			['pnpm', '--filter', 'pkg', 'run', 'build'],
		],
		generatorCommand: ['pnpm', '--filter', 'pkg', 'run', 'build:contracts'],
	});
	assert.match(rendered, /Allowlisted commands:/);
	assert.match(rendered, /- pnpm --filter pkg run test:unit src\/a\.spec\.ts/);
	assert.match(rendered, /- pnpm --filter pkg test/);
	assert.match(rendered, /- pnpm --filter pkg run build/);
	assert.match(rendered, /- pnpm --filter pkg run build:contracts/);
	assert.equal(formatAllowlistedCommands({}), '');
});

test('@ac AC-01 @case AC-01.2 compactToolCallEntry elides raw write and replace bodies while keeping hash and byteLength', () => {
	const bigContent = 'A'.repeat(5_000);
	const writeCall = {
		toolName: 'write_file',
		parameters: { path: 'src/a.ts', content: bigContent, acknowledgedShrink: false },
		result: { written: true, byteLength: 5_000, hash: 'h1' },
	};
	const replaceCall = {
		toolName: 'replace_in_file',
		parameters: {
			path: 'src/a.ts',
			old_string: 'old-body',
			new_string: 'B'.repeat(2_000),
			expected_file_hash: 'h1',
		},
		result: { replaced: true, byteLength: 2_000, hash: 'h2' },
	};
	const compactedWrite = compactToolCallEntry(writeCall, 0, [writeCall, replaceCall]);
	assert.equal(compactedWrite.includes(bigContent), false);
	assert.match(compactedWrite, /"contentBytes":5000/);
	assert.match(compactedWrite, /"hash":"h1"/);
	const compactedReplace = compactToolCallEntry(replaceCall, 1, [writeCall, replaceCall]);
	assert.equal(compactedReplace.includes('old-body'), false);
	assert.match(compactedReplace, /"new_stringBytes":2000/);
	assert.match(compactedReplace, /"hash":"h2"/);
});

test('@ac AC-01 @case AC-01.3 superseded read_file outputs collapse and formatWorkingSetBlock shows current expected_file_hash', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = path.join(tempDir, 'worktree');
		const file = path.join(worktreeDir, 'src/a.ts');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, 'export const v = 2;\n');
		const read1 = {
			toolName: 'read_file',
			parameters: { path: 'src/a.ts' },
			result: { content: 'export const v = 1;\n'.repeat(10), hash: 'old-hash', totalLines: 10 },
		};
		const write1 = {
			toolName: 'write_file',
			parameters: { path: 'src/a.ts', content: 'export const v = 2;\n' },
			result: { written: true, hash: 'new-hash' },
		};
		const collapsed = compactToolCallEntry(read1, 0, [read1, write1], {
			authoredPaths: ['src/a.ts'],
		});
		assert.match(collapsed, /\[collapsed: superseded by later tool call on src\/a\.ts\]/);
		const workingSet = formatWorkingSetBlock({
			worktreeDir,
			authoredPaths: ['src/a.ts'],
		});
		const expectedHash = crypto.createHash('sha256').update('export const v = 2;\n').digest('hex');
		assert.match(workingSet, new RegExp(`expected_file_hash: ${expectedHash}`));
		assert.match(workingSet, /export const v = 2;/);
		const d1 = computeWorktreeDigest(worktreeDir, ['src/a.ts']);
		fs.writeFileSync(file, 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
		const rangedRead = readFileTool(
			{ path: 'src/a.ts', start_line: 2, end_line: 3 },
			{ worktreeDir, pageOverflow: true },
		);
		const replacedRange = replaceSnapshotRangeTool(
			{
				path: 'src/a.ts',
				expected_file_hash: rangedRead.hash,
				start_line: 2,
				end_line: 3,
				new_string: 'export const b = 20;\n',
				acknowledgedShrink: false,
			},
			{ worktreeDir, allowedPathPrefixes: ['src'] },
		);
		assert.equal(replacedRange.replaced, true);
		const d2 = computeWorktreeDigest(worktreeDir, ['src/a.ts']);
		assert.notEqual(d1, d2);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-04 @case AC-04.4 promptBlocks on the class matches the prompt module', () => {
	const input = {
		taskId: 'task-a',
		specSummary: 'Ship the slice',
		acceptanceCriteria: ['AC-04: the verification log survives. Cases: AC-04.1: inline log'],
		verificationCommands: [['pnpm', 'run', 'agent:test-sdlc']],
		allowedPackages: ['tools'],
		agentsMd: 'Use pnpm',
	};
	const executor = new MinimalExecutor({
		governor: {},
		artifactStore: {},
		roleRegistry: {},
	});
	assert.deepEqual(executor.promptBlocks(input, '', []), promptBlocks(input, '', []));
});
