import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkRunLanded } from './landed-check.ts';

function git(cwd, args) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function initRepo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-landed-'));
	git(dir, ['init', '-b', 'main']);
	git(dir, ['config', 'user.name', 'Test Operator']);
	git(dir, ['config', 'user.email', 'test@example.com']);
	fs.writeFileSync(path.join(dir, 'a.txt'), 'base-a\n');
	fs.writeFileSync(path.join(dir, 'b.txt'), 'base-b\n');
	fs.writeFileSync(path.join(dir, 'untouched.txt'), 'base-u\n');
	git(dir, ['add', '.']);
	git(dir, ['commit', '-m', 'base commit']);
	const baseCommitSha = git(dir, ['rev-parse', 'HEAD']);
	return { dir, baseCommitSha };
}

// @ac AC-02
test('AC-02: checkRunLanded compares run changed paths against main blob SHAs', async (t) => {
	// @case AC-02.1
	await t.test(
		'AC-02.1: returns true when run changes were squash-merged to main and unrelated files changed afterward',
		() => {
			const { dir, baseCommitSha } = initRepo();
			try {
				git(dir, ['checkout', '-b', 'run-branch']);
				fs.writeFileSync(path.join(dir, 'a.txt'), 'run-a\n');
				fs.writeFileSync(path.join(dir, 'added.txt'), 'run-added\n');
				git(dir, ['add', '.']);
				git(dir, ['commit', '-m', 'run changes']);
				const targetTreeSha = git(dir, ['rev-parse', 'HEAD']);

				git(dir, ['checkout', 'main']);
				fs.writeFileSync(path.join(dir, 'a.txt'), 'run-a\n');
				fs.writeFileSync(path.join(dir, 'added.txt'), 'run-added\n');
				git(dir, ['add', '.']);
				git(dir, ['commit', '-m', 'squash merge run']);

				fs.writeFileSync(path.join(dir, 'untouched.txt'), 'later-unrelated-change\n');
				git(dir, ['add', 'untouched.txt']);
				git(dir, ['commit', '-m', 'unrelated change']);

				assert.equal(
					checkRunLanded({ rootDir: dir, baseCommitSha, targetTreeSha }),
					true,
				);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	// @case AC-02.2
	await t.test(
		'AC-02.2: returns false when one of the run changed files was modified again on main',
		() => {
			const { dir, baseCommitSha } = initRepo();
			try {
				git(dir, ['checkout', '-b', 'run-branch']);
				fs.writeFileSync(path.join(dir, 'a.txt'), 'run-a\n');
				fs.writeFileSync(path.join(dir, 'b.txt'), 'run-b\n');
				git(dir, ['add', '.']);
				git(dir, ['commit', '-m', 'run changes']);
				const targetTreeSha = git(dir, ['rev-parse', 'HEAD']);

				git(dir, ['checkout', 'main']);
				fs.writeFileSync(path.join(dir, 'a.txt'), 'run-a\n');
				fs.writeFileSync(path.join(dir, 'b.txt'), 'main-modified-b-later\n');
				git(dir, ['add', '.']);
				git(dir, ['commit', '-m', 'landed then modified']);

				assert.equal(
					checkRunLanded({ rootDir: dir, baseCommitSha, targetTreeSha }),
					false,
				);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	// @case AC-02.3
	await t.test(
		'AC-02.3: returns true when a file deleted by the run is absent on main, and false when still present',
		() => {
			const { dir, baseCommitSha } = initRepo();
			try {
				git(dir, ['checkout', '-b', 'run-delete']);
				fs.unlinkSync(path.join(dir, 'b.txt'));
				git(dir, ['add', '-A']);
				git(dir, ['commit', '-m', 'delete b.txt']);
				const targetTreeSha = git(dir, ['rev-parse', 'HEAD']);

				git(dir, ['checkout', 'main']);
				assert.equal(
					checkRunLanded({ rootDir: dir, baseCommitSha, targetTreeSha }),
					false,
				);

				fs.unlinkSync(path.join(dir, 'b.txt'));
				git(dir, ['add', '-A']);
				git(dir, ['commit', '-m', 'delete b.txt on main']);
				assert.equal(
					checkRunLanded({ rootDir: dir, baseCommitSha, targetTreeSha }),
					true,
				);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	// @case AC-02.4
	await t.test(
		'AC-02.4: returns false when baseCommitSha or targetTreeSha is missing, and unknown when git objects cannot be read',
		() => {
			const { dir, baseCommitSha } = initRepo();
			try {
				assert.equal(
					checkRunLanded({ rootDir: dir, baseCommitSha: null, targetTreeSha: baseCommitSha }),
					false,
				);
				assert.equal(
					checkRunLanded({ rootDir: dir, baseCommitSha, targetTreeSha: '' }),
					false,
				);
				assert.equal(
					checkRunLanded({
						rootDir: dir,
						baseCommitSha,
						targetTreeSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
					}),
					'unknown',
				);
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
