import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const PACKAGE_ROOT = path.join(REPOSITORY_ROOT, 'packages/agent-sdlc');

function testScript() {
	const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
	return packageJson.scripts['test:unit'];
}

test('@ac AC-01 @case AC-01.1 the barrel file is absent', () => {
	assert.equal(fs.existsSync(path.join(PACKAGE_ROOT, 'agent-sdlc.spec.mjs')), false);
});

test('@ac AC-01 @case AC-01.2 the package test:unit script runs the agent-sdlc glob serially without cd ../..', () => {
	const script = testScript();
	assert.equal(script, "node --test --test-concurrency=1 '**/*.spec.mjs'");
	assert.match(script, /\*\*\/\*\.spec\.mjs/);
	assert.equal(script.includes('--test-concurrency=1'), true);
	assert.equal(script.includes('cd ../..'), false);
});

test('@ac AC-01 @case AC-01.3 the test script does not name a model-usage spec', () => {
	assert.equal(testScript().includes('model-usage'), false);
});
