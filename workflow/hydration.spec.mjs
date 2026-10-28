import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import {
	computeHydrationFingerprint,
	copyExistingContracts,
	copyLiveSecurityConfigs,
	determineHydrationSteps,
	getHydrationMarkerPath,
	hydrateWorktree,
	isWorktreeHydrated,
	refreshLockfile,
} from './hydration.ts';

test('determineHydrationSteps detects security config needs', () => {
	const servicePlan = determineHydrationSteps(['apps/services/conditioning']);
	assert.equal(servicePlan.needsSecurityConfig, true);
	assert.equal(servicePlan.needsWorkspaceBuild, true);

	const sharedPkgPlan = determineHydrationSteps(['packages/ddd-base']);
	assert.equal(sharedPkgPlan.needsSecurityConfig, true);
	assert.equal(sharedPkgPlan.needsWorkspaceBuild, true);

	const sdlcPlan = determineHydrationSteps(['packages/agent-sdlc']);
	assert.equal(sdlcPlan.needsSecurityConfig, false);
	assert.equal(sdlcPlan.needsWorkspaceBuild, false);

	const docsPlan = determineHydrationSteps(['docs']);
	assert.equal(docsPlan.needsSecurityConfig, false);
	assert.equal(docsPlan.needsWorkspaceBuild, false);
});

test('computeHydrationFingerprint produces stable hash over lockfile and packages', () => {
	const dir = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`fp-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfile-content-v1');

	try {
		const fp1 = computeHydrationFingerprint(dir, ['apps/services/conditioning', 'packages/ddd-base']);
		const fp2 = computeHydrationFingerprint(dir, ['packages/ddd-base', 'apps/services/conditioning']);
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

test('hydrateWorktree executes install, security config, impact build and caches completion', async () => {
	const dir = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`hydrate-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfile-content-v1');

	// Create mock package.json for conditioning service
	const condDir = path.join(dir, 'apps/services/conditioning');
	fs.mkdirSync(condDir, { recursive: true });
	fs.writeFileSync(
		path.join(condDir, 'package.json'),
		JSON.stringify({
			name: '@example/conditioning-service',
			scripts: { build: 'vite build' },
		}),
	);

	const commands = [];
	const mockRunner = (cmd, args, opts) => {
		commands.push({ cmd, args, cwd: opts?.cwd });
		return '';
	};

	try {
		assert.equal(isWorktreeHydrated(dir, ['apps/services/conditioning']), false);

		// First hydration runs all steps
		const res1 = await hydrateWorktree({
			worktreeDir: dir,
			allowedPackages: ['apps/services/conditioning'],
			runner: mockRunner,
		});

		assert.equal(res1.status, 'HYDRATED');
		assert.deepEqual(res1.stepsCompleted, [
			'install',
			'security-config',
			'workspace-build',
			'impact-build',
		]);
		assert.equal(commands.length, 4);
		assert.deepEqual(commands[0].args, ['install', '--frozen-lockfile']);
		assert.deepEqual(commands[1].args, ['run', 'setup:security-config']);
		assert.deepEqual(commands[2].args, ['run', 'build:packages']);
		assert.deepEqual(commands[3].args, [
			'--filter',
			'@example/conditioning-service...',
			'run',
			'build',
		]);

		// A recreated worktree keeps the external marker but loses node_modules
		assert.equal(isWorktreeHydrated(dir, ['apps/services/conditioning']), false);
		fs.mkdirSync(path.join(dir, 'node_modules'));

		// Second hydration returns CACHED without running commands again
		const res2 = await hydrateWorktree({
			worktreeDir: dir,
			allowedPackages: ['apps/services/conditioning'],
			runner: mockRunner,
		});

		assert.equal(res2.status, 'CACHED');
		assert.equal(commands.length, 4); // No new commands

		// Error in runner throws typed HYDRATION_FAILED error
		const failingRunner = () => {
			throw new Error('Command failed: pnpm install');
		};
		// Marker is stored outside the worktree; worktree itself has no marker
		assert.equal(fs.existsSync(path.join(dir, '.hydration-fingerprint.json')), false);
		const markerFile = getHydrationMarkerPath(dir);
		assert.equal(fs.existsSync(markerFile), true);
		fs.unlinkSync(markerFile);
		await assert.rejects(
			async () =>
				hydrateWorktree({
					worktreeDir: dir,
					allowedPackages: ['apps/services/conditioning'],
					runner: failingRunner,
				}),
			(error) => error.code === 'HYDRATION_FAILED',
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		try {
			const marker = getHydrationMarkerPath(dir);
			if (fs.existsSync(marker)) fs.unlinkSync(marker);
		} catch {}
	}
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

test('hydrateWorktree builds service workspace prerequisites before the scoped target', async () => {
	const runBase = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`task-hydrate-${crypto.randomUUID()}`,
	);
	const taskDir = path.join(runBase, 'worktrees', 'task-cond');
	fs.mkdirSync(taskDir, { recursive: true });
	fs.writeFileSync(path.join(taskDir, 'pnpm-lock.yaml'), 'lockfile-content-v1');

	const condDir = path.join(taskDir, 'apps/services/conditioning');
	fs.mkdirSync(condDir, { recursive: true });
	fs.writeFileSync(
		path.join(condDir, 'package.json'),
		JSON.stringify({
			name: '@example/conditioning-service',
			scripts: { build: 'vite build' },
		}),
	);

	const commands = [];
	const mockRunner = (cmd, args, opts) => {
		commands.push({ cmd, args, cwd: opts?.cwd });
		return '';
	};

	try {
		const result = await hydrateWorktree({
			worktreeDir: taskDir,
			targetPackage: 'apps/services/conditioning',
			runner: mockRunner,
		});

		assert.equal(result.status, 'HYDRATED');

		const workspaceBuildIndex = commands.findIndex((c) =>
			c.args.includes('build:packages'),
		);
		assert.ok(workspaceBuildIndex >= 0);

		const impactBuildIndex = commands.findIndex((c) => c.args[0] === '--filter');
		const impactBuildCall = commands[impactBuildIndex];
		assert.ok(impactBuildCall);
		assert.ok(workspaceBuildIndex < impactBuildIndex);
		assert.deepEqual(impactBuildCall.args, [
			'--filter',
			'@example/conditioning-service...',
			'run',
			'build',
		]);

		// Check marker location
		const markerPath = getHydrationMarkerPath(taskDir);
		assert.ok(markerPath.endsWith('hydration-task-cond.json'));
		assert.equal(fs.existsSync(markerPath), true);
	} finally {
		fs.rmSync(runBase, { recursive: true, force: true });
	}
});

test('hydrateWorktree includes allowedPackages in prerequisites while scoping impact-build to targetPackage', async () => {
	const runBase = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`run-${crypto.randomUUID()}`,
	);
	const taskDir = path.join(runBase, 'worktrees', 'frontend-task');
	fs.mkdirSync(path.join(taskDir, 'apps/frontends/example-pwa-frontend'), { recursive: true });
	fs.writeFileSync(
		path.join(taskDir, 'apps/frontends/example-pwa-frontend/package.json'),
		JSON.stringify({ name: '@example/pwa-frontend', scripts: { build: 'vite build' } }),
	);

	const commands = [];
	const mockRunner = (cmd, args) => {
		commands.push({ cmd, args });
		return '';
	};

	try {
		const result = await hydrateWorktree({
			worktreeDir: taskDir,
			targetPackage: 'apps/frontends/example-pwa-frontend',
			allowedPackages: ['apps/frontends/example-pwa-frontend', 'apps/services/conditioning'],
			runner: mockRunner,
		});

		assert.equal(result.status, 'HYDRATED');

		// Prerequisites triggered by conditioning in allowedPackages
		const secConfigIndex = commands.findIndex((c) =>
			c.args.includes('setup:security-config'),
		);
		assert.ok(secConfigIndex >= 0, 'security-config should be run because conditioning is in allowedPackages');

		const workspaceBuildIndex = commands.findIndex((c) =>
			c.args.includes('build:packages'),
		);
		assert.ok(workspaceBuildIndex >= 0, 'build:packages should be run because conditioning is in allowedPackages');

		// Impact build is scoped to targetPackage (@example/pwa-frontend)
		const impactBuildCalls = commands.filter((c) => c.args[0] === '--filter');
		assert.equal(impactBuildCalls.length, 1);
		assert.deepEqual(impactBuildCalls[0].args, [
			'--filter',
			'@example/pwa-frontend...',
			'run',
			'build',
		]);
	} finally {
		fs.rmSync(runBase, { recursive: true, force: true });
	}
});

test('copyLiveSecurityConfigs copies non-test security configs to target worktree', () => {
	const source = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`source-${crypto.randomUUID()}`,
	);
	const target = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`target-${crypto.randomUUID()}`,
	);

	try {
		const srcSec = path.join(source, 'apps/services/strength/security-config');
		fs.mkdirSync(srcSec, { recursive: true });
		fs.writeFileSync(path.join(srcSec, 'production.security.config.ts'), 'export default {}');
		fs.writeFileSync(path.join(srcSec, 'development.security.config.ts'), 'export default {}');
		fs.writeFileSync(path.join(srcSec, 'test.security.config.ts'), 'export default {}');

		const tgtApps = path.join(target, 'apps/services/strength');
		fs.mkdirSync(tgtApps, { recursive: true });

		copyLiveSecurityConfigs(source, target);

		const tgtSec = path.join(tgtApps, 'security-config');
		assert.equal(fs.existsSync(path.join(tgtSec, 'production.security.config.ts')), true);
		assert.equal(fs.existsSync(path.join(tgtSec, 'development.security.config.ts')), true);
		// test.security.config.ts is generated by setup:security-config, not copied
		assert.equal(fs.existsSync(path.join(tgtSec, 'test.security.config.ts')), false);
	} finally {
		fs.rmSync(source, { recursive: true, force: true });
		fs.rmSync(target, { recursive: true, force: true });
	}
});

test('copyExistingContracts copies dist-contracts to target worktree', () => {
	const source = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`source-${crypto.randomUUID()}`,
	);
	const target = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`target-${crypto.randomUUID()}`,
	);

	try {
		for (const service of ['registry', 'conditioning']) {
			const srcDist = path.join(source, `apps/services/${service}/dist-contracts`);
			fs.mkdirSync(srcDist, { recursive: true });
			fs.writeFileSync(path.join(srcDist, 'index.d.ts'), 'export * from "./generated-api";');
			fs.writeFileSync(path.join(srcDist, 'index.js'), 'export {};');
			fs.mkdirSync(path.join(target, `apps/services/${service}`), { recursive: true });
		}

		copyExistingContracts(source, target);

		for (const service of ['registry', 'conditioning']) {
			const tgtDist = path.join(target, `apps/services/${service}/dist-contracts`);
			assert.equal(fs.existsSync(path.join(tgtDist, 'index.d.ts')), true);
			assert.equal(fs.existsSync(path.join(tgtDist, 'index.js')), true);
		}
	} finally {
		fs.rmSync(source, { recursive: true, force: true });
		fs.rmSync(target, { recursive: true, force: true });
	}
});
