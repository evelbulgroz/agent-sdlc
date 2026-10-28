import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const IS_STANDALONE = !fs.existsSync(new URL('../../../packages/agent-sdlc', import.meta.url));

test('@ac AC-04 @case AC-04.3 @ac AC-05 @case AC-05.1 the model-usage suite exits 0', async (t) => {
	if (IS_STANDALONE) {
		const governor = await import('@evelbulgroz/model-usage-govenor');
		assert.ok(governor, 'expected installed model-usage governor');
		return;
	}
	// The parent node --test process sets NODE_TEST_CONTEXT. A nested
	// node --test treats that as recursion and skips every file.
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const result = spawnSync('pnpm', ['run', 'test:model-usage'], {
		cwd: REPOSITORY_ROOT,
		encoding: 'utf8',
		timeout: 180_000,
		env,
	});
	const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
	const lines = output.split('\n');
	const failed = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (!lines[index].startsWith('not ok ')) continue;
		failed.push(lines.slice(index, index + 18).join('\n'));
	}
	const tail = output.slice(-2000);
	assert.equal(result.status, 0, failed.join('\n---\n') || tail);
	const tests = [...output.matchAll(/# tests (\d+)/g)];
	const count = tests.length === 0 ? 0 : Number(tests[tests.length - 1][1]);
	assert.ok(count > 0, tail);
});

test('@ac AC-04 @case AC-04.4 pnpm run audit:pricing exits 0 and prints its check result', (t) => {
	if (IS_STANDALONE) {
		t.skip('Standalone package consumes @evelbulgroz/model-usage-govenor as installed dependency');
		return;
	}
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const result = spawnSync('pnpm', ['run', 'audit:pricing'], {
		cwd: REPOSITORY_ROOT,
		encoding: 'utf8',
		timeout: 60_000,
		env,
	});
	const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
	assert.equal(result.status, 0, output);
	assert.match(output, /Pricing audit OK:/);
});

test('@ac AC-05 @case AC-05.2 the agent-sdlc test script discovers the model-usage gate', () => {
	if (IS_STANDALONE) {
		const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		assert.equal(packageJson.dependencies?.['@evelbulgroz/model-usage-govenor'], '1.0.0');
		return;
	}
	const packageJson = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
	const script = packageJson.scripts['agent:test-sdlc'];
	assert.equal(fs.existsSync(new URL('../agent-sdlc.spec.mjs', import.meta.url)), false);
	assert.match(script, /packages\/agent-sdlc\/\*\*\/\*\.spec\.mjs/);
	assert.equal(script.includes('--test-concurrency=1'), true);
	assert.equal(script.includes('model-usage'), false);
});
