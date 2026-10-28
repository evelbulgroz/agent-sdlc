import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	executeTool,
} from './tools.ts';

function createTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-tools-test-'));
}

test('executeTool dispatches correctly and rejects non-allowlisted tools', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPathPrefixes = ['src'];

		const res = executeTool({
			toolName: 'write_file',
			parameters: { path: 'src/main.ts', content: 'console.log(1);' },
			worktreeDir,
			allowedPathPrefixes,
		});
		assert.equal(res.written, true);

		assert.throws(
			() =>
				executeTool({
					toolName: 'execute_arbitrary_code',
					parameters: {},
					worktreeDir,
				}),
			(err) => err.code === 'INVALID_INPUT',
		);

		// Permissions enforcement
		assert.throws(
			() =>
				executeTool({
					toolName: 'write_file',
					parameters: { path: 'src/main.ts', content: 'console.log(2);' },
					worktreeDir,
					allowedPathPrefixes,
					allowedOperations: { editIsolatedWorktree: false, runAllowlistedCommands: true },
				}),
			(err) => err.code === 'AUTHORIZATION_INVALID',
		);
		assert.throws(
			() =>
				executeTool({
					toolName: 'replace_snapshot_range',
					parameters: {
						path: 'src/main.ts',
						expected_file_hash: '0'.repeat(64),
						start_line: 1,
						end_line: 1,
						new_string: 'const value = 1;\n',
					},
					worktreeDir,
					allowedPathPrefixes,
					allowedOperations: {
						editIsolatedWorktree: false,
						runAllowlistedCommands: true,
					},
				}),
			(err) => err.code === 'AUTHORIZATION_INVALID',
		);

		assert.throws(
			() =>
				executeTool({
					toolName: 'run_allowlisted_command',
					parameters: { command: 'pnpm', args: ['run', 'lint'] },
					worktreeDir,
					allowedOperations: { editIsolatedWorktree: true, runAllowlistedCommands: false },
				}),
			(err) => err.code === 'AUTHORIZATION_INVALID',
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
