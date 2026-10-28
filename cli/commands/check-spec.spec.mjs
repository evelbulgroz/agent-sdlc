import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { runCli } from '../cli.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { RoleRegistry } from '../../roles/role-registry.ts';
import { slug, completeSpecMarkdown, completeSpecJson, runCheckSpec } from '../../testing/cli-test-support.mjs';

test('CLI check-spec rejects a slice goal that would exceed the 256 character task title limit', async () => {
	const manifest = JSON.parse(
		fs.readFileSync(
			path.join(REPOSITORY_ROOT, 'docs/specs/retired/conditioning-session-weather.tasks.json'),
			'utf8',
		),
	);
	manifest.slices[0].goal = 'x'.repeat(260);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-title-'));
	const manifestPath = path.join(directory, 'tasks.json');
	try {
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
		const outcome = await runCli(
			[
				'check-spec',
				'--goal-file',
				'docs/specs/retired/conditioning-session-weather.md',
				'--task-plan-file',
				manifestPath,
				'--json',
			],
			{ rootDir: REPOSITORY_ROOT },
		);
		assert.equal(outcome.exitCode, 64);
		assert.equal(outcome.result.error.code, 'TASK_PLAN_INVALID');
		assert.match(outcome.result.error.message, /derived title/);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('CLI check-spec rejects same-package tasks that have no dependency path between them', async () => {
	const manifest = JSON.parse(
		fs.readFileSync(
			path.join(REPOSITORY_ROOT, 'docs/specs/retired/conditioning-session-weather.tasks.json'),
			'utf8',
		),
	);
	manifest.tasks.find((task) => task.taskId === 'weather-backfill-task').dependsOn = [
		'weather-track-samples-task',
	];
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-concurrent-'));
	const manifestPath = path.join(directory, 'tasks.json');
	try {
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
		const outcome = await runCli(
			[
				'check-spec',
				'--goal-file',
				'docs/specs/retired/conditioning-session-weather.md',
				'--task-plan-file',
				manifestPath,
				'--json',
			],
			{ rootDir: REPOSITORY_ROOT },
		);
		assert.equal(outcome.exitCode, 64);
		assert.equal(outcome.result.error.code, 'TASK_PLAN_INVALID');
		assert.match(outcome.result.error.message, /Concurrent tasks/);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('@ac AC-18 policy README documents the closed bounded-plan authoring path', () => {
	const policyReadme = fs.readFileSync(
		path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/policy/README.md'),
		'utf8',
	);
	assert.match(policyReadme, /--task-plan-file <path>/);
	assert.match(policyReadme, /schemaVersion: "1\.0\.0"/);
	assert.match(policyReadme, /`enabling`/);
	assert.match(policyReadme, /`vertical`/);
	assert.match(policyReadme, /`activation`/);
});

test('@ac AC-01 check-spec reports a ready host-led file', async () => {
	const outcome = await runCheckSpec(['--goal', JSON.stringify(completeSpecJson()), '--json']);
	assert.equal(outcome.exitCode, 0);
	assert.equal(outcome.result.ok, true);
	assert.equal(outcome.result.ready, true);
	assert.equal(outcome.result.completeness.complete, true);
	assert.equal(outcome.result.acceptanceCriteriaQuality.complete, true);
	assert.equal(outcome.result.error?.code, undefined);
});

test('@ac AC-02 check-spec reports missing fields without creating a run', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-check-spec-'));
	try {
		const goalFile = path.join(tempDir, 'incomplete.md');
		fs.writeFileSync(goalFile, completeSpecMarkdown({ nonGoals: [] }));
		const outcome = await runCheckSpec(['--goal-file', goalFile, '--json']);
		assert.equal(outcome.exitCode, 2);
		assert.equal(outcome.result.ok, true);
		assert.equal(outcome.result.ready, false);
		assert.equal(outcome.result.completeness.complete, false);
		assert.ok(outcome.result.completeness.missingFields.includes('nonGoals'));
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-03 check-spec blocks readiness on ungrammatical criteria', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-check-spec-'));
	try {
		const goalFile = path.join(tempDir, 'ungrammatical.md');
		fs.writeFileSync(
			goalFile,
			completeSpecMarkdown({
				acceptanceCriteria: ['AC-1: Outcome. Given input. Then result.'],
			}),
		);
		const outcome = await runCheckSpec(['--goal-file', goalFile, '--json']);
		assert.equal(outcome.exitCode, 2);
		assert.equal(outcome.result.ready, false);
		assert.equal(outcome.result.acceptanceCriteriaQuality.complete, false);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-04 check-spec fails closed on non-allowlisted headings', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-check-spec-'));
	try {
		const goalFile = path.join(tempDir, 'renamed.md');
		fs.writeFileSync(
			goalFile,
			['# Intent', '', '## Goal', '', 'Ship the slice', '', '## Scope & Owning Context', '', 'Tooling', ''].join(
				'\n',
			),
		);
		const outcome = await runCheckSpec(['--goal-file', goalFile, '--json']);
		assert.equal(outcome.exitCode, 64);
		assert.equal(outcome.result.ok, false);
		assert.equal(outcome.result.error.code, 'INVALID_INPUT');
		assert.match(outcome.result.error.message, /Scope & Owning Context/);
		assert.match(outcome.result.error.message, /Owning context/);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-05 check-spec fails closed on extra JSON draft keys', async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-check-spec-'));
	try {
		const goalFile = path.join(tempDir, 'extra.json');
		fs.writeFileSync(
			goalFile,
			JSON.stringify(completeSpecJson({ approvedSpecHash: 'a'.repeat(64) })),
		);
		const outcome = await runCheckSpec(['--goal-file', goalFile]);
		assert.equal(outcome.exitCode, 64);
		assert.equal(outcome.result.ok, false);
		assert.equal(outcome.result.error.code, 'INVALID_CONTRACT');
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-06 check-spec does not contact the governor', async () => {
	const outcome = await runCheckSpec(['--goal', JSON.stringify(completeSpecJson())]);
	assert.equal(outcome.exitCode, 0);
	assert.notEqual(outcome.result.error?.code, 'GOVERNOR_UNAVAILABLE');
	assert.equal(outcome.result.ready, true);
});

test('@ac AC-07 check-spec rejects conflicting goal flags', async () => {
	const outcome = await runCheckSpec([
		'--goal',
		'Ship the slice',
		'--goal-file',
		'docs/specs/retired/recent-conditioning-sessions-list.md',
	]);
	assert.equal(outcome.exitCode, 64);
	assert.equal(outcome.result.ok, false);
	assert.equal(outcome.result.error.code, 'INVALID_INPUT');
});

test('@ac AC-08 check-spec rejects a missing goal file', async () => {
	const missing = path.join(os.tmpdir(), `sdlc-check-spec-missing-${crypto.randomUUID()}.md`);
	const outcome = await runCheckSpec(['--goal-file', missing]);
	assert.equal(outcome.exitCode, 64);
	assert.equal(outcome.result.error.code, 'INVALID_INPUT');
});

test('@ac AC-10 package CLI usage and README document check-spec --goal-file', () => {
	const readme = fs.readFileSync(
		path.join(REPOSITORY_ROOT, 'packages/agent-sdlc/README.md'),
		'utf8',
	);
	assert.match(readme, /agent-sdlc check-spec --goal-file/);
});

test('@ac AC-11 check-spec rejects oversized inline --goal', async () => {
	const maxGoalBytes = new RoleRegistry({ rootDir: REPOSITORY_ROOT }).load().workflow.limits
		.maxGoalBytes;
	const outcome = await runCheckSpec(['--goal', 'x'.repeat(maxGoalBytes + 1)]);
	assert.equal(outcome.exitCode, 64);
	assert.equal(outcome.result.error.code, 'INVALID_INPUT');
	assert.match(outcome.result.error.message, /exceeds configured size limit/);
});
