import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { RepositoryModelGovernor } from '../../adapters/model-governor.ts';
import { runCli } from '../cli.ts';
import { resolveExecutorSelection } from './start.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { RuntimeStore } from '../../persistence/runtime-store.ts';
import { FakeModelGovernor } from '../../testing/fake-model-governor.mjs';
import { completeProposal } from '../../testing/test-support.mjs';
import { slug, cleanupRun, readyGoalFile, readStoredExecutor, completeSpecJson } from '../../testing/cli-test-support.mjs';

test('CLI start accepts --author-vendor flag and persists canonical vendor', async () => {
	const testSlug = slug('author-vendor');
	const governor = new FakeModelGovernor([completeProposal()]);
	let runId;
	try {
		const started = await runCli(
			[
				'start',
				'--slug',
				testSlug,
				'--author-vendor',
				'copilot',
				'--goal',
				'Build vendor workflow',
			],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		assert.equal(started.exitCode, 2);
		runId = started.result.runId;
		const store = new RuntimeStore(
			path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
		);
		try {
			const state = store.getRun(runId);
			assert.equal(state.authorVendor, 'openai');
		} finally {
			store.close();
		}
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('CLI blocks a larger task manifest before governor dispatch when canary evidence is absent', async () => {
	const testSlug = slug('canary-required');
	const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
	const governor = new FakeModelGovernor([completeProposal()]);
	const qualification = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/canary-qualification.json',
	);
	const backup = fs.existsSync(qualification)
		? fs.readFileSync(qualification)
		: null;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-start-canary-'));
	try {
		const { pinnedToolsManifest } = await import('../../testing/task-planner-fixtures.mjs');
		const goalFile = path.join(tempDir, 'goal.json');
		const manifestFile = path.join(tempDir, 'tasks.json');
		fs.writeFileSync(goalFile, JSON.stringify(completeSpecJson({ touchedSurfaces: ['tools/agent-sdlc'] })));
		const manifest = pinnedToolsManifest();
		manifest.tasks = [
			{ ...manifest.tasks[0], taskId: 'task-1', dependsOn: [] },
			{ ...manifest.tasks[0], taskId: 'task-2', dependsOn: ['task-1'] },
		];
		fs.writeFileSync(manifestFile, JSON.stringify(manifest));
		if (fs.existsSync(qualification)) fs.unlinkSync(qualification);
		const outcome = await runCli(
			[
				'start',
				'--slug',
				testSlug,
				'--goal-file',
				goalFile,
				'--task-plan-file',
				manifestFile,
				'--json',
			],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		assert.equal(outcome.exitCode, 64);
		assert.equal(outcome.result.error.code, 'CANARY_REQUIRED');
		assert.equal(governor.calls.length, 0);
		assert.equal(
			fs.existsSync(path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId)),
			false,
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
		if (backup) {
			fs.mkdirSync(path.dirname(qualification), { recursive: true });
			fs.writeFileSync(qualification, backup, { mode: 0o600 });
		}
		cleanupRun(runId);
	}
});

test('CLI --skip-canary passes a larger manifest through the canary gate', async () => {
	const testSlug = slug('skip-canary');
	const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
	const governor = {
		assertAvailable() {
			throw new Error('PAST_CANARY_GATE');
		},
	};
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-skip-canary-'));
	try {
		const { pinnedToolsManifest } = await import('../../testing/task-planner-fixtures.mjs');
		const goalFile = path.join(tempDir, 'goal.json');
		const manifestFile = path.join(tempDir, 'tasks.json');
		fs.writeFileSync(goalFile, JSON.stringify(completeSpecJson({ touchedSurfaces: ['tools/agent-sdlc'] })));
		const manifest = pinnedToolsManifest();
		manifest.tasks = [
			{ ...manifest.tasks[0], taskId: 'task-1', dependsOn: [] },
			{ ...manifest.tasks[0], taskId: 'task-2', dependsOn: ['task-1'] },
		];
		fs.writeFileSync(manifestFile, JSON.stringify(manifest));
		const outcome = await runCli(
			[
				'start',
				'--slug',
				testSlug,
				'--goal-file',
				goalFile,
				'--task-plan-file',
				manifestFile,
				'--skip-canary',
				'--json',
			],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		assert.equal(outcome.exitCode, 70);
		assert.equal(outcome.result.error.code, 'INTERNAL_ERROR');
		assert.match(outcome.result.error.message, /PAST_CANARY_GATE/);
		assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId)), false);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
		cleanupRun(runId);
	}
});

test('CLI rejects credential-bearing goals before governor dispatch or run creation', async () => {
	const testSlug = slug('secret-goal');
	const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
	const governor = new FakeModelGovernor([completeProposal()]);
	const outcome = await runCli(
		['start', '--slug', testSlug, '--goal', `Use Authorization: Bearer ${'a'.repeat(24)}`],
		{ rootDir: REPOSITORY_ROOT, governor },
	);
	assert.equal(outcome.exitCode, 64);
	assert.equal(governor.calls.length, 0);
	assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId)), false);
	assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId)), false);
});

test('CLI rejects Google credentials before synthetic or repository governor dispatch and projection', async () => {
	const credential = `${'AI'}${'za'}${'K'.repeat(35)}`;
	let repositoryDispatches = 0;
	const governors = [
		{
			label: 'synthetic',
			governor: new FakeModelGovernor([completeProposal()]),
			dispatches: (governor) => governor.calls.length,
		},
		{
			label: 'repository',
			governor: new RepositoryModelGovernor({
				execute: async () => {
					repositoryDispatches += 1;
					throw new Error('must not dispatch');
				},
			}),
			dispatches: () => repositoryDispatches,
		},
	];
	for (const candidate of governors) {
		const testSlug = slug(`secret-goal-${candidate.label}`);
		const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
		const outcome = await runCli(
			['start', '--slug', testSlug, '--goal', `Use credential ${credential}`],
			{ rootDir: REPOSITORY_ROOT, governor: candidate.governor },
		);
		assert.equal(outcome.exitCode, 64);
		assert.equal(candidate.dispatches(candidate.governor), 0);
		assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId)), false);
		assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId)), false);
	}
});

test('CLI rolls back only its new run folder when runtime acquisition collides', async () => {
	const testSlug = slug('collision');
	const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
	const runtimeDir = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId);
	const canary = path.join(runtimeDir, 'canary.txt');
	fs.mkdirSync(runtimeDir, { recursive: true });
	fs.writeFileSync(canary, 'preserve');
	try {
		const outcome = await runCli(
			['start', '--slug', testSlug, '--goal', 'Do not overwrite runtime'],
			{
				rootDir: REPOSITORY_ROOT,
				governor: new FakeModelGovernor([completeProposal()]),
			},
		);
		assert.equal(outcome.exitCode, 64);
		assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId)), false);
		assert.equal(fs.readFileSync(canary, 'utf8'), 'preserve');
	} finally {
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	}
});

test('CLI fails with exit 64 and preserves existing run directory when init collides', async () => {
	const testSlug = slug('init-collision');
	const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
	const runDir = path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId);
	const canary = path.join(runDir, 'canary.txt');
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(canary, 'preserve-existing-run');
	try {
		const outcome = await runCli(
			['start', '--slug', testSlug, '--goal', 'Do not overwrite pre-existing run'],
			{
				rootDir: REPOSITORY_ROOT,
				governor: new FakeModelGovernor([completeProposal()]),
			},
		);
		assert.equal(outcome.exitCode, 64);
		assert.equal(outcome.result.error.code, 'RUN_ALREADY_EXISTS');
		assert.match(outcome.human, /RUN_ALREADY_EXISTS/);
		assert.equal(fs.existsSync(runDir), true);
		assert.equal(fs.readFileSync(canary, 'utf8'), 'preserve-existing-run');
		assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId)), false);
	} finally {
		fs.rmSync(runDir, { recursive: true, force: true });
	}
});

test('CLI start fails with exit 3 when governor is unavailable before creating run', async () => {
	const testSlug = slug('gov-unavail');
	const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
	const outcome = await runCli(
		['start', '--slug', testSlug, '--goal', 'Governor unavailable test'],
		{
			rootDir: REPOSITORY_ROOT,
			governor: new RepositoryModelGovernor({
				governorPath: path.join(REPOSITORY_ROOT, 'tools/model-usage/nonexistent-governor.mjs'),
			}),
		},
	);
	assert.equal(outcome.exitCode, 3);
	assert.equal(outcome.result.error.code, 'GOVERNOR_UNAVAILABLE');
	assert.match(outcome.human, /GOVERNOR_UNAVAILABLE/);
	assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId)), false);
	assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId)), false);
});

test('@ac AC-02 @case AC-02.4 executor disagreement and a non-minimal value exit before a model call', async () => {
	const governor = new FakeModelGovernor([]);
	let available = 0;
	governor.assertAvailable = () => {
		available += 1;
		return true;
	};
	const parsed = { values: new Map([['--executor', 'minimal']]) };
	assert.equal(resolveExecutorSelection(parsed, { AGENT_SDLC_EXECUTOR: 'minimal' }), 'minimal');
	assert.equal(resolveExecutorSelection({ values: new Map() }, {}), 'minimal');
	assert.equal(resolveExecutorSelection({ values: new Map() }, { AGENT_SDLC_EXECUTOR: '' }), 'minimal');
	const disagree = await runCli(['start', '--executor', 'minimal', '--goal', 'x'], {
		rootDir: REPOSITORY_ROOT,
		governor,
		env: { AGENT_SDLC_EXECUTOR: 'controlled' },
	});
	assert.equal(disagree.exitCode, 64);
	assert.equal(disagree.result.error.code, 'INVALID_INPUT');
	const sideways = await runCli(['start', '--executor', 'sideways', '--goal', 'x'], {
		rootDir: REPOSITORY_ROOT,
		governor,
		env: {},
	});
	assert.equal(sideways.exitCode, 64);
	assert.equal(sideways.result.error.code, 'INVALID_INPUT');
	assert.equal(available, 0);
	assert.equal(governor.calls.length, 0);
});

test('@ac AC-02 @case AC-02.1 @case AC-02.2 @case AC-02.3 controlled executor selection is INVALID_INPUT before a run exists', async () => {
	const governor = new FakeModelGovernor([]);
	const flag = await runCli(['start', '--executor', 'controlled', '--goal', 'x'], {
		rootDir: REPOSITORY_ROOT,
		governor,
		env: {},
	});
	assert.equal(flag.exitCode, 64);
	assert.equal(flag.result.error.code, 'INVALID_INPUT');
	assert.match(flag.result.error.message, /executor must be minimal/);

	const shell = await runCli(['shell', 'start', '--executor', 'controlled', '--goal-file', 'unused.md'], {
		rootDir: REPOSITORY_ROOT,
		governor,
		env: {},
	});
	assert.equal(shell.exitCode, 64);
	assert.equal(shell.result.error.code, 'INVALID_INPUT');
	assert.match(shell.result.error.message, /executor must be minimal/);

	const fromEnv = await runCli(['start', '--goal', 'x'], {
		rootDir: REPOSITORY_ROOT,
		governor,
		env: { AGENT_SDLC_EXECUTOR: 'controlled' },
	});
	assert.equal(fromEnv.exitCode, 64);
	assert.equal(fromEnv.result.error.code, 'INVALID_INPUT');
	assert.equal(governor.calls.length, 0);
});

test('@ac AC-01 @case AC-01.1 @case AC-01.2 omitted and explicit minimal selections store executor minimal', async () => {
	const envRun = slug('executor-env');
	const flagRun = slug('executor-flag');
	const shellSlug = slug('executor-shell');
	const bareRun = slug('executor-bare');
	let envId;
	let flagId;
	let shellId;
	let bareId;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-cli-'));
	try {
		const fromEnv = await runCli(['start', '--slug', envRun, '--goal', 'Build executor workflow'], {
			rootDir: REPOSITORY_ROOT,
			governor: new FakeModelGovernor([completeProposal()]),
			env: { AGENT_SDLC_EXECUTOR: 'minimal' },
		});
		assert.equal(fromEnv.exitCode, 2);
		envId = fromEnv.result.runId;
		const envState = await readStoredExecutor(envId);
		assert.equal(envState.executor, 'minimal');

		const fromFlag = await runCli(
			['start', '--slug', flagRun, '--executor', 'minimal', '--goal', 'Build executor workflow'],
			{
				rootDir: REPOSITORY_ROOT,
				governor: new FakeModelGovernor([completeProposal()]),
				env: {},
			},
		);
		assert.equal(fromFlag.exitCode, 2);
		flagId = fromFlag.result.runId;
		const flagState = await readStoredExecutor(flagId);
		assert.equal(flagState.executor, 'minimal');

		const bare = await runCli(['start', '--slug', bareRun, '--goal', 'Build executor workflow'], {
			rootDir: REPOSITORY_ROOT,
			governor: new FakeModelGovernor([completeProposal()]),
			env: {},
		});
		assert.equal(bare.exitCode, 2);
		bareId = bare.result.runId;
		const bareState = await readStoredExecutor(bareId);
		assert.equal(bareState.executor, 'minimal');

		const goalFile = readyGoalFile(dir);
		const brief = await runCli(
			['shell', 'start', '--goal-file', goalFile, '--slug', shellSlug, '--executor', 'minimal'],
			{
				rootDir: REPOSITORY_ROOT,
				governor: new FakeModelGovernor([completeProposal()]),
				env: {},
			},
		);
		assert.equal(brief.exitCode, 2);
		const responseFile = path.join(dir, 'confirm.json');
		fs.writeFileSync(
			responseFile,
			JSON.stringify({ confirm: true, briefHash: brief.result.briefHash }),
		);
		const started = await runCli(
			[
				'shell',
				'start',
				'--goal-file',
				goalFile,
				'--slug',
				shellSlug,
				'--executor',
				'minimal',
				'--response-file',
				responseFile,
			],
			{
				rootDir: REPOSITORY_ROOT,
				governor: new FakeModelGovernor([completeProposal()]),
				env: {},
			},
		);
		assert.equal(started.exitCode, 2);
		shellId = started.result.runId;
		const shellState = await readStoredExecutor(shellId);
		assert.equal(shellState.executor, flagState.executor);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
		for (const runId of [envId, flagId, shellId, bareId]) {
			if (runId) cleanupRun(runId);
		}
	}
});

test('@ac AC-03 @case AC-03.1 CLI start on a 1.3.0 host profile omitting runsDir co-locates runtime.sqlite, status.json, intent.md, and plan.md under .agent-sdlc/<runId> without creating docs/specs/runs', async () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-start-colocated-'));
	const testSlug = slug('colocated-start');
	const profilePath = path.join(rootDir, '.agents/sdlc-host.json');
	fs.mkdirSync(path.dirname(profilePath), { recursive: true });
	fs.writeFileSync(
		profilePath,
		JSON.stringify(
			{
				schemaVersion: '1.3.0',
				profileId: 'colocated-client',
				repositoryId: 'colocated-client',
				adapter: 'script',
				hydration: [['pnpm', 'install']],
				commands: [['pnpm', 'test']],
				workspace: { directories: ['.'] },
				verify: {
					argv: ['pnpm', 'run', 'verify', '--', '{baseSha}'],
					resultPath: '.agent-sdlc/verify.json',
					require: { status: 'OK', canonical: true },
					headField: 'gitHeadSha',
				},
			},
			null,
			2,
		),
		'utf8',
	);
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Co-located single-directory client onboarding run'],
			{
				rootDir,
				governor: new FakeModelGovernor([completeProposal()]),
			},
		);
		assert.equal(started.exitCode, 2);
		const runId = started.result.runId;
		const colocatedDir = path.join(rootDir, '.agent-sdlc', runId);
		assert.equal(fs.existsSync(path.join(colocatedDir, 'runtime.sqlite')), true);
		assert.equal(fs.existsSync(path.join(colocatedDir, 'status.json')), true);
		assert.equal(fs.existsSync(path.join(colocatedDir, 'intent.md')), true);
		assert.equal(fs.existsSync(path.join(colocatedDir, 'plan.md')), true);
		assert.equal(fs.existsSync(path.join(rootDir, 'docs/specs/runs')), false);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});
