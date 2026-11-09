import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { taskQualityFixture } from '../testing/task-quality-fixture.ts';
import { sha256 } from '../policy/contracts.ts';
import {
	checkpointHydrationBinding, checkpointPreparationSelection,
} from './checkpoint-hydration.ts';
import { hydrateWorktree } from './hydration.ts';

function fixture(t) {
	const f = taskQualityFixture(t);
	const bytes = Buffer.from('frozen closure\n');
	const binding = checkpointHydrationBinding(f.plan, f.snapshot, f.auth);
	let preparations = 0;
	const runner = Object.assign(() => { throw Error('installation/build command forbidden'); }, {
		checkpointHydration: {
			binding, preparation: {
				configuration: { strategy: 'vendored-only' },
				files: [{ path: 'node_modules/closure.txt', sha256: sha256(bytes.toString()) }],
			},
			prepare: async ({ worktreeDir }) => {
				preparations++;
				fs.mkdirSync(path.join(worktreeDir, 'node_modules'), { recursive: true });
				fs.mkdirSync(path.join(worktreeDir, 'src/node_modules'), { recursive: true });
				fs.writeFileSync(path.join(worktreeDir, 'node_modules/closure.txt'), bytes);
			},
		},
	});
	const options = { worktreeDir: f.worktreeDir, allowedPackages: ['src'], targetPackage: 'src',
		checkpoint: binding, runner };
	return { ...f, runner, options, preparations: () => preparations };
}

test('frozen checkpoint preparation avoids every install and host build, including on reuse', async t => {
	const f = fixture(t);
	const first = await hydrateWorktree(f.options);
	assert.equal(first.status, 'HYDRATED');
	assert.deepEqual(first.stepsCompleted, ['checkpoint-preparation']);
	assert.equal((await hydrateWorktree(f.options)).status, 'CACHED');
	assert.equal(f.preparations(), 1);
	fs.writeFileSync(path.join(f.worktreeDir, 'node_modules/closure.txt'), 'drift');
	await assert.rejects(hydrateWorktree(f.options), /preparation file changed/);
	assert.equal(f.preparations(), 1);
});

test('override cannot cross run, base, plan, adapter or authorization scope', async t => {
	const f = fixture(t);
	for (const change of [
		{ runId: '2026-11-02-other' }, { approvedSpecHash: 'b'.repeat(64) },
		{ taskPlanHash: 'b'.repeat(64) }, { baseCommitSha: 'b'.repeat(40) },
		{ adapterBindingsHash: 'b'.repeat(64) }, { allowedPackages: ['elsewhere'] },
		{ allowedPathPrefixes: ['elsewhere'] },
	]) {
		await assert.rejects(hydrateWorktree({ ...f.options,
			checkpoint: { ...f.options.checkpoint, ...change } }), /binding or package scope/);
	}
	await assert.rejects(hydrateWorktree({ ...f.options, allowedPackages: ['elsewhere'] }), /package scope/);
	assert.equal(f.preparations(), 0);
	assert.throws(() => checkpointHydrationBinding(f.plan, { ...f.snapshot, taskPlanFrozen: false }, f.auth),
		/frozen authorized plan/);
	assert.throws(() => checkpointHydrationBinding(f.plan, null, f.auth), /frozen authorized plan/);
});

test('nil, empty and failed preparation never fall back to installation or create a success marker', async t => {
	const f = fixture(t);
	for (const preparation of [null, {}, { configuration: {}, files: [] }]) {
		f.runner.checkpointHydration.preparation = preparation;
		await assert.rejects(hydrateWorktree(f.options), /frozen regular-file closure/);
	}
	f.runner.checkpointHydration.preparation = {
		configuration: { strategy: 'vendored-only' }, files: [{ path: 'node_modules/closure.txt', sha256: 'a'.repeat(64) }],
	};
	f.runner.checkpointHydration.prepare = async () => { throw Error('source unavailable'); };
	await assert.rejects(hydrateWorktree(f.options), /source unavailable/);
	assert.equal(f.preparations(), 0);
});

test('preparation and binding drift reject cached worktrees without rewriting evidence', async t => {
	const f = fixture(t);
	await hydrateWorktree(f.options);
	f.runner.checkpointHydration.preparation.configuration.strategy = 'different';
	await assert.rejects(hydrateWorktree(f.options), /preparation changed/);
	assert.equal(f.preparations(), 1);
});

test('legacy plans ignore the checkpoint port and preserve their existing hydration commands', async t => {
	const f = fixture(t);
	const commands = [];
	const runner = Object.assign((command, args) => { commands.push([command, ...args]); return ''; },
		{ checkpointHydration: f.runner.checkpointHydration });
	assert.equal(checkpointHydrationBinding(null, null, null), null);
	assert.equal(checkpointHydrationBinding({ schemaVersion: '1.0.0' }, null, null), null);
	await hydrateWorktree({ ...f.options, checkpoint: null, runner });
	assert.deepEqual(commands, [['pnpm', 'install', '--frozen-lockfile']]);
	assert.equal(f.preparations(), 0);
	const selection = { adapters: f.plan.adapterBindings };
	assert.equal(checkpointPreparationSelection(() => '', selection), sha256(selection));
	assert.notEqual(checkpointPreparationSelection(runner, selection), sha256(selection));
});
