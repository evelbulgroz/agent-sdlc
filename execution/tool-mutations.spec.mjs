import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
	readFileTool,
} from './tool-read.ts';
import {
	deleteFileTool,
	replaceInFileTool,
	replaceSnapshotRangeTool,
	writeFileTool,
} from './tool-mutations.ts';
import {
	executeTool,
} from './tools.ts';

function createTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-tools-test-'));
}

test('writeFileTool rejects shrinking an existing large file', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPathPrefixes = ['apps/services/conditioning'];
		const original = Array.from({ length: 80 }, (_, i) => `export const n${i} = ${i};`).join('\n');
		writeFileTool(
			{ path: 'apps/services/conditioning/src/big.ts', content: original },
			{ worktreeDir, allowedPathPrefixes },
		);
		assert.throws(
			() =>
				writeFileTool(
					{
						path: 'apps/services/conditioning/src/big.ts',
						content: 'export const n0 = 0;\n',
					},
					{ worktreeDir, allowedPathPrefixes },
				),
			(err) =>
				err.code === 'INVALID_INPUT' && /shrinks the file/.test(err.message),
		);
		const kept = readFileTool(
			{ path: 'apps/services/conditioning/src/big.ts' },
			{ worktreeDir },
		);
		assert.equal(kept.content, original);

		const additive = `${original}\nexport const extra = true;\n`;
		const written = writeFileTool(
			{ path: 'apps/services/conditioning/src/big.ts', content: additive },
			{ worktreeDir, allowedPathPrefixes },
		);
		assert.equal(written.written, true);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-07 write_file and replace_snapshot_range accept an explicitly acknowledged shrink', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPathPrefixes = ['apps/services/conditioning'];
		const original = Array.from({ length: 80 }, (_, i) => `export const n${i} = ${i};`).join('\n');
		const relPath = 'apps/services/conditioning/src/shrinkable.ts';

		writeFileTool(
			{ path: relPath, content: original },
			{ worktreeDir, allowedPathPrefixes },
		);

		// @case AC-07.1: write_file still rejects an unacknowledged shrink.
		assert.throws(
			() =>
				writeFileTool(
					{ path: relPath, content: 'export const n0 = 0;\n' },
					{ worktreeDir, allowedPathPrefixes },
				),
			(err) => err.code === 'INVALID_INPUT' && /shrinks the file/.test(err.message),
		);

		// @case AC-07.2: write_file accepts the same shrink once acknowledged, and
		// records an acknowledgedShrink diagnostic flag on the result.
		const written = writeFileTool(
			{ path: relPath, content: 'export const n0 = 0;\n', acknowledgedShrink: true },
			{ worktreeDir, allowedPathPrefixes },
		);
		assert.equal(written.written, true);
		assert.equal(written.acknowledgedShrink, true);
		const afterShrink = readFileTool({ path: relPath }, { worktreeDir });
		assert.equal(afterShrink.content, 'export const n0 = 0;\n');

		// @case AC-07.3: replace_snapshot_range follows the same acknowledgment contract.
		writeFileTool(
			{ path: relPath, content: original, acknowledgedShrink: true },
			{ worktreeDir, allowedPathPrefixes },
		);
		const beforeRangeShrink = readFileTool({ path: relPath }, { worktreeDir });
		assert.throws(
			() =>
				replaceSnapshotRangeTool(
					{
						path: relPath,
						expected_file_hash: beforeRangeShrink.hash,
						start_line: 1,
						end_line: 80,
						new_string: 'export const n0 = 0;',
					},
					{ worktreeDir, allowedPathPrefixes },
				),
			(err) => err.code === 'INVALID_INPUT' && /shrinks the file/.test(err.message),
		);
		const rangeShrunk = replaceSnapshotRangeTool(
			{
				path: relPath,
				expected_file_hash: beforeRangeShrink.hash,
				start_line: 1,
				end_line: 80,
				new_string: 'export const n0 = 0;',
				acknowledgedShrink: true,
			},
			{ worktreeDir, allowedPathPrefixes },
		);
		assert.equal(rangeShrunk.replaced, true);
		assert.equal(rangeShrunk.acknowledgedShrink, true);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('replaceInFileTool patches a unique snippet and rejects missing or ambiguous old_string', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPathPrefixes = ['apps/services/conditioning'];
		const original = 'export class Foo {\n\tbar() { return 1; }\n\tbaz() { return 2; }\n}\n';
		writeFileTool(
			{ path: 'apps/services/conditioning/src/foo.ts', content: original },
			{ worktreeDir, allowedPathPrefixes },
		);
		const replaced = replaceInFileTool(
			{
				path: 'apps/services/conditioning/src/foo.ts',
				old_string: '\tbar() { return 1; }',
				new_string: '\tbar() { return 1; }\n\tqux() { return 3; }',
				expected_file_hash: crypto.createHash('sha256').update(original, 'utf8').digest('hex'),
			},
			{ worktreeDir, allowedPathPrefixes },
		);
		assert.equal(replaced.replaced, true);
		const after = readFileTool(
			{ path: 'apps/services/conditioning/src/foo.ts' },
			{ worktreeDir },
		);
		assert.match(after.content, /qux\(\) \{ return 3; \}/);
		assert.match(after.content, /baz\(\) \{ return 2; \}/);

		assert.throws(
			() =>
				replaceInFileTool(
					{
						path: 'apps/services/conditioning/src/foo.ts',
						old_string: '\tbaz() { return 2; }',
						new_string: '\tbaz() { return 4; }',
						expected_file_hash: crypto.createHash('sha256').update(original, 'utf8').digest('hex'),
					},
					{ worktreeDir, allowedPathPrefixes },
				),
			(err) => err.code === 'STALE_FILE_SNAPSHOT' && /changed since read_file/.test(err.message),
		);

		assert.throws(
			() =>
				replaceInFileTool(
					{
						path: 'apps/services/conditioning/src/foo.ts',
						old_string: 'not-in-file',
						new_string: 'x',
					},
					{ worktreeDir, allowedPathPrefixes },
				),
			(err) => err.code === 'INVALID_INPUT' && /not found/.test(err.message),
		);

		assert.throws(
			() =>
				replaceInFileTool(
					{
						path: 'apps/services/conditioning/src/foo.ts',
						old_string: 'baz\\(\\)',
						new_string: 'quux()',
					},
					{ worktreeDir, allowedPathPrefixes },
				),
			(err) => err.code === 'INVALID_INPUT' && /literal text, not regex/.test(err.message),
		);

		assert.throws(
			() =>
				replaceInFileTool(
					{
						path: 'apps/services/conditioning/src/foo.ts',
						old_string: '\tbaz() { return 2; }',
						new_string: '\tbaz() { return 2; }',
					},
					{ worktreeDir, allowedPathPrefixes },
				),
			(err) => err.code === 'INVALID_INPUT' && /no-op/.test(err.message),
		);

		const originalHash = crypto
			.createHash('sha256')
			.update(original, 'utf8')
			.digest('hex');
		assert.throws(
			() =>
				replaceInFileTool(
					{
						path: 'apps/services/conditioning/src/foo.ts',
						old_string: '\tqux() { return 3; }\n',
						new_string: '',
					},
					{ worktreeDir, allowedPathPrefixes, originalContentHash: originalHash },
				),
			(err) => err.code === 'INVALID_INPUT' && /undo a successful earlier edit/.test(err.message),
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('deleteFileTool, listDirTool, and findFilesTool work inside worktree', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPathPrefixes = ['src'];

		writeFileTool({ path: 'src/a.ts', content: 'a' }, { worktreeDir, allowedPathPrefixes });
		writeFileTool({ path: 'src/b.ts', content: 'b' }, { worktreeDir, allowedPathPrefixes });
		writeFileTool({ path: 'src/sub/c.js', content: 'c' }, { worktreeDir, allowedPathPrefixes });

		// List dir
		const list = executeTool({ toolName: 'list_dir', parameters: { path: 'src' }, worktreeDir: worktreeDir });
		assert.deepEqual(list.entries, ['a.ts', 'b.ts', 'sub']);

		// Find files
		const found = executeTool({ toolName: 'find_files', parameters: { pattern: '**/*.ts', path: 'src' }, worktreeDir: worktreeDir });
		assert.deepEqual(found.matches, ['src/a.ts', 'src/b.ts']);

		// Delete file
		const del = deleteFileTool({ path: 'src/a.ts' }, { worktreeDir, allowedPathPrefixes });
		assert.equal(del.deleted, true);

		// Delete already deleted
		const delMissing = deleteFileTool({ path: 'src/a.ts' }, { worktreeDir, allowedPathPrefixes });
		assert.equal(delMissing.deleted, false);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('replaceSnapshotRangeTool applies snapshot-bound half-open line edits', () => {
	const tempDir = createTempDir();
	try {
		const rel = 'src/main.ts';
		const filePath = path.join(tempDir, rel);
		const initial = 'const first = 1;\nconst second = 2;\n';
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, initial);
		const initialHash = crypto.createHash('sha256').update(initial).digest('hex');

		const replaced = replaceSnapshotRangeTool(
			{
				path: rel,
				expected_file_hash: initialHash,
				start_line: 2,
				end_line: 3,
				new_string: 'const second = 3;\n',
			},
			{ worktreeDir: tempDir, allowedPathPrefixes: ['src'] },
		);
		assert.equal(replaced.replaced, true);
		assert.equal(replaced.removedContent, 'const second = 2;\n');
		assert.equal(
			fs.readFileSync(filePath, 'utf8'),
			'const first = 1;\nconst second = 3;\n',
		);

		const inserted = replaceSnapshotRangeTool(
			{
				path: rel,
				expected_file_hash: replaced.hash,
				start_line: 2,
				end_line: 2,
				new_string: 'const inserted = "µ";\n',
			},
			{ worktreeDir: tempDir, allowedPathPrefixes: ['src'] },
		);
		assert.equal(inserted.removedContent, '');
		assert.equal(
			fs.readFileSync(filePath, 'utf8'),
			'const first = 1;\nconst inserted = "µ";\nconst second = 3;\n',
		);
		assert.equal(
			inserted.byteLength,
			Buffer.byteLength(fs.readFileSync(filePath, 'utf8')),
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('replaceSnapshotRangeTool rejects stale, invalid, no-op, and whole-file edits', () => {
	const tempDir = createTempDir();
	try {
		const rel = 'src/main.ts';
		const filePath = path.join(tempDir, rel);
		const initial = 'const first = 1;\nconst second = 2;\n';
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, initial);
		const hash = crypto.createHash('sha256').update(initial).digest('hex');
		const call = (parameters) =>
			replaceSnapshotRangeTool(
				{ path: rel, expected_file_hash: hash, ...parameters },
				{ worktreeDir: tempDir, allowedPathPrefixes: ['src'] },
			);

		assert.throws(
			() =>
				call({
					expected_file_hash: '0'.repeat(64),
					start_line: 1,
					end_line: 1,
					new_string: 'x',
				}),
			(error) => error.code === 'STALE_FILE_SNAPSHOT',
		);
		for (const parameters of [
			{ start_line: 0, end_line: 1, new_string: 'x' },
			{ start_line: 3, end_line: 2, new_string: 'x' },
			{ start_line: 1, end_line: 99, new_string: 'x' },
		]) {
			assert.throws(
				() => call(parameters),
				(error) => error.code === 'INVALID_INPUT',
			);
		}
		assert.throws(
			() =>
				call({
					start_line: 2,
					end_line: 3,
					new_string: 'const second = 2;\n',
				}),
			(error) => error.code === 'INVALID_INPUT' && /no-op/.test(error.message),
		);
		assert.throws(
			() =>
				call({
					start_line: 1,
					end_line: 3,
					new_string: 'replacement\n',
				}),
			(error) =>
				error.code === 'INVALID_INPUT' && /whole file/.test(error.message),
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('deleteFileTool rejects directories and findFilesTool rejects traversal escapes', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPathPrefixes = ['src'];
		fs.mkdirSync(path.join(worktreeDir, 'src/dir'), { recursive: true });

		// deleteFileTool rejects directory
		assert.throws(
			() => deleteFileTool({ path: 'src/dir' }, { worktreeDir, allowedPathPrefixes }),
			(err) => err.code === 'INVALID_INPUT' && err.message.includes('directory'),
		);

		// findFilesTool rejects traversal escapes
		assert.throws(
			() => executeTool({ toolName: 'find_files', parameters: { pattern: '../secret.txt' }, worktreeDir: worktreeDir }),
			(err) => err.code === 'PATH_CONTAINMENT_VIOLATION',
		);
		assert.throws(
			() => executeTool({ toolName: 'find_files', parameters: { pattern: '/etc/passwd' }, worktreeDir: worktreeDir }),
			(err) => err.code === 'PATH_CONTAINMENT_VIOLATION',
		);
		assert.throws(
			() => executeTool({ toolName: 'find_files', parameters: { pattern: 'file\0.txt' }, worktreeDir: worktreeDir }),
			(err) => err.code === 'PATH_CONTAINMENT_VIOLATION',
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
