import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {
	WHOLE_FILE_READ_BYTE_CAP,
	isWholeFileReadResult,
	leanWholeFileRequested,
	repeatedReadWindowError,
	retainedMissingPathEntries,
	retainedPassingCommandEntries,
	retainedReadWindowEntries,
	selectReadWindow,
} from './read-window.ts';

test('repeatedReadWindowError rejects the same truncated window and allows the next start_line', () => {
	const content = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
	const first = selectReadWindow(content, {}, 50);
	assert.equal(first.truncated, true);
	const history = [
		{
			toolName: 'read_file',
			parameters: { path: 'src/page.spec.tsx' },
			result: {
				shownStartLine: first.shownStartLine,
				shownEndLine: first.shownEndLine,
			},
		},
	];
	const repeated = repeatedReadWindowError({
		content,
		normalizedPath: 'src/page.spec.tsx',
		parameters: {},
		toolHistory: history,
		charCap: 50,
	});
	assert.match(repeated, new RegExp(`start_line ${first.shownEndLine}`));
	assert.match(repeated, /Do not repeat this window/);
	assert.equal(
		repeatedReadWindowError({
			content,
			normalizedPath: 'src/page.spec.tsx',
			parameters: { start_line: first.shownEndLine },
			toolHistory: history,
			charCap: 50,
		}),
		null,
	);
	const afterMutation = [
		...history,
		{
			toolName: 'replace_in_file',
			parameters: { path: 'src/page.spec.tsx' },
			result: { error: 'old_string not found' },
		},
	];
	assert.equal(
		repeatedReadWindowError({
			content,
			normalizedPath: 'src/page.spec.tsx',
			parameters: {},
			toolHistory: afterMutation,
			charCap: 50,
		}),
		null,
	);
	assert.match(
		repeatedReadWindowError({
			content,
			normalizedPath: 'src/page.spec.tsx',
			parameters: {},
			toolHistory: [
				...afterMutation,
				{
					toolName: 'read_file',
					parameters: { path: 'src/page.spec.tsx' },
					result: {
						shownStartLine: first.shownStartLine,
						shownEndLine: first.shownEndLine,
					},
				},
			],
			charCap: 50,
		}) ?? '',
		/Do not repeat this window/,
	);
});

test('repeatedReadWindowError rejects re-reading an unmutated file and allows refresh read after mutation', () => {
	const contentA = 'file A content';
	const historyWithoutMutation = [
		{
			toolName: 'read_file',
			parameters: { path: 'src/fileA.ts' },
			result: { shownStartLine: 1, shownEndLine: 2, totalLines: 1 },
		},
		{
			toolName: 'read_file',
			parameters: { path: 'src/fileB.ts' },
			result: { shownStartLine: 1, shownEndLine: 2, totalLines: 1 },
		},
	];
	// Re-reading fileA without mutation is rejected
	const err = repeatedReadWindowError({
		content: contentA,
		normalizedPath: 'src/fileA.ts',
		parameters: {},
		toolHistory: historyWithoutMutation,
	});
	assert.match(err, /already read in full/);

	// But re-reading fileA after a mutation on fileA is allowed
	const historyWithMutation = [
		...historyWithoutMutation,
		{
			toolName: 'replace_in_file',
			parameters: { path: 'src/fileA.ts' },
			result: { success: true },
		},
	];
	const errAfterMutation = repeatedReadWindowError({
		content: contentA,
		normalizedPath: 'src/fileA.ts',
		parameters: {},
		toolHistory: historyWithMutation,
	});
	assert.equal(errAfterMutation, null);
});

test('retainedReadWindowEntries keeps distinct windows and drops them after a mutation', () => {
	const read = (start, end, body) => ({
		toolName: 'read_file',
		parameters: { path: 'src/big.ts', start_line: start },
		result: { content: body, shownStartLine: start, shownEndLine: end, totalLines: 900 },
	});
	const history = [
		read(1, 178, 'one'),
		read(178, 352, 'two'),
		{ toolName: 'read_file', parameters: { path: 'src/big.ts' }, result: { error: 'missing' } },
		read(1, 178, 'one-again'),
	];
	assert.deepEqual(
		retainedReadWindowEntries(history).map((entry) => entry.result.content),
		['two', 'one-again'],
	);
	assert.deepEqual(retainedReadWindowEntries(null), []);
	assert.deepEqual(retainedReadWindowEntries([]), []);

	const mutated = [
		...history,
		{ toolName: 'replace_in_file', parameters: { path: 'src/big.ts' }, result: { error: 'stale' } },
		read(1, 178, 'after-edit'),
	];
	assert.deepEqual(
		retainedReadWindowEntries(mutated).map((entry) => entry.result.content),
		['after-edit'],
	);

	const five = [1, 2, 3, 4, 5].map((n) => read(n * 100, n * 100 + 50, `w${n}`));
	assert.deepEqual(
		retainedReadWindowEntries(five).map((entry) => entry.result.content),
		['w2', 'w3', 'w4', 'w5'],
	);
});

test('leanWholeFileRequested returns an authored head read at the byte cap and windows the rest', () => {
	const file = 'services/authentication/src/user-auth.controller.ts';
	const base = {
		capabilityIsLean: true,
		authoredPaths: [file],
		path: file,
	};
	assert.equal(leanWholeFileRequested({ ...base, parameters: {}, byteLength: 100 }), true);
	assert.equal(
		leanWholeFileRequested({ ...base, parameters: { start_line: 1 }, byteLength: 0 }),
		true,
	);
	assert.equal(
		leanWholeFileRequested({
			...base,
			parameters: { start_line: 1 },
			byteLength: WHOLE_FILE_READ_BYTE_CAP,
		}),
		true,
	);
	assert.equal(
		leanWholeFileRequested({
			...base,
			parameters: { start_line: 1 },
			byteLength: WHOLE_FILE_READ_BYTE_CAP + 1,
		}),
		false,
	);
	assert.equal(
		leanWholeFileRequested({ ...base, parameters: { start_line: 2 }, byteLength: 100 }),
		false,
	);
	assert.equal(
		leanWholeFileRequested({
			...base,
			parameters: { start_line: 1, end_line: 10 },
			byteLength: 100,
		}),
		false,
	);
	assert.equal(
		leanWholeFileRequested({ ...base, capabilityIsLean: false, parameters: {}, byteLength: 100 }),
		false,
	);
	assert.equal(
		leanWholeFileRequested({ ...base, authoredPaths: [], parameters: { start_line: 1 }, byteLength: 100 }),
		false,
	);
	assert.equal(
		leanWholeFileRequested({
			...base,
			authoredPaths: ['services/authentication/src'],
			path: 'services/authentication/src/nested/user-auth.controller.ts',
			parameters: { start_line: 1 },
			byteLength: 10,
		}),
		true,
	);
});

test('repeatedReadWindowError rejects any later read after a full file and allows one refresh after a mutation', () => {
	const content = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
	const full = {
		toolName: 'read_file',
		parameters: { path: 'src/page.ts', start_line: 1 },
		result: { shownStartLine: 1, shownEndLine: 21, totalLines: 20 },
	};
	const blocked = repeatedReadWindowError({
		content,
		normalizedPath: 'src/page.ts',
		parameters: { start_line: 8 },
		toolHistory: [full],
	});
	assert.match(blocked, /already read in full/);
	assert.match(blocked, /Do not read it again/);
	assert.equal(
		repeatedReadWindowError({
			content,
			normalizedPath: 'src/page.ts',
			parameters: { start_line: 8 },
			toolHistory: [
				full,
				{
					toolName: 'replace_in_file',
					parameters: { path: 'src/page.ts' },
					result: { error: 'stale' },
				},
			],
		}),
		null,
	);
});

test('isWholeFileReadResult accepts a full read at the cap and rejects a window', () => {
	assert.equal(
		isWholeFileReadResult({
			shownStartLine: 1,
			shownEndLine: 2,
			totalLines: 1,
			truncated: false,
			byteLength: 0,
			content: '',
		}),
		true,
	);
	assert.equal(
		isWholeFileReadResult({
			shownStartLine: 1,
			shownEndLine: 3,
			totalLines: 2,
			truncated: false,
			byteLength: WHOLE_FILE_READ_BYTE_CAP,
			content: 'a\nb',
		}),
		true,
	);
	assert.equal(
		isWholeFileReadResult({
			shownStartLine: 1,
			shownEndLine: 3,
			totalLines: 2,
			truncated: false,
			byteLength: WHOLE_FILE_READ_BYTE_CAP + 1,
			content: 'a\nb',
		}),
		false,
	);
	assert.equal(
		isWholeFileReadResult({
			shownStartLine: 1,
			shownEndLine: 178,
			totalLines: 908,
			truncated: true,
			byteLength: 1000,
			content: 'window',
		}),
		false,
	);
	assert.equal(isWholeFileReadResult(null), false);
	assert.equal(
		isWholeFileReadResult({
			error: 'missing',
			shownStartLine: 1,
			shownEndLine: 2,
			totalLines: 1,
		}),
		false,
	);
});

test('retainedMissingPathEntries keeps a candidate until it is read or the missing path is written', () => {
	const miss = {
		toolName: 'read_file',
		parameters: { path: 'apps/wrong/authentication.service.ts' },
		result: {
			error: 'missing',
			candidatePath: 'services/authentication/src/authentication.service.ts',
		},
	};
	assert.equal(retainedMissingPathEntries([miss])[0], miss);
	assert.deepEqual(retainedMissingPathEntries(null), []);
	assert.deepEqual(
		retainedMissingPathEntries([{ ...miss, result: { error: 'missing' } }]),
		[],
	);
	const read = {
		toolName: 'read_file',
		parameters: { path: 'services/authentication/src/authentication.service.ts' },
		result: { content: 'class', shownStartLine: 1, shownEndLine: 2 },
	};
	assert.deepEqual(retainedMissingPathEntries([miss, read]), []);
	const write = {
		toolName: 'write_file',
		parameters: { path: 'apps/wrong/authentication.service.ts' },
		result: { written: true },
	};
	assert.deepEqual(retainedMissingPathEntries([miss, write]), []);
});

test('retainedPassingCommandEntries keeps the latest of each argv including a failure', () => {
	const pass = {
		toolName: 'run_allowlisted_command',
		parameters: { command: 'pnpm', args: ['run', 'quality:affected'] },
		result: { exitCode: 0 },
	};
	const fail = {
		toolName: 'run_allowlisted_command',
		parameters: { command: 'pnpm', args: ['--filter', 'pkg', 'run', 'check:contract-drift'] },
		result: { exitCode: 1 },
	};
	const again = { ...pass, result: { exitCode: 1 } };
	assert.deepEqual(retainedPassingCommandEntries([pass, fail, again]), [again, fail]);
	assert.deepEqual(retainedPassingCommandEntries([]), []);
});
