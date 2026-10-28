import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { archiveRoot, archivedRunRelativePath } from '../persistence/run-paths.ts';
import { FakeModelGovernor } from '../testing/fake-model-governor.mjs';
import { runCli } from './cli.ts';
import { openContext, readBoundedFile, readStdin, resolveGoalText } from './run-context.ts';

test('readBoundedFile returns an empty file and rejects a missing one', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-bounded-'));
	const filename = path.join(directory, 'goal.md');
	try {
		fs.writeFileSync(filename, '');
		assert.equal(readBoundedFile(filename, 10), '');
		assert.throws(
			() => readBoundedFile(path.join(directory, 'missing.md'), 10),
			(error) => error.code === 'INVALID_INPUT',
		);
		fs.writeFileSync(filename, 'too-long');
		assert.throws(
			() => readBoundedFile(filename, 3),
			(error) => error.code === 'INVALID_INPUT',
		);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('readStdin rejects an empty stream and a stream over the cap', async () => {
	await assert.rejects(
		() => readStdin(Readable.from([]), 10),
		(error) => error.code === 'INVALID_INPUT' && /empty/.test(error.message),
	);
	await assert.rejects(
		() => readStdin(Readable.from(['abcdef']), 3),
		(error) => error.code === 'INVALID_INPUT' && /exceeds/.test(error.message),
	);
	assert.equal(await readStdin(Readable.from(['ok']), 10), 'ok');
});

test('resolveGoalText rejects an empty inline goal', () => {
	assert.throws(
		() => resolveGoalText(
			{ values: new Map([['--goal', '']]), booleans: new Set() },
			{ rootDir: '/tmp', maxGoalBytes: 100, command: 'start' },
		),
		(error) => error.code === 'INVALID_INPUT',
	);
});

// @ac AC-06
// @case AC-06.3
test('AC-06.3: openContext, resume, and status reject an archived runId with INVALID_INPUT naming its archive path without calling the governor', async () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-archived-ctx-'));
	const runId = '2026-10-01-archived-sample';
	try {
		fs.mkdirSync(path.join(archiveRoot(rootDir), runId), { recursive: true });
		const expectedRelPath = archivedRunRelativePath(runId);

		assert.throws(
			() => openContext({ rootDir, runId }),
			(error) => error.code === 'INVALID_INPUT' && error.message.includes(expectedRelPath),
		);

		const governor = new FakeModelGovernor([]);
		for (const cmd of ['resume', 'status']) {
			const res = await runCli([cmd, '--run', runId, '--json'], {
				rootDir,
				governor,
				env: {},
			});
			assert.equal(res.exitCode, 64);
			assert.equal(res.result.error.code, 'INVALID_INPUT');
			assert.ok(res.result.error.message.includes(expectedRelPath));
		}
		assert.equal(governor.calls.length, 0);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});
