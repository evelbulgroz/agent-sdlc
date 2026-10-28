import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { cleanupRun, collectLocalImportGraph } from '../testing/recovery-fixtures.mjs';
import { trackTestRun } from '../testing/test-support.mjs';

test('production CLI blocks with valid JSON and zero network when no route is enabled', async () => {
	const testSlug = `sdlc-no-network-${trackTestRun(crypto.randomUUID().slice(0, 8))}`;
	const runId = `${new Date().toISOString().slice(0, 10)}-${testSlug}`;
	const networkMarker = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc',
		`network-attempt-${crypto.randomUUID()}.marker`,
	);
	try {
		const result = await new Promise((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					'--import',
					'./packages/agent-sdlc/testing/no-network-preload.mjs',
					'packages/agent-sdlc/cli/cli.ts',
					'start',
					'--slug',
					testSlug,
					'--goal',
					'Block before any provider call',
					'--json',
				],
				{
					cwd: REPOSITORY_ROOT,
					stdio: ['ignore', 'pipe', 'pipe'],
					env: {
						...process.env,
						OPENAI_API_KEY: '',
						GOOGLE_API_KEY: '',
						XAI_API_KEY: '',
						SDLC_TEST_NETWORK_MARKER: networkMarker,
					},
				},
			);
			let stdout = '';
			let stderr = '';
			child.stdout.setEncoding('utf8');
			child.stderr.setEncoding('utf8');
			child.stdout.on('data', (chunk) => {
				stdout += chunk;
			});
			child.stderr.on('data', (chunk) => {
				stderr += chunk;
			});
			child.once('error', reject);
			child.once('exit', (code) => resolve({ code, stdout, stderr }));
		});
		assert.equal(result.code, 3);
		const output = JSON.parse(result.stdout);
		assert.equal(output.ok, true);
		assert.equal(output.state, 'BLOCKED');
		assert.doesNotMatch(result.stderr, /NETWORK_DISABLED/);
		assert.match(result.stderr, /ExperimentalWarning: SQLite/);
		assert.equal(
			fs.existsSync(networkMarker),
			false,
			'zero network attempts should leave no side-channel marker',
		);
	} finally {
		if (fs.existsSync(networkMarker)) fs.unlinkSync(networkMarker);
		cleanupRun(runId);
	}
});

test('production CLI import graph excludes testing adapters and limits providers to governor', () => {
	const entry = path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/cli/cli.ts');
	const visited = collectLocalImportGraph(entry);
	const relative = [...visited].map((file) => path.relative(REPOSITORY_ROOT, file));
	assert.equal(
		relative.some((file) => file.includes('/testing/')),
		false,
	);
	for (const file of relative.filter((item) => /adapter|provider/i.test(item))) {
		assert.ok(
			file.startsWith('packages/model-usage/') ||
				file === 'packages/agent-sdlc/adapters/model-governor.ts' ||
				file === 'packages/agent-sdlc/review/critic-review.ts' ||
				file === 'packages/agent-sdlc/review/citation-verifier.ts' ||
				file === 'packages/agent-sdlc/adapters/github-pr.ts',
			`Unexpected provider path: ${file}`,
		);
	}
});

test('production import traversal follows from, side-effect, and dynamic imports', () => {
	const fixtureDir = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`import-graph-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(fixtureDir, { recursive: true });
	const entry = path.join(fixtureDir, 'entry.mjs');
	fs.writeFileSync(
		entry,
		[
			"import value from './from.mjs';",
			"import './side-effect.mjs';",
			"const dynamic = import('./dynamic.mjs');",
			'void value;',
			'void dynamic;',
		].join('\n'),
	);
	for (const name of ['from.mjs', 'side-effect.mjs', 'dynamic.mjs']) {
		fs.writeFileSync(path.join(fixtureDir, name), 'export default true;\n');
	}
	try {
		const relative = [...collectLocalImportGraph(entry)].map((file) =>
			path.relative(fixtureDir, file),
		);
		assert.deepEqual(
			new Set(relative),
			new Set(['entry.mjs', 'from.mjs', 'side-effect.mjs', 'dynamic.mjs']),
		);
	} finally {
		fs.rmSync(fixtureDir, { recursive: true, force: true });
	}
});
