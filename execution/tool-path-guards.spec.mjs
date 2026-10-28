import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
	assertToolPathContained,
	normalizeRelPath,
} from './tool-path-guards.ts';
import {
	readFileTool,
} from './tool-read.ts';
import {
	replaceInFileTool,
	writeFileTool,
} from './tool-mutations.ts';
import {
	executeTool,
} from './tools.ts';

function createTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-tools-test-'));
}

test('assertToolPathContained enforces worktree boundary and allowed prefixes', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = path.join(tempDir, 'worktree');
		fs.mkdirSync(worktreeDir, { recursive: true });

		// Valid path inside worktree
		const resolved = assertToolPathContained(worktreeDir, 'src/index.ts');
		assert.equal(resolved, path.join(worktreeDir, 'src/index.ts'));
		assert.equal(
			assertToolPathContained(worktreeDir, '  src/index.ts \t'),
			path.join(worktreeDir, 'src/index.ts'),
		);
		assert.equal(normalizeRelPath('  ./src/index.ts \t'), 'src/index.ts');
		assert.throws(
			() => assertToolPathContained(worktreeDir, ' \t '),
			(err) => err.code === 'INVALID_INPUT',
		);

		// Traversal outside
		assert.throws(
			() => assertToolPathContained(worktreeDir, '../outside.txt'),
			(err) => err.code === 'PATH_CONTAINMENT_VIOLATION',
		);
		assert.throws(
			() => assertToolPathContained(worktreeDir, '  ../outside.txt \t'),
			(err) => err.code === 'PATH_CONTAINMENT_VIOLATION',
		);

		// Null bytes
		assert.throws(
			() => assertToolPathContained(worktreeDir, 'src/index.ts\0.js'),
			(err) => err.code === 'PATH_CONTAINMENT_VIOLATION',
		);

		// .git directory access
		assert.throws(
			() => assertToolPathContained(worktreeDir, '.git/config'),
			(err) => err.code === 'PATH_CONTAINMENT_VIOLATION',
		);
		assert.throws(
			() => assertToolPathContained(worktreeDir, 'sub/.git/HEAD'),
			(err) => err.code === 'PATH_CONTAINMENT_VIOLATION',
		);

		// Allowed prefixes
		const allowedPrefixes = ['apps/services/conditioning', 'packages/common'];
		assert.ok(
			assertToolPathContained(
				worktreeDir,
				'apps/services/conditioning/src/file.ts',
				allowedPrefixes,
			),
		);
		assert.throws(
			() =>
				assertToolPathContained(
					worktreeDir,
					'apps/services/conditioning-other/file.ts',
					allowedPrefixes,
				),
			(err) => err.code === 'PATH_CONTAINMENT_VIOLATION',
		);
		assert.throws(
			() => assertToolPathContained(worktreeDir, 'apps/services/auth/src/file.ts', allowedPrefixes),
			(err) => err.code === 'PATH_CONTAINMENT_VIOLATION',
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('assertToolPathContained catches symlink escapes', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = path.join(tempDir, 'worktree');
		const outsideDir = path.join(tempDir, 'outside');
		fs.mkdirSync(worktreeDir, { recursive: true });
		fs.mkdirSync(outsideDir, { recursive: true });

		const outsideFile = path.join(outsideDir, 'secret.txt');
		fs.writeFileSync(outsideFile, 'secret-data');

		// Create symlink inside worktree pointing outside
		const symlinkPath = path.join(worktreeDir, 'symlink-dir');
		fs.symlinkSync(outsideDir, symlinkPath, 'dir');

		assert.throws(
			() => assertToolPathContained(worktreeDir, 'symlink-dir/secret.txt'),
			(err) => err.code === 'PATH_CONTAINMENT_VIOLATION',
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('path tools canonicalize surrounding whitespace and preserve resolution evidence', () => {
	const tempDir = createTempDir();
	try {
		const canonicalPath = 'apps/services/conditioning/src/example.ts';
		const requestedPath = `${canonicalPath} `;
		const allowedPathPrefixes = ['apps/services/conditioning'];
		fs.mkdirSync(path.dirname(path.join(tempDir, canonicalPath)), { recursive: true });
		fs.writeFileSync(path.join(tempDir, canonicalPath), 'export const value = 1;\n');

		const readResult = readFileTool({ path: requestedPath }, { worktreeDir: tempDir });
		assert.equal(readResult.content, 'export const value = 1;\n');
		assert.equal(readResult.requestedPath, requestedPath);
		assert.equal(readResult.resolvedPath, canonicalPath);

		const replaceResult = replaceInFileTool(
			{
				path: requestedPath,
				old_string: 'export const value = 1;',
				new_string: 'export const value = 2;',
				expected_file_hash: readResult.hash,
			},
			{ worktreeDir: tempDir, allowedPathPrefixes },
		);
		assert.equal(replaceResult.replaced, true);
		assert.equal(replaceResult.requestedPath, requestedPath);
		assert.equal(replaceResult.resolvedPath, canonicalPath);
		assert.equal(
			fs.readFileSync(path.join(tempDir, canonicalPath), 'utf8'),
			'export const value = 2;\n',
		);
		assert.equal(fs.existsSync(path.join(tempDir, requestedPath)), false);

		const createdCanonicalPath = 'apps/services/conditioning/src/created.ts';
		const createdRequestedPath = ` ${createdCanonicalPath}`;
		const writeResult = writeFileTool(
			{ path: createdRequestedPath, content: 'export const created = true;\n' },
			{ worktreeDir: tempDir, allowedPathPrefixes },
		);
		assert.equal(writeResult.requestedPath, createdRequestedPath);
		assert.equal(writeResult.resolvedPath, createdCanonicalPath);
		assert.equal(
			fs.readFileSync(path.join(tempDir, createdCanonicalPath), 'utf8'),
			'export const created = true;\n',
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('model mutation tools reject generated-only paths', () => {
	const tempDir = createTempDir();
	try {
		const generatedFile = path.join(
			tempDir,
			'tools/agent-sdlc/generated/schema.json',
		);
		fs.mkdirSync(path.dirname(generatedFile), { recursive: true });
		fs.writeFileSync(generatedFile, '{}\n');
		const generatedHash = crypto
			.createHash('sha256')
			.update('{}\n')
			.digest('hex');
		assert.throws(
			() =>
				executeTool({
					toolName: 'write_file',
					parameters: {
						path: 'tools/agent-sdlc/generated/schema.json',
						content: '{}',
					},
					worktreeDir: tempDir,
					allowedPathPrefixes: ['tools/agent-sdlc'],
					generatedPathPrefixes: ['tools/agent-sdlc/generated'],
				}),
			(error) =>
				error.code === 'INVALID_INPUT' &&
				error.message.includes('run the declared generator'),
		);
		assert.throws(
			() =>
				executeTool({
					toolName: 'replace_snapshot_range',
					parameters: {
						path: 'tools/agent-sdlc/generated/schema.json',
						expected_file_hash: generatedHash,
						start_line: 1,
						end_line: 1,
						new_string: '{"changed":true}\n',
					},
					worktreeDir: tempDir,
					allowedPathPrefixes: ['tools/agent-sdlc'],
					generatedPathPrefixes: ['tools/agent-sdlc/generated'],
				}),
			(error) =>
				error.code === 'INVALID_INPUT' &&
				error.message.includes('run the declared generator'),
		);
		assert.equal(fs.readFileSync(generatedFile, 'utf8'), '{}\n');
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
