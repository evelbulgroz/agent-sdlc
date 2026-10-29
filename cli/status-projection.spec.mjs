import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as statusProjection from './status-projection.ts';
import { DatabaseSync } from 'node:sqlite';
import { runCli } from './cli.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { FakeModelGovernor } from '../testing/fake-model-governor.mjs';
import { completeProposal, grammaticalAcceptance } from '../testing/test-support.mjs';
import { slug, cleanupRun, writeResponse } from '../testing/cli-test-support.mjs';

test('projection retry reuses one durable event and regenerates missing status', async () => {
	const testSlug = slug('projection-retry');
	const governor = new FakeModelGovernor([completeProposal()]);
	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Retry projection idempotently'],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		runId = started.result.runId;
		const interrupted = await runCli(['cancel', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
			onBoundary(name) {
				if (name === 'projection-event-recorded') {
					throw new Error('simulated projection crash');
				}
			},
		});
		assert.equal(interrupted.exitCode, 70);
		const recovered = await runCli(['status', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(recovered.result.state, 'CANCELLED');
		const statusPath = path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId, 'status.json');
		fs.unlinkSync(statusPath);
		const regenerated = await runCli(['status', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(regenerated.result.state, 'CANCELLED');
		assert.equal(fs.existsSync(statusPath), true);
		const store = new RuntimeStore(
			path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
		);
		try {
			const projectionEvents = store
				.listEvents(runId)
				.filter(
					(event) =>
						event.eventType === 'PROJECTION_WRITTEN' &&
						event.runtimeRevision === store.getRun(runId).runtimeRevision,
				);
			assert.equal(projectionEvents.length, 1);
		} finally {
			store.close();
		}
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('projection recovery republishes a newer changed intent and status pair after intent publication crash', async () => {
	const testSlug = slug('projection-pair-recovery');
	const governor = new FakeModelGovernor([completeProposal()]);
	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Recover a changed draft projection pair'],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		runId = started.result.runId;
		const pending = started.result.pendingInterrupt;
		const response = {
			schemaVersion: '1.0.0',
			interruptId: pending.interruptId,
			stateHash: pending.request.stateHash,
			answers: [
				{ questionId: 'acceptance', value: grammaticalAcceptance('New intent and status recover together') },
				{ questionId: 'failure', value: 'Old status never rejects the newer outbox' },
				{ questionId: 'verification', value: 'Recover without duplicate projection events' },
			],
		};
		const interrupted = await runCli(
			[
				'answer',
				'--run',
				runId,
				'--interrupt',
				pending.interruptId,
				'--response-file',
				writeResponse(runId, 'projection-pair-answer', response),
			],
			{
				rootDir: REPOSITORY_ROOT,
				governor,
				onBoundary(name) {
					if (name === 'projection-intent-published') {
						throw new Error('simulated post-draft projection crash');
					}
				},
			},
		);
		assert.equal(interrupted.exitCode, 70);
		const recovered = await runCli(['status', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(recovered.result.state, 'WAITING_FOR_APPROVAL');
		const store = new RuntimeStore(
			path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'),
		);
		try {
			const state = store.getRun(runId);
			const record = store.getProjectionRecord(runId, state.runtimeRevision);
			const statusPath = path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId, 'status.json');
			const intentPath = path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId, 'intent.md');
			assert.deepEqual(JSON.parse(fs.readFileSync(statusPath, 'utf8')), record.status);
			assert.equal(fs.readFileSync(intentPath, 'utf8'), record.intent);
			assert.equal(
				store
					.listEvents(runId)
					.filter(
						(event) =>
							event.eventType === 'PROJECTION_WRITTEN' &&
							event.runtimeRevision === state.runtimeRevision,
					).length,
				1,
			);
		} finally {
			store.close();
		}
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('runtime reconciliation failures return 70 and do not masquerade as durable escalation', async () => {
	const testSlug = slug('reconciliation-exit');
	const governor = new FakeModelGovernor([completeProposal()]);
	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Detect canonical state corruption'],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		runId = started.result.runId;
		const databasePath = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite');
		const database = new DatabaseSync(databasePath);
		database.prepare('UPDATE runs SET state_hash = ? WHERE run_id = ?').run('0'.repeat(64), runId);
		database.close();
		const status = await runCli(['status', '--run', runId], {
			rootDir: REPOSITORY_ROOT,
			governor,
		});
		assert.equal(status.exitCode, 70);
		assert.equal(status.result.error.code, 'STORE_RECONCILIATION_FAILED');
	} finally {
		if (runId) cleanupRun(runId);
	}
});

test('CLI projects reversible auto-decisions into run decisions.md', async () => {
	const testSlug = slug('decisions-projection');
	const proposal = completeProposal();
	// Target an unresolved completeness field; patched fields are rejected as MODEL_OUTPUT_INVALID.
	proposal.questions.unshift({
		questionId: 'module-format',
		targets: ['acceptanceCriteria'],
		prompt: 'Should we use ESM or CommonJS for new tooling modules?',
		responseKind: 'text',
		options: [],
		required: false,
		rationale: 'Need to pick a module system.',
	});
	const governor = new FakeModelGovernor([proposal]);
	let runId;
	try {
		const started = await runCli(
			['start', '--slug', testSlug, '--goal', 'Record reversible ESM default without HITL'],
			{ rootDir: REPOSITORY_ROOT, governor },
		);
		assert.equal(started.exitCode, 2);
		runId = started.result.runId;
		const pendingQuestions = started.result.pendingInterrupt.request.questions.map(
			(question) => question.questionId,
		);
		assert.equal(pendingQuestions.includes('module-format'), false);
		const decisionsPath = path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId, 'decisions.md');
		const decisions = fs.readFileSync(decisionsPath, 'utf8');
		assert.match(decisions, /Module System/);
		assert.match(decisions, /ESM/);
		assert.match(decisions, /Should we use ESM or CommonJS/);
	} finally {
		if (runId) cleanupRun(runId);
	}
});

const PROJECTION_MODULES = [
	'status-projection.ts',
	'continuation.ts',
	'status-document.ts',
	'status-result.ts',
	'projection-artifacts.ts',
	'host-invocation.ts',
];

function moduleEdges(name) {
	const directory = path.dirname(new URL(import.meta.url).pathname);
	const source = fs.readFileSync(path.join(directory, name), 'utf8');
	const edges = [];
	for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
		const base = path.basename(path.normalize(path.join(directory, match[1])));
		if (PROJECTION_MODULES.includes(base)) edges.push(base);
	}
	return edges;
}

test('@ac AC-04 @case AC-04.1 continuation has one owner and the projection modules do not cycle', () => {
	const host = fs.readFileSync(new URL('./host-invocation.ts', import.meta.url), 'utf8');
	assert.match(host, /from '\.\/continuation\.ts'/);
	const visiting = new Set();
	const visited = new Set();
	function walk(name) {
		if (visiting.has(name)) throw new Error(`import cycle at ${name}`);
		if (visited.has(name)) return;
		visiting.add(name);
		for (const next of moduleEdges(name)) walk(next);
		visiting.delete(name);
		visited.add(name);
	}
	for (const name of PROJECTION_MODULES) walk(name);
});

test('@ac AC-04 @case AC-04.2 status-projection exports the frozen names', () => {
	assert.deepEqual(Object.keys(statusProjection).sort(), [
		'StatusProjection',
		'computeContinuation',
		'isInfrastructureContinuation',
	]);
});
