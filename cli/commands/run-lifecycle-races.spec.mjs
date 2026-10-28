import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { FakeModelGovernor } from '../../testing/fake-model-governor.mjs';
import { completeProposal } from '../../testing/test-support.mjs';
import { slug, cleanupRun } from '../../testing/cli-test-support.mjs';

test('concurrent cancellation persists when an in-flight start later loses its transition race', async () => {
	const testSlug = slug('start-cancel-race');
	const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
	let releaseDispatch;
	let markDispatched;
	const dispatched = new Promise((resolve) => {
		markDispatched = resolve;
	});
	const release = new Promise((resolve) => {
		releaseDispatch = resolve;
	});
	const governor = {
		portVersion: '1.0.0',
		synthetic: true,
		calls: [],
		assertAvailable() {
			return true;
		},
		async execute(request) {
			this.calls.push(structuredClone(request));
			markDispatched();
			await release;
			return {
				schemaVersion: '1.0.0',
				synthetic: true,
				output: completeProposal(),
				operationId: request.operationId,
				replayed: false,
				usageRecordIds: [],
			};
		},
	};
	try {
		const starting = runCli(
			['start', '--slug', testSlug, '--goal', 'Preserve a concurrently cancelled run'],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		await dispatched;
		const cancelled = await runCli(['cancel', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor: new FakeModelGovernor([]),
		});
		assert.equal(cancelled.result.state, 'CANCELLED');
		releaseDispatch();
		const staleStart = await starting;
		assert.equal(staleStart.result.ok, false);
		assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId)), true);
		assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId)), true);
		const persisted = await runCli(['status', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor: new FakeModelGovernor([]),
		});
		assert.equal(persisted.result.state, 'CANCELLED');
		const exported = await runCli(['export', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor: new FakeModelGovernor([]),
		});
		assert.equal(exported.result.state, 'CANCELLED');
	} finally {
		releaseDispatch?.();
		cleanupRun(runId);
	}
});

test('concurrent no-overwrite exports create exactly one destination', async () => {
	const testSlug = slug('export-race');
	const governor = new FakeModelGovernor([completeProposal()]);
	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Export once under contention'],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		runId = started.result.runId;
		const destination = `tools/.agent-sdlc/${runId}/exports/race.json`;
		const runExport = () =>
			new Promise((resolve, reject) => {
				const child = spawn(
					process.execPath,
					['packages/agent-sdlc/cli/cli.ts', 'export', '--run', runId, '--dest', destination, '--json'],
					{ cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
				);
				child.once('error', reject);
				child.once('exit', (code) => resolve(code));
			});
		const codes = (await Promise.all([runExport(), runExport()])).sort((a, b) => a - b);
		assert.deepEqual(codes, [2, 64]);
		assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, destination)), true);
	} finally {
		if (runId) cleanupRun(runId);
	}
});
