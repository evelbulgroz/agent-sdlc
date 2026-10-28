import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../cli.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { seedSkillsRun } from '../../testing/cli-test-support.mjs';

test('AC-08: skills --apply on provisional key (runCount < 3) throws POLICY_VIOLATION with exitCode 70', async () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`skills-provisional-${crypto.randomUUID()}`,
	);
	try {
		// Only 2 runs (below threshold of 3)
		seedSkillsRun(tempRoot, 'run-1', [{ attributionLayer: 'layer3' }]);
		seedSkillsRun(tempRoot, 'run-2', [{ attributionLayer: 'layer3' }]);

		const outcome = await runCli(
			['skills', '--apply', '--key', '[implementer] tool_failure:test-runner-lookup'],
			{ rootDir: tempRoot },
		);

		assert.equal(outcome.exitCode, 70);
		assert.equal(outcome.result.ok, false);
		assert.equal(outcome.result.error.code, 'POLICY_VIOLATION');
		assert.match(outcome.result.error.message, /not reached the recommendation threshold/);
		// Zero files modified
		const promptPath = path.join(tempRoot, '.agents/workflows/prompts/implementer.md');
		assert.equal(fs.existsSync(promptPath), false);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('AC-08: skills --apply on mixed layer1/layer3 key throws POLICY_VIOLATION with exitCode 70', async () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`skills-ratchet-${crypto.randomUUID()}`,
	);
	try {
		// 3 runs, but run-2 is layer1
		seedSkillsRun(tempRoot, 'run-1', [{ attributionLayer: 'layer3' }]);
		seedSkillsRun(tempRoot, 'run-2', [{ attributionLayer: 'layer1' }]);
		seedSkillsRun(tempRoot, 'run-3', [{ attributionLayer: 'layer3' }]);

		const outcome = await runCli(
			['skills', '--apply', '--key', '[implementer] tool_failure:test-runner-lookup'],
			{ rootDir: tempRoot },
		);

		assert.equal(outcome.exitCode, 70);
		assert.equal(outcome.result.ok, false);
		assert.equal(outcome.result.error.code, 'POLICY_VIOLATION');
		assert.match(outcome.result.error.message, /Layer 1/);
		assert.match(outcome.result.error.message, /Ratchet Pattern/);
		// Zero files modified
		const promptPath = path.join(tempRoot, '.agents/workflows/prompts/implementer.md');
		assert.equal(fs.existsSync(promptPath), false);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('AC-09: skills --apply on recommended layer3 key renders diff, prompts TTY, and applies upon confirmation', async () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`skills-apply-tty-${crypto.randomUUID()}`,
	);
	try {
		// 3 runs, all layer3
		seedSkillsRun(tempRoot, 'run-1', [{ attributionLayer: 'layer3' }]);
		seedSkillsRun(tempRoot, 'run-2', [{ attributionLayer: 'layer3' }]);
		seedSkillsRun(tempRoot, 'run-3', [{ attributionLayer: 'layer3' }]);

		let stdoutOutput = '';
		const stdout = new Writable({
			write(chunk, _encoding, callback) {
				stdoutOutput += chunk.toString();
				callback();
			},
		});

		let questionAsked = false;
		const createReadline = () => ({
			async question(prompt) {
				questionAsked = true;
				assert.match(prompt, /Apply this prompt modification\? \[y\/N\]/);
				return 'y';
			},
			close() {},
		});

		const outcome = await runCli(
			['skills', '--apply', '--key', '[implementer] tool_failure:test-runner-lookup'],
			{
				rootDir: tempRoot,
				streams: { stdin: { isTTY: true }, stdout, stderr: stdout },
				createReadline,
			},
		);

		assert.equal(questionAsked, true);
		assert.equal(outcome.exitCode, 0);
		assert.equal(outcome.result.ok, true);
		assert.equal(outcome.result.applied, true);
		assert.match(stdoutOutput, /Proposed changes to \.agents\/workflows\/prompts\/implementer\.md/);

		// Verify prompt file was written with learned invariant
		const promptPath = path.join(tempRoot, '.agents/workflows/prompts/implementer.md');
		assert.equal(fs.existsSync(promptPath), true);
		const promptContent = fs.readFileSync(promptPath, 'utf8');
		assert.match(promptContent, /<!-- Learned SDLC Rule: \[implementer\] tool_failure:test-runner-lookup -->/);
		assert.match(promptContent, /- Invariant \[test-runner-lookup\]: Always verify test-runner-lookup constraints before completing action\./);

		// Verify .agents/applied-skills.json
		const registryPath = path.join(tempRoot, '.agents/applied-skills.json');
		assert.equal(fs.existsSync(registryPath), true);
		const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
		assert.equal(registry.schemaVersion, '1.0.0');
		assert.equal(registry.applied.length, 1);
		assert.equal(registry.applied[0].findingKey, '[implementer] tool_failure:test-runner-lookup');
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('skills --apply with --yes flag applies cleanly without interactive prompt', async () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`skills-apply-yes-${crypto.randomUUID()}`,
	);
	try {
		seedSkillsRun(tempRoot, 'run-1', [{ attributionLayer: 'layer3' }]);
		seedSkillsRun(tempRoot, 'run-2', [{ attributionLayer: 'layer3' }]);
		seedSkillsRun(tempRoot, 'run-3', [{ attributionLayer: 'layer3' }]);

		let stdoutOutput = '';
		const stdout = new Writable({
			write(chunk, _encoding, callback) {
				stdoutOutput += chunk.toString();
				callback();
			},
		});

		let questionAsked = false;
		const createReadline = () => ({
			async question() {
				questionAsked = true;
				return 'y';
			},
			close() {},
		});

		const outcome = await runCli(
			['skills', '--apply', '--key', '[implementer] tool_failure:test-runner-lookup', '--yes'],
			{
				rootDir: tempRoot,
				streams: { stdin: { isTTY: false }, stdout, stderr: stdout },
				createReadline,
			},
		);

		assert.equal(questionAsked, false);
		assert.equal(outcome.exitCode, 0);
		assert.equal(outcome.result.ok, true);
		assert.equal(outcome.result.applied, true);

		const promptPath = path.join(tempRoot, '.agents/workflows/prompts/implementer.md');
		assert.equal(fs.existsSync(promptPath), true);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('skills --apply when operator declines with "n" aborts without mutating prompt file', async () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`skills-apply-decline-${crypto.randomUUID()}`,
	);
	try {
		seedSkillsRun(tempRoot, 'run-1', [{ attributionLayer: 'layer3' }]);
		seedSkillsRun(tempRoot, 'run-2', [{ attributionLayer: 'layer3' }]);
		seedSkillsRun(tempRoot, 'run-3', [{ attributionLayer: 'layer3' }]);

		let stdoutOutput = '';
		const stdout = new Writable({
			write(chunk, _encoding, callback) {
				stdoutOutput += chunk.toString();
				callback();
			},
		});

		const createReadline = () => ({
			async question() {
				return 'n';
			},
			close() {},
		});

		const outcome = await runCli(
			['skills', '--apply', '--key', '[implementer] tool_failure:test-runner-lookup'],
			{
				rootDir: tempRoot,
				streams: { stdin: { isTTY: true }, stdout, stderr: stdout },
				createReadline,
			},
		);

		assert.equal(outcome.exitCode, 0);
		assert.equal(outcome.result.applied, false);
		assert.match(outcome.result.message, /cancelled/i);

		const promptPath = path.join(tempRoot, '.agents/workflows/prompts/implementer.md');
		assert.equal(fs.existsSync(promptPath), false);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('skills --apply with invalid finding key rejects with INVALID_INPUT', async () => {
	const outcome = await runCli(
		['skills', '--apply', '--key', '[implementer] tool_failure:invalid-category'],
		{ rootDir: REPOSITORY_ROOT },
	);

	assert.equal(outcome.exitCode, 64);
	assert.equal(outcome.result.ok, false);
	assert.equal(outcome.result.error.code, 'INVALID_INPUT');
	assert.match(outcome.result.error.message, /not valid for signal/);
});

test('skills --apply writes the exact confirmed proposedDiff to disk, not canned fallback', async () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`skills-apply-custom-diff-${crypto.randomUUID()}`,
	);
	try {
		const customDiff = [
			'diff --git a/.agents/workflows/prompts/repairer.md b/.agents/workflows/prompts/repairer.md',
			'--- a/.agents/workflows/prompts/repairer.md',
			'+++ b/.agents/workflows/prompts/repairer.md',
			'@@ -1,1 +1,4 @@',
			'+<!-- Learned SDLC Rule: [repairer] churn_failure:typeorm-runner-leak -->',
			'+- Invariant [typeorm-runner-leak]: Custom specific leak constraint from auditor diff.',
		].join('\n');

		for (const runId of ['run-1', 'run-2', 'run-3']) {
			seedSkillsRun(tempRoot, runId, [
				{
					roleId: 'repairer',
					signalType: 'churn_failure',
					category: 'typeorm-runner-leak',
					findingKey: '[repairer] churn_failure:typeorm-runner-leak',
					attributionLayer: 'layer3',
					proposedDiff: customDiff,
				},
			]);
		}

		let stdoutOutput = '';
		const stdout = new Writable({
			write(chunk, _encoding, callback) {
				stdoutOutput += chunk.toString();
				callback();
			},
		});

		const outcome = await runCli(
			['skills', '--apply', '--key', '[repairer] churn_failure:typeorm-runner-leak', '--yes'],
			{
				rootDir: tempRoot,
				streams: { stdin: { isTTY: false }, stdout, stderr: stdout },
			},
		);

		assert.equal(outcome.exitCode, 0);
		assert.equal(outcome.result.applied, true);

		// Verify stdout showed custom diff
		assert.match(stdoutOutput, /Custom specific leak constraint from auditor diff\./);

		// Verify file on disk received the exact custom diff that was confirmed
		const promptPath = path.join(tempRoot, '.agents/workflows/prompts/repairer.md');
		assert.equal(fs.existsSync(promptPath), true);
		const promptContent = fs.readFileSync(promptPath, 'utf8');
		assert.match(promptContent, /Custom specific leak constraint from auditor diff\./);
		assert.doesNotMatch(promptContent, /Always verify typeorm-runner-leak constraints before completing action/);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});
