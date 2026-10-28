import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	readFileTool,
} from './tool-read.ts';
import {
	assertMutatedFileParses,
	replaceInFileTool,
	replaceSnapshotRangeTool,
	writeFileTool,
} from './tool-mutations.ts';

function createTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-tools-test-'));
}

test('@ac AC-01 write_file rejects a mutation that leaves a recognized source file unparseable', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPathPrefixes = ['src'];

		// @case AC-01.1: existing target file with unbalanced-brace content is rejected and left unchanged.
		const existingPath = 'src/existing.ts';
		const original = 'export class Foo {\n  bar() {\n    return 1;\n  }\n}\n';
		writeFileTool({ path: existingPath, content: original }, { worktreeDir, allowedPathPrefixes });
		assert.throws(
			() =>
				writeFileTool(
					{
						path: existingPath,
						content: 'export class Foo {\n  bar() {\n    return 1;\n  }\n',
					},
					{ worktreeDir, allowedPathPrefixes },
				),
			(err) =>
				err.code === 'INVALID_INPUT' &&
				/syntactically unparseable/.test(err.message) &&
				err.metadata.targetPath === existingPath,
		);
		const afterRejection = readFileTool({ path: existingPath }, { worktreeDir });
		assert.equal(afterRejection.content, original);

		// @case AC-01.2: not-yet-existing target path with a truncated function declaration is rejected
		// and the path is never created.
		const newPath = 'src/new-file.ts';
		assert.throws(
			() =>
				writeFileTool(
					{ path: newPath, content: 'export function broken(\n' },
					{ worktreeDir, allowedPathPrefixes },
				),
			(err) => err.code === 'INVALID_INPUT' && /syntactically unparseable/.test(err.message),
		);
		assert.equal(fs.existsSync(path.join(worktreeDir, newPath)), false);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-02 replace_snapshot_range rejects a range replacement whose resulting file is unparseable', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPathPrefixes = ['src'];
		const relPath = 'src/existing.ts';
		const original = 'export class Foo {\n  bar() {\n    return 1;\n  }\n}\n';
		writeFileTool({ path: relPath, content: original }, { worktreeDir, allowedPathPrefixes });
		const { hash } = readFileTool({ path: relPath }, { worktreeDir });

		assert.throws(
			() =>
				replaceSnapshotRangeTool(
					{
						path: relPath,
						expected_file_hash: hash,
						start_line: 5,
						end_line: 6,
						new_string: '',
					},
					{ worktreeDir, allowedPathPrefixes },
				),
			(err) =>
				err.code === 'INVALID_INPUT' &&
				/syntactically unparseable/.test(err.message) &&
				err.metadata.targetPath === relPath,
		);
		const afterRejection = readFileTool({ path: relPath }, { worktreeDir });
		assert.equal(afterRejection.content, original);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-03 replace_in_file rejects a literal replacement whose resulting file is unparseable', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPathPrefixes = ['src'];
		const relPath = 'src/existing.ts';
		const original = 'export class Foo {\n  bar() {\n    return 1;\n  }\n}\n';
		writeFileTool({ path: relPath, content: original }, { worktreeDir, allowedPathPrefixes });

		assert.throws(
			() =>
				replaceInFileTool(
					{
						path: relPath,
						old_string: 'return 1;',
						new_string: 'return "unterminated;',
					},
					{ worktreeDir, allowedPathPrefixes },
				),
			(err) =>
				err.code === 'INVALID_INPUT' &&
				/syntactically unparseable/.test(err.message) &&
				err.metadata.targetPath === relPath,
		);
		const afterRejection = readFileTool({ path: relPath }, { worktreeDir });
		assert.equal(afterRejection.content, original);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('replace_snapshot_range parse rejection includes a bracket-balance-shift hint when the range crosses a block boundary', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPathPrefixes = ['src'];
		const relPath = 'src/existing.ts';
		const original =
			'export function outer() {\n' +
			'  if (true) {\n' +
			'    doSomething();\n' +
			'  }\n' +
			'  return 1;\n' +
			'}\n';
		writeFileTool({ path: relPath, content: original }, { worktreeDir, allowedPathPrefixes });
		const { hash } = readFileTool({ path: relPath }, { worktreeDir });

		// start_line=4, end_line=5 removes only line 4 ("  }\n", the if-block's closing brace)
		// and replaces it with nothing: the edit removes one '}' and supplies none, leaving the
		// if-block unclosed — a {}: +1 bracket-balance shift (one net extra unmatched opener).
		assert.throws(
			() =>
				replaceSnapshotRangeTool(
					{
						path: relPath,
						expected_file_hash: hash,
						start_line: 4,
						end_line: 5,
						new_string: '',
					},
					{ worktreeDir, allowedPathPrefixes },
				),
			(err) =>
				err.code === 'INVALID_INPUT' &&
				/syntactically unparseable/.test(err.message) &&
				/bracket balance.*\{\}: \+1/.test(err.message) &&
				err.metadata.bracketBalanceHint.includes('{}: +1'),
		);
		const afterRejection = readFileTool({ path: relPath }, { worktreeDir });
		assert.equal(afterRejection.content, original);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('replace_in_file parse rejection omits the bracket-balance-shift hint when the edit is bracket-neutral', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPathPrefixes = ['src'];
		const relPath = 'src/existing.ts';
		const original = 'export class Foo {\n  bar() {\n    return 1;\n  }\n}\n';
		writeFileTool({ path: relPath, content: original }, { worktreeDir, allowedPathPrefixes });

		// Replaces "return 1;" with a dangling, unterminated string literal — the brace/paren/
		// bracket counts of old_string and new_string are identical (none in either), so no
		// bracket-balance shift applies; the parse failure here is a different cause entirely.
		assert.throws(
			() =>
				replaceInFileTool(
					{
						path: relPath,
						old_string: 'return 1;',
						new_string: 'return "unterminated;',
					},
					{ worktreeDir, allowedPathPrefixes },
				),
			(err) =>
				err.code === 'INVALID_INPUT' &&
				/syntactically unparseable/.test(err.message) &&
				!/bracket balance/.test(err.message) &&
				!('bracketBalanceHint' in err.metadata),
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-04 the parse check is scoped to recognized source extensions', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPathPrefixes = ['docs', 'config'];

		const mdWritten = writeFileTool(
			{ path: 'docs/notes.md', content: '# Not { valid ts syntax at all (((' },
			{ worktreeDir, allowedPathPrefixes },
		);
		assert.equal(mdWritten.written, true);

		const jsonWritten = writeFileTool(
			{ path: 'config/settings.json', content: '{ this is not valid json or ts syntax' },
			{ worktreeDir, allowedPathPrefixes },
		);
		assert.equal(jsonWritten.written, true);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-05 syntactically valid, decorator-bearing mutations are unaffected by the new guard', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPathPrefixes = ['src'];
		const relPath = 'src/example.ts';
		const decoratedOriginal =
			'import { Injectable } from \'@nestjs/common\';\n\nexport class Example {\n  @Injectable()\n  method() {\n    return 1;\n  }\n}\n';

		// @case AC-05.1: write_file with valid new file content.
		const written = writeFileTool(
			{ path: relPath, content: decoratedOriginal },
			{ worktreeDir, allowedPathPrefixes },
		);
		assert.equal(written.written, true);

		// @case AC-05.2: replace_in_file with a valid literal substitution.
		const replaced = replaceInFileTool(
			{ path: relPath, old_string: 'return 1;', new_string: 'return 2;' },
			{ worktreeDir, allowedPathPrefixes },
		);
		assert.equal(replaced.replaced, true);
		const afterReplace = readFileTool({ path: relPath }, { worktreeDir });
		assert.match(afterReplace.content, /return 2;/);

		// @case AC-05.3: replace_snapshot_range with a valid range replacement.
		const { hash } = readFileTool({ path: relPath }, { worktreeDir });
		const rangeReplaced = replaceSnapshotRangeTool(
			{
				path: relPath,
				expected_file_hash: hash,
				start_line: 4,
				end_line: 5,
				new_string: '  @Injectable()\n  @SecondDecorator()\n',
			},
			{ worktreeDir, allowedPathPrefixes },
		);
		assert.equal(rangeReplaced.replaced, true);
		const afterRange = readFileTool({ path: relPath }, { worktreeDir });
		assert.match(afterRange.content, /@SecondDecorator\(\)/);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('assertMutatedFileParses ignores non-source extensions and accepts valid decorated syntax', () => {
	assert.doesNotThrow(() => assertMutatedFileParses('docs/readme.md', 'not { valid ts ((('));
	assert.doesNotThrow(() =>
		assertMutatedFileParses(
			'src/example.tsx',
			'export function App() {\n  return <div>hi</div>;\n}\n',
		),
	);
	assert.throws(
		() => assertMutatedFileParses('src/example.ts', 'export class Foo {'),
		(err) => err.code === 'INVALID_INPUT' && /syntactically unparseable/.test(err.message),
	);
});
