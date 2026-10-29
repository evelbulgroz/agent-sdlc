import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { copyPackageArtifacts, copyUntrackedFiles } from './hydration-steps.ts';
import {
	computeHydrationFingerprint,
	getHydrationMarkerPath,
	hydrateWorktree,
	isWorktreeHydrated,
	refreshLockfile,
} from './hydration.ts';

test('computeHydrationFingerprint produces stable hash over lockfile and packages', () => {
	const dir = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`fp-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfile-content-v1');

	try {
		const fp1 = computeHydrationFingerprint(dir, ['pkg-a', 'pkg-b']);
		const fp2 = computeHydrationFingerprint(dir, ['pkg-b', 'pkg-a']);
		assert.equal(fp1, fp2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('refreshLockfile runs mutable install before frozen verification', async () => {
	const commands = [];
	await refreshLockfile({
		worktreeDir: '/tmp/sdlc-lockfile-refresh',
		runner(command, args) {
			commands.push([command, ...args]);
			return '';
		},
	});
	assert.deepEqual(commands, [
		['pnpm', 'install'],
		['pnpm', 'install', '--frozen-lockfile'],
	]);
});

test('getHydrationMarkerPath handles legacy worktree and task subtrees correctly', () => {
	const legacyPath = '/root/tools/.agent-sdlc/run-1/worktree';
	assert.equal(getHydrationMarkerPath(legacyPath), '/root/tools/.agent-sdlc/run-1/hydration.json');
	assert.equal(
		getHydrationMarkerPath(legacyPath, '/custom/meta'),
		'/custom/meta/hydration.json',
	);

	const taskPath = '/root/tools/.agent-sdlc/run-1/worktrees/task-0';
	assert.equal(
		getHydrationMarkerPath(taskPath),
		'/root/tools/.agent-sdlc/run-1/worktrees/hydration-task-0.json',
	);
	assert.equal(
		getHydrationMarkerPath(taskPath, '/custom/meta'),
		'/custom/meta/hydration-task-0.json',
	);
});
function tempDir(prefix) {
	const dir = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `${prefix}-${crypto.randomUUID()}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function writeProfile(dir, extra) {
	fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.agents/sdlc-host.json'),
		JSON.stringify({
			schemaVersion: '1.3.0',
			profileId: 'tmp',
			repositoryId: 'tmp',
			adapter: 'default',
			stateDir: 'tools/.agent-sdlc',
			reviewDir: 'tools/.review',
			specDraftDir: 'docs/specs/drafts',
			...extra,
		}),
	);
}

test('hydrateWorktree without hydration config only installs, then caches', async () => {
	const dir = tempDir('hydrate-default');
	fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lock');
	const commands = [];
	const runner = (cmd, args) => {
		commands.push([cmd, ...args]);
		return '';
	};
	try {
		const res = await hydrateWorktree({ worktreeDir: dir, allowedPackages: ['cli'], runner });
		assert.equal(res.status, 'HYDRATED');
		assert.deepEqual(res.stepsCompleted, ['install', 'impact-build']);
		assert.deepEqual(commands, [['pnpm', 'install', '--frozen-lockfile']]);

		fs.mkdirSync(path.join(dir, 'node_modules'));
		const again = await hydrateWorktree({ worktreeDir: dir, allowedPackages: ['cli'], runner });
		assert.equal(again.status, 'CACHED');
		assert.equal(commands.length, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(getHydrationMarkerPath(dir), { force: true });
	}
});

test('hydrateWorktree runs declared installArgv, conditional builds and steps in order', async () => {
	const dir = tempDir('hydrate-declared');
	writeProfile(dir, {
		hydration: {
			installArgv: ['pnpm', 'install', '--prefer-offline'],
			conditionalBuilds: [
				{ skipIfExists: 'built.js', argv: ['pnpm', 'run', 'build:one'] },
				{ skipIfExists: 'package.json', argv: ['pnpm', 'run', 'skipped'] },
			],
			steps: [['node', 'extra.mjs']],
		},
	});
	fs.writeFileSync(path.join(dir, 'package.json'), '{}');
	const commands = [];
	try {
		await hydrateWorktree({
			worktreeDir: dir,
			runner: (cmd, args) => {
				commands.push([cmd, ...args]);
				return '';
			},
		});
		assert.deepEqual(commands, [
			['pnpm', 'install', '--prefer-offline'],
			['pnpm', 'run', 'build:one'],
			['node', 'extra.mjs'],
		]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(getHydrationMarkerPath(dir), { force: true });
	}
});

test('hydrateWorktree surfaces a failing declared step as HYDRATION_FAILED', async () => {
	const dir = tempDir('hydrate-fail');
	writeProfile(dir, { hydration: { steps: [['node', 'boom.mjs']] } });
	try {
		await assert.rejects(
			hydrateWorktree({
				worktreeDir: dir,
				runner: (cmd) => {
					if (cmd === 'node') throw new Error('boom');
					return '';
				},
			}),
			(error) => error.code === 'HYDRATION_FAILED' && error.metadata?.step === 'host-step',
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('copyUntrackedFiles copies declared paths without overwriting and enforces required', () => {
	const source = tempDir('src');
	const target = tempDir('dst');
	try {
		fs.mkdirSync(path.join(source, 'secrets'));
		fs.writeFileSync(path.join(source, 'secrets/a.txt'), 'new');
		fs.mkdirSync(path.join(target, 'secrets'));
		fs.writeFileSync(path.join(target, 'secrets/b.txt'), 'keep');
		copyUntrackedFiles(source, target, [{ source: 'secrets', required: true }, { source: 'absent' }]);
		assert.equal(fs.readFileSync(path.join(target, 'secrets/a.txt'), 'utf8'), 'new');
		assert.equal(fs.readFileSync(path.join(target, 'secrets/b.txt'), 'utf8'), 'keep');
		assert.throws(
			() => copyUntrackedFiles(source, target, [{ source: 'absent', required: true }]),
			(error) => error.code === 'HYDRATION_FAILED',
		);
	} finally {
		fs.rmSync(source, { recursive: true, force: true });
		fs.rmSync(target, { recursive: true, force: true });
	}
});

test('copyPackageArtifacts copies artifacts for present, non-excluded packages', () => {
	const source = tempDir('src');
	const target = tempDir('dst');
	try {
		for (const name of ['one', 'two']) {
			fs.mkdirSync(path.join(source, 'svc', name, 'dist/contracts'), { recursive: true });
			fs.writeFileSync(path.join(source, 'svc', name, 'dist/contracts/c.ts'), name);
			fs.mkdirSync(path.join(target, 'svc', name), { recursive: true });
		}
		copyPackageArtifacts(source, target, [
			{ packageRoot: 'svc', artifactRelativePath: 'dist/contracts', excludedPackages: ['two'] },
		]);
		assert.equal(fs.existsSync(path.join(target, 'svc/one/dist/contracts/c.ts')), true);
		assert.equal(fs.existsSync(path.join(target, 'svc/two/dist/contracts/c.ts')), false);
	} finally {
		fs.rmSync(source, { recursive: true, force: true });
		fs.rmSync(target, { recursive: true, force: true });
	}
});
