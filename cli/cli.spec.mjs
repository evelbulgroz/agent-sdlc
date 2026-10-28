import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { runCli } from './cli.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import {
	clearProgressSink,
	emitRuntimeTransitionProgress,
	installProgressSink,
} from './progress.ts';

const FROZEN_EXPORTS = [
	'exitCodeForResult',
	'exitCodeForState',
	'humanResult',
	'maybePromptLearningDebt',
	'resolveExecutorSelection',
	'runCli',
	'snapshotWorktreeTree',
];

test('@ac AC-02 @case AC-02.1 cli.mjs exports the frozen facade names', async () => {
	const entry = await import('./cli.ts');
	assert.deepEqual(Object.keys(entry).sort(), FROZEN_EXPORTS);
});

test('@ac AC-02 @case AC-02.5 runCli installs the progress sink only for the five marked commands and clears it when the handler throws', async () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-sink-'));
	const streams = {
		stdin: { isTTY: false },
		stdout: { write() {} },
		stderr: { write() {} },
	};
	const sample = { state: 'PLANNING_TASKS', runtimeRevision: 1, activeTaskId: null };
	const sinkCommands = [
		['start'],
		['resume', '--run', 'missing-run'],
		['approve', '--run', 'missing-run'],
		['answer', '--run', 'missing-run'],
		['authorize', '--run', 'missing-run'],
	];
	try {
		const kept = [];
		installProgressSink((line) => kept.push(line));
		await runCli(['help'], { rootDir, streams });
		emitRuntimeTransitionProgress(sample);
		assert.equal(kept.length > 0, true);
		clearProgressSink();

		const statusLines = [];
		installProgressSink((line) => statusLines.push(line));
		await runCli(['status', '--run', 'missing-run'], { rootDir, streams });
		emitRuntimeTransitionProgress(sample);
		assert.equal(statusLines.length > 0, true);
		clearProgressSink();

		for (const args of sinkCommands) {
			const lines = [];
			installProgressSink((line) => lines.push(line));
			const outcome = await runCli(args, { rootDir, streams });
			assert.equal(outcome.result.ok, false);
			emitRuntimeTransitionProgress(sample);
			assert.equal(lines.length, 0, args[0]);
		}
	} finally {
		clearProgressSink();
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-02 @case AC-02.1 @case AC-02.6 node packages/agent-sdlc/cli/cli.ts help exits 0 and prints Usage: agent-sdlc', () => {
	const cliPath = fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/cli/cli.ts'))
		? path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/cli/cli.ts')
		: path.join(REPOSITORY_ROOT, 'cli/cli.ts');
	const help = spawnSync(
		process.execPath,
		[cliPath, 'help'],
		{
			cwd: REPOSITORY_ROOT,
			encoding: 'utf8',
			timeout: 30000,
		},
	);
	assert.equal(help.status, 0);
	assert.match(`${help.stdout}`, /Usage: agent-sdlc <command> \[options\]/);
});
