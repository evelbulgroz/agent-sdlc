import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { snapshotWorktreeTree } from './resume-escalation.ts';

test('worktree snapshot preserves ignored tracked files while recording allowed edits', () => {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-worktree-snapshot-'));
	try {
		execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
		execFileSync('git', ['config', 'user.email', 'test@fitnessapp.local'], { cwd: repoDir });
		execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoDir });

		fs.mkdirSync(path.join(repoDir, 'packages/ddd-base'), { recursive: true });
		fs.mkdirSync(path.join(repoDir, 'coverage.root-owned.bak'), { recursive: true });
		fs.writeFileSync(path.join(repoDir, '.env.example'), 'VITE_GATEWAY_BASE_URL=/gateway/api/v1\n');
		fs.writeFileSync(
			path.join(repoDir, 'coverage.root-owned.bak/coverage-summary.json'),
			'{}\n',
		);
		fs.writeFileSync(path.join(repoDir, 'packages/ddd-base/fixture.ts'), 'export const value = 1;\n');
		execFileSync('git', ['add', '-A'], { cwd: repoDir });
		execFileSync('git', ['commit', '-m', 'track fixture files'], {
			cwd: repoDir,
			stdio: 'ignore',
		});

		fs.writeFileSync(
			path.join(repoDir, '.gitignore'),
			'.env.example\ncoverage.root-owned.bak/\n',
		);
		execFileSync('git', ['add', '.gitignore'], { cwd: repoDir });
		execFileSync('git', ['commit', '-m', 'ignore tracked fixture files'], {
			cwd: repoDir,
			stdio: 'ignore',
		});
		const baseline = execFileSync('git', ['rev-parse', 'HEAD'], {
			cwd: repoDir,
			encoding: 'utf8',
		}).trim();

		fs.writeFileSync(
			path.join(repoDir, 'packages/ddd-base/fixture.ts'),
			'export const value = 2;\n',
		);
		const snapshot = snapshotWorktreeTree({ worktreeDir: repoDir, baseTreeSha: baseline });
		const changedFiles = execFileSync(
			'git',
			['diff-tree', '-r', '--name-status', baseline, snapshot],
			{ cwd: repoDir, encoding: 'utf8' },
		)
			.trim()
			.split('\n');

		assert.deepEqual(changedFiles, ['M\tpackages/ddd-base/fixture.ts']);
	} finally {
		fs.rmSync(repoDir, { recursive: true, force: true });
	}
});
