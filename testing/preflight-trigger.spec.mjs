import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { runAutoPrune } from '../cli/auto-prune.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

// @ac AC-08
// @case AC-08.4
test('AC-08.4: runAutoPrune spawns detached prune-runs only on primary checkout main when AGENT_SDLC_AUTO_PRUNE is enabled and CI is unset', () => {
	assert.deepEqual(runAutoPrune({ env: { AGENT_SDLC_AUTO_PRUNE: '0' } }), {
		triggered: false,
		reason: 'disabled-by-env',
	});
	assert.deepEqual(runAutoPrune({ env: { CI: 'true' } }), {
		triggered: false,
		reason: 'ci-environment',
	});

	const spawned = [];
	const result = runAutoPrune({
		rootDir: REPOSITORY_ROOT,
		env: {},
		gitCli: (_cmd, args) => {
			if (args[1] === '--abbrev-ref') return 'main\n';
			if (args[1] === '--git-dir') return '.git\n';
			if (args[1] === '--git-common-dir') return '.git\n';
			return '';
		},
		fsImpl: {
			mkdirSync() {},
			openSync() {
				return 42;
			},
			closeSync() {},
		},
		spawnFn: (cmd, args, opts) => {
			spawned.push({ cmd, args, opts });
			return { unref() {} };
		},
	});
	assert.equal(result.triggered, true);
	assert.equal(result.reason, 'spawned');
	assert.equal(spawned.length, 1);
	assert.deepEqual(spawned[0].args, [
		path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/cli/cli.ts'),
		'prune-runs',
	]);
});
