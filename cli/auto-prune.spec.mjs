import { writeSyntheticHostProfile } from '../testing/cli-test-support.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { archiveRoot } from '../persistence/run-paths.ts';
import { runAutoPrune } from './auto-prune.ts';

function git(cwd, args) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}

function createTempGitRepo() {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-autoprune-'));
	git(rootDir, ['init', '-b', 'main']);
	git(rootDir, ['config', 'user.name', 'Test Operator']);
	git(rootDir, ['config', 'user.email', 'test@example.com']);
	fs.writeFileSync(path.join(rootDir, 'README.md'), 'init\n');
	git(rootDir, ['add', 'README.md']);
	git(rootDir, ['commit', '-m', 'init']);
	return rootDir;
}

// @ac AC-08
test('AC-08: runAutoPrune guards branch, linked worktree, CI, and AGENT_SDLC_AUTO_PRUNE before spawning detached prune-runs', async (t) => {
	// @case AC-08.1
	await t.test(
		'AC-08.1: spawns detached prune-runs on main in main checkout when CI is unset and AGENT_SDLC_AUTO_PRUNE is not 0',
		() => {
			const rootDir = createTempGitRepo();
			try {
				const spawns = [];
				let unrefCalled = false;
				const result = runAutoPrune({
					rootDir,
					env: {},
					spawnFn(command, args, options) {
						spawns.push({ command, args, options });
						return {
							unref() {
								unrefCalled = true;
							},
						};
					},
				});

				assert.equal(result.triggered, true);
				assert.equal(result.reason, 'spawned');
				assert.equal(spawns.length, 1);
				assert.equal(spawns[0].options.detached, true);
				assert.deepEqual(spawns[0].args, [
					path.join(import.meta.dirname, 'cli.ts'),
					'prune-runs',
				]);
				assert.equal(unrefCalled, true);
				assert.equal(fs.existsSync(path.join(archiveRoot(rootDir), 'sweep.log')), true);
			} finally {
				fs.rmSync(rootDir, { recursive: true, force: true });
			}
		},
	);

	// @ac AC-01 @case AC-01.2
	await t.test(
		'AC-01.2: prefers the host engine.selfRoot cli/cli.ts when present and falls back to package-local cli entrypoint when absent',
		() => {
			const rootDir = createTempGitRepo();
			try {
				const fallbackSpawns = [];
				runAutoPrune({
					rootDir,
					env: {},
					spawnFn(command, args) {
						fallbackSpawns.push({ command, args });
						return { unref() {} };
					},
				});
				assert.equal(fallbackSpawns[0].args[0], path.join(import.meta.dirname, 'cli.ts'));

				writeSyntheticHostProfile(rootDir, { engine: { selfRoot: 'vendor/agent-sdlc' } });
				const hostCliPath = path.join(rootDir, 'vendor/agent-sdlc/cli/cli.ts');
				fs.mkdirSync(path.dirname(hostCliPath), { recursive: true });
				fs.writeFileSync(hostCliPath, '// stub\n');

				const hostSpawns = [];
				runAutoPrune({
					rootDir,
					env: {},
					spawnFn(command, args) {
						hostSpawns.push({ command, args });
						return { unref() {} };
					},
				});
				assert.equal(hostSpawns[0].args[0], hostCliPath);
			} finally {
				fs.rmSync(rootDir, { recursive: true, force: true });
			}
		},
	);

	// @case AC-08.2
	await t.test(
		'AC-08.2: does not spawn inside a linked git worktree or on a non-main branch',
		() => {
			const rootDir = createTempGitRepo();
			const linkedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-linked-wt-'));
			fs.rmSync(linkedDir, { recursive: true, force: true });
			try {
				const spawns = [];
				const spawnFn = () => {
					spawns.push(true);
					return { unref() {} };
				};

				git(rootDir, ['worktree', 'add', '--detach', linkedDir, 'HEAD']);
				const linkedResult = runAutoPrune({
					rootDir: linkedDir,
					env: {},
					gitCli: (cmd, args) => {
						if (args.includes('--abbrev-ref')) return 'main\n';
						return execFileSync(cmd, args, {
							cwd: linkedDir,
							encoding: 'utf8',
							stdio: ['ignore', 'pipe', 'pipe'],
						});
					},
					spawnFn,
				});
				assert.equal(linkedResult.triggered, false);
				assert.equal(linkedResult.reason, 'linked-worktree');
				assert.equal(spawns.length, 0);

				git(rootDir, ['checkout', '-b', 'feature/non-main']);
				const branchResult = runAutoPrune({
					rootDir,
					env: {},
					spawnFn,
				});
				assert.equal(branchResult.triggered, false);
				assert.equal(branchResult.reason, 'not-on-main');
				assert.equal(spawns.length, 0);
			} finally {
				fs.rmSync(linkedDir, { recursive: true, force: true });
				fs.rmSync(rootDir, { recursive: true, force: true });
			}
		},
	);

	// @case AC-08.3
	await t.test('AC-08.3: does not spawn when CI=true or AGENT_SDLC_AUTO_PRUNE=0', () => {
		const rootDir = createTempGitRepo();
		try {
			const spawns = [];
			const spawnFn = () => {
				spawns.push(true);
				return { unref() {} };
			};

			const ciResult = runAutoPrune({
				rootDir,
				env: { CI: 'true' },
				spawnFn,
			});
			assert.equal(ciResult.triggered, false);
			assert.equal(ciResult.reason, 'ci-environment');

			const disabledResult = runAutoPrune({
				rootDir,
				env: { AGENT_SDLC_AUTO_PRUNE: '0' },
				spawnFn,
			});
			assert.equal(disabledResult.triggered, false);
			assert.equal(disabledResult.reason, 'disabled-by-env');
			assert.equal(spawns.length, 0);
		} finally {
			fs.rmSync(rootDir, { recursive: true, force: true });
		}
	});
});
