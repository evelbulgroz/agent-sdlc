import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
	aggregateCriticTrends,
	aggregateSkillsTrends,
	buildResult,
	buildSkillsResult,
	parseCliArgs,
} from './aggregate-critic-trends.ts';

function createTrendDatabase(rootDir, runId, structuredFindings) {
	const runtimeDir = path.join(rootDir, '.agent-sdlc', runId);
	fs.mkdirSync(runtimeDir, { recursive: true });
	const database = new DatabaseSync(path.join(runtimeDir, 'runtime.sqlite'));
	try {
		database.exec(`
			CREATE TABLE optional_role_executions (
				role_id TEXT NOT NULL,
				structured_findings_json TEXT
			)
		`);
		database
			.prepare(
				'INSERT INTO optional_role_executions (role_id, structured_findings_json) VALUES (?, ?)',
			)
			.run('architect', JSON.stringify(structuredFindings));
	} finally {
		database.close();
	}
}

function createSkillsDatabase(rootDir, runId, findings) {
	const runtimeDir = path.join(rootDir, '.agent-sdlc', runId);
	fs.mkdirSync(runtimeDir, { recursive: true });
	const database = new DatabaseSync(path.join(runtimeDir, 'runtime.sqlite'));
	try {
		database.exec(`
			CREATE TABLE prompt_friction_findings (
				finding_id TEXT PRIMARY KEY,
				role_id TEXT NOT NULL,
				signal_type TEXT NOT NULL,
				category TEXT NOT NULL,
				finding_key TEXT NOT NULL,
				status TEXT NOT NULL,
				attribution_layer TEXT,
				evidence_json TEXT,
				proposed_diff_json TEXT,
				created_at TEXT NOT NULL
			)
		`);
		const stmt = database.prepare(`
			INSERT INTO prompt_friction_findings (
				finding_id, role_id, signal_type, category, finding_key, status, attribution_layer, evidence_json, proposed_diff_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const f of findings) {
			stmt.run(
				f.findingId || `id-${Math.random()}`,
				f.roleId,
				f.signalType,
				f.category,
				f.findingKey,
				f.status || 'RECOMMENDED',
				f.attributionLayer || 'layer3',
				JSON.stringify(f.evidence || {}),
				f.proposedDiff ? JSON.stringify(f.proposedDiff) : null,
				new Date().toISOString(),
			);
		}
	} finally {
		database.close();
	}
}

function createGitArtifact(rootDir, runId, findings) {
	const dir = path.join(rootDir, '.agents/trace-findings');
	fs.mkdirSync(dir, { recursive: true });
	const artifact = {
		schemaVersion: '1.0.0',
		runId,
		analyzedAt: new Date().toISOString(),
		findings: findings.map((f) => ({
			findingId: f.findingId || `id-${Math.random()}`,
			roleId: f.roleId,
			signalType: f.signalType,
			category: f.category,
			findingKey: f.findingKey,
			attributionLayer: f.attributionLayer || 'layer3',
			status: f.status || 'RECOMMENDED',
			evidence: f.evidence || {},
			proposedDiff: f.proposedDiff || null,
		})),
	};
	fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify(artifact, null, 2));
}

test('aggregateCriticTrends proposes a graduation after three distinct runs', () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-trends-'));
	try {
		for (const runId of ['run-a', 'run-b', 'run-c']) {
			createTrendDatabase(rootDir, runId, {
				status: 'VIOLATIONS_DETECTED',
				violations: [
					{
						boundary: 'service-boundary-internal-import',
						file: 'services/example/src/example.ts',
						description: 'Use the contracts entrypoint.',
						severity: 'P1',
					},
				],
			});
		}

		const result = aggregateCriticTrends({ rootDir });

		assert.equal(result.databasesScanned, 3);
		assert.equal(result.proposals.length, 1);
		assert.equal(
			result.proposals[0].key,
			'[architect] boundary:service-boundary-internal-import',
		);
		assert.equal(result.proposals[0].runCount, 3);
		assert.equal(result.proposals[0].layer1.kind, 'dependency-cruiser');
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('aggregateCriticTrends handles an empty runtime root', () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-trends-empty-'));
	try {
		assert.deepEqual(aggregateCriticTrends({ rootDir }), {
			schemaVersion: '1.0.0',
			threshold: 3,
			databasesScanned: 0,
			trends: [],
			proposals: [],
		});
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('buildResult counts duplicate findings once per run toward graduation', () => {
	const result = buildResult([
		{ runId: 'run-a', source: 'hardener', key: '[hardener] shadow_path:error-paths' },
		{ runId: 'run-a', source: 'hardener', key: '[hardener] shadow_path:error-paths' },
		{ runId: 'run-b', source: 'hardener', key: '[hardener] shadow_path:error-paths' },
	]);

	assert.equal(result.trends[0].occurrences, 3);
	assert.equal(result.trends[0].runCount, 2);
	assert.equal(result.proposals.length, 0);
});

test('aggregateSkillsTrends: AC-03 provisional status when runCount < 3', () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-skills-ac03-'));
	try {
		for (const runId of ['run-1', 'run-2']) {
			createSkillsDatabase(rootDir, runId, [
				{
					roleId: 'implementer',
					signalType: 'tool_failure',
					category: 'test-runner-lookup',
					findingKey: '[implementer] tool_failure:test-runner-lookup',
					attributionLayer: 'layer3',
				},
			]);
		}

		const result = aggregateSkillsTrends({ rootDir });
		assert.equal(result.databasesScanned, 2);
		assert.equal(result.trends.length, 1);
		assert.equal(result.trends[0].status, 'PROVISIONAL');
		assert.equal(result.trends[0].runCount, 2);
		assert.equal(result.recommendedProposals.length, 0);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('aggregateSkillsTrends: AC-04 recommended proposal with unified diff when runCount >= 3 (layer3)', () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-skills-ac04-'));
	try {
		for (const runId of ['run-1', 'run-2', 'run-3']) {
			createSkillsDatabase(rootDir, runId, [
				{
					roleId: 'implementer',
					signalType: 'tool_failure',
					category: 'test-runner-lookup',
					findingKey: '[implementer] tool_failure:test-runner-lookup',
					attributionLayer: 'layer3',
				},
			]);
		}

		const result = aggregateSkillsTrends({ rootDir });
		assert.equal(result.databasesScanned, 3);
		assert.equal(result.trends.length, 1);
		assert.equal(result.trends[0].status, 'RECOMMENDED');
		assert.equal(result.trends[0].runCount, 3);
		assert.equal(result.recommendedProposals.length, 1);
		assert.equal(result.recommendedProposals[0].key, '[implementer] tool_failure:test-runner-lookup');
		assert.match(result.recommendedProposals[0].proposedDiff, /diff --git a\/\.agents\/workflows\/prompts\/implementer\.md/);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('aggregateSkillsTrends: AC-05 floor clamping when threshold < 3', () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-skills-ac05-'));
	try {
		for (const runId of ['run-1', 'run-2']) {
			createSkillsDatabase(rootDir, runId, [
				{
					roleId: 'specifier',
					signalType: 'rubric_gap',
					category: 'qa-divergence',
					findingKey: '[specifier] rubric_gap:qa-divergence',
					attributionLayer: 'layer3',
				},
			]);
		}

		// Pass threshold=1, should be clamped to 3 with notice
		const result = aggregateSkillsTrends({ rootDir, threshold: 1 });
		assert.equal(result.threshold, 3);
		assert.equal(result.floorEnforced, true);
		assert.match(result.notice, /clamped to 3/);
		assert.equal(result.recommendedProposals.length, 0); // runCount is 2, threshold is 3 -> provisional
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('aggregateSkillsTrends: Invariant 3 Ratchet Layer Merge Rule - layer1 overrides layer3', () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-skills-ratchet-'));
	try {
		// Run 1: attributed to layer3
		createSkillsDatabase(rootDir, 'run-1', [
			{
				roleId: 'implementer',
				signalType: 'tool_failure',
				category: 'test-runner-lookup',
				findingKey: '[implementer] tool_failure:test-runner-lookup',
				attributionLayer: 'layer3',
			},
		]);
		// Run 2: attributed to layer1 (mechanical)
		createSkillsDatabase(rootDir, 'run-2', [
			{
				roleId: 'implementer',
				signalType: 'tool_failure',
				category: 'test-runner-lookup',
				findingKey: '[implementer] tool_failure:test-runner-lookup',
				attributionLayer: 'layer1',
			},
		]);
		// Run 3: attributed to layer3
		createSkillsDatabase(rootDir, 'run-3', [
			{
				roleId: 'implementer',
				signalType: 'tool_failure',
				category: 'test-runner-lookup',
				findingKey: '[implementer] tool_failure:test-runner-lookup',
				attributionLayer: 'layer3',
			},
		]);

		const result = aggregateSkillsTrends({ rootDir });
		assert.equal(result.trends.length, 1);
		assert.equal(result.trends[0].runCount, 3);
		assert.equal(result.trends[0].status, 'RECOMMENDED');
		// Ratchet rule: layer1 must override layer3
		assert.equal(result.trends[0].attributionLayer, 'layer1');
		// Must NOT be in recommendedProposals (which is for prompt diffs)
		assert.equal(result.recommendedProposals.length, 0);
		// Must be in layer1Proposals
		assert.equal(result.layer1Proposals.length, 1);
		assert.equal(result.layer1Proposals[0].key, '[implementer] tool_failure:test-runner-lookup');
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('aggregateSkillsTrends: AC-13 dual-source ingestion from git artifacts and SQLite deduplication', () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-skills-dualsource-'));
	try {
		// Run 1 in SQLite
		createSkillsDatabase(rootDir, 'run-1', [
			{
				roleId: 'implementer',
				signalType: 'tool_failure',
				category: 'test-runner-lookup',
				findingKey: '[implementer] tool_failure:test-runner-lookup',
				attributionLayer: 'layer3',
			},
		]);

		// Run 1 ALSO in git artifact (same runId and findingKey -> must be deduped)
		createGitArtifact(rootDir, 'run-1', [
			{
				roleId: 'implementer',
				signalType: 'tool_failure',
				category: 'test-runner-lookup',
				findingKey: '[implementer] tool_failure:test-runner-lookup',
				attributionLayer: 'layer3',
			},
		]);

		// Run 2 ONLY in git artifact
		createGitArtifact(rootDir, 'run-2', [
			{
				roleId: 'implementer',
				signalType: 'tool_failure',
				category: 'test-runner-lookup',
				findingKey: '[implementer] tool_failure:test-runner-lookup',
				attributionLayer: 'layer3',
			},
		]);

		// Run 3 ONLY in git artifact
		createGitArtifact(rootDir, 'run-3', [
			{
				roleId: 'implementer',
				signalType: 'tool_failure',
				category: 'test-runner-lookup',
				findingKey: '[implementer] tool_failure:test-runner-lookup',
				attributionLayer: 'layer3',
			},
		]);

		const result = aggregateSkillsTrends({ rootDir });
		assert.equal(result.databasesScanned, 3); // run-1, run-2, run-3
		assert.equal(result.trends.length, 1);
		assert.equal(result.trends[0].runCount, 3);
		// occurrences should be 3 because run-1 in both sqlite and artifact was deduped
		assert.equal(result.trends[0].occurrences, 3);
		assert.equal(result.recommendedProposals.length, 1);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('parseCliArgs parses all valid arguments including --dry-run', () => {
	const parsed = parseCliArgs([
		'--dry-run',
		'--skills',
		'--json',
		'--threshold',
		'5',
		'--root',
		'/tmp/custom-root',
	]);
	assert.equal(parsed.dryRun, true);
	assert.equal(parsed.skills, true);
	assert.equal(parsed.json, true);
	assert.equal(parsed.threshold, 5);
	assert.equal(parsed.rootDir, path.resolve('/tmp/custom-root'));
});

test('parseCliArgs fails closed on unknown arguments or missing values', () => {
	assert.throws(
		() => parseCliArgs(['--unknown-flag']),
		/Unknown argument '--unknown-flag'/,
	);
	assert.throws(
		() => parseCliArgs(['--threshold']),
		/Missing value for '--threshold'/,
	);
	assert.throws(
		() => parseCliArgs(['--threshold', 'not-a-number']),
		/Invalid value for '--threshold'/,
	);
	assert.throws(
		() => parseCliArgs(['--threshold', '-1']),
		/Invalid value for '--threshold'/,
	);
	assert.throws(
		() => parseCliArgs(['--root']),
		/Missing value for '--root'/,
	);
});
