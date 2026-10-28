import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeSyntheticHostProfile } from '../testing/cli-test-support.mjs';
import { hydrateWorktree as workflowHydrateWorktree } from '../workflow/hydration.ts';
import {
	hydrate as defaultHydrate,
	hydrateWorktree as defaultHydrateWorktree,
} from './default-adapter.ts';
import { hydrate as scriptHydrate } from './script.ts';

function withTempWorktree(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-host-hydration-'));
	return Promise.resolve()
		.then(() => fn(dir))
		.finally(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});
}

test('@ac AC-05 @case AC-05.1 script hydration with empty array makes 0 runner calls and does not copy security-config, read pnpm-workspace.yaml, or spawn pnpm', async () => {
	await withTempWorktree(async (worktreeDir) => {
		const calls = [];
		const result = await scriptHydrate({
			worktreeDir,
			hydration: [],
			runner: (cmd, args, opts) => {
				calls.push({ cmd, args, opts });
				return '';
			},
		});
		assert.equal(calls.length, 0);
		assert.deepEqual(result, { status: 'HYDRATED', stepsCompleted: [] });
		assert.equal(
			fs.existsSync(path.join(worktreeDir, 'packages')),
			false,
		);
	});
});

test('@ac AC-05 @case AC-05.2 script hydration with [["node", "setup.mjs"]] makes 1 runner call with cwd set to the worktree', async () => {
	await withTempWorktree(async (worktreeDir) => {
		const calls = [];
		const result = await scriptHydrate({
			worktreeDir,
			hydration: [['node', 'setup.mjs']],
			runner: (cmd, args, opts) => {
				calls.push({ cmd, args, opts });
				return '';
			},
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, 'node');
		assert.deepEqual(calls[0].args, ['setup.mjs']);
		assert.equal(calls[0].opts.cwd, worktreeDir);
		assert.deepEqual(result.stepsCompleted, ['node setup.mjs']);
	});
});

test('@ac AC-05 @case AC-05.3 default adapter calls hydrateWorktree from workflow/hydration.ts against a synthetic 1.3.0 host profile', async () => {
	assert.equal(defaultHydrateWorktree, workflowHydrateWorktree);
	await withTempWorktree(async (worktreeDir) => {
		writeSyntheticHostProfile(worktreeDir);
		const calls = [];
		const result = await defaultHydrate({
			worktreeDir,
			allowedPackages: ['tools'],
			runner: (cmd, args, opts) => {
				calls.push({ cmd, args, opts });
				return '';
			},
		});
		assert.equal(result.status, 'HYDRATED');
		assert.ok(calls.some((call) => call.cmd === 'pnpm' && call.args[0] === 'install'));
	});
});

