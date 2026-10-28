import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { RuntimeStore } from '../persistence/runtime-store.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PERSISTENCE = path.join(ROOT, 'packages/agent-sdlc/persistence');

const FROZEN_PROTOTYPE_NAMES = [
	'appendContinuationProjection',
	'appendEvent',
	'appendProjectionEvent',
	'assertOpen',
	'cancelInterrupt',
	'clearContinuationAttempts',
	'close',
	'constructor',
	'countModelOperations',
	'createInterrupt',
	'deleteContinuationAttempt',
	'enqueueLearningOutbox',
	'eventLogHash',
	'findContinuationProjection',
	'getArtifact',
	'getAuthorization',
	'getCheckpointRow',
	'getContinuationAttempt',
	'getContinuationAttempts',
	'getEvent',
	'getGeneration',
	'getGitCommit',
	'getInterrupt',
	'getLatestGeneration',
	'getLatestReconciliation',
	'getMaxRecordedGeneration',
	'getModelOperation',
	'getPendingInterrupt',
	'getProjectionRecord',
	'getProjectionRevision',
	'getPromptFrictionFinding',
	'getPullRequest',
	'getReconciliation',
	'getRun',
	'getSemanticRepairsCount',
	'getTask',
	'getTaskPlan',
	'getToolExecution',
	'hasAuthorization',
	'hasRun',
	'hasUnreviewedFriction',
	'incrementSemanticRepairs',
	'initializeRun',
	'insertEvent',
	'insertInterrupt',
	'insertLearningOutboxRow',
	'insertPromptFrictionFinding',
	'latestDurableProjection',
	'listCandidateLearnings',
	'listCheckpointRows',
	'listCheckpointWrites',
	'listCriticReviews',
	'listDiagnostics',
	'listEvents',
	'listGenerations',
	'listOptionalRoleExecutions',
	'listPendingLearningOutbox',
	'listPendingProjections',
	'listPromptFrictionFindings',
	'listTasks',
	'listToolExecutions',
	'markLearningOutboxPublished',
	'markProjectionPublished',
	'migrate',
	'putCheckpointRow',
	'putCheckpointWrite',
	'queueProjection',
	'reconcile',
	'recordCandidateLearning',
	'recordContinuationAttempt',
	'recordDiagnostic',
	'recordEvent',
	'recordFrictionAnalyzed',
	'recordInterruptResponse',
	'recordModelOperation',
	'recordPostMortem',
	'recordReviewOutcome',
	'recordToolExecution',
	'registerArtifact',
	'reserveProjection',
	'resolveInterrupt',
	'saveAuthorization',
	'saveCriticReview',
	'saveGeneration',
	'saveGitCommit',
	'saveOptionalRoleExecution',
	'saveProjectionPayload',
	'savePullRequest',
	'saveReconciliation',
	'saveResumeFromEscalation',
	'saveTaskPlan',
	'saveTransition',
	'transaction',
	'updateTaskStatus',
	'upsertCandidateLearningRow',
];

const PRODUCTION = [
	'packages/agent-sdlc/persistence/runtime-store.ts',
	'packages/agent-sdlc/persistence/store-migrations.ts',
	'packages/agent-sdlc/persistence/store-integrity.ts',
	'packages/agent-sdlc/persistence/run-ledger.ts',
	'packages/agent-sdlc/persistence/checkpoint-records.ts',
	'packages/agent-sdlc/persistence/delivery-records.ts',
	'packages/agent-sdlc/persistence/review-records.ts',
	'packages/agent-sdlc/persistence/generation-records.ts',
	'packages/agent-sdlc/persistence/task-plan-records.ts',
	'packages/agent-sdlc/persistence/interrupt-records.ts',
	'packages/agent-sdlc/persistence/model-operation-records.ts',
	'packages/agent-sdlc/persistence/projection-records.ts',
	'packages/agent-sdlc/persistence/learning-records.ts',
	'packages/agent-sdlc/persistence/friction-records.ts',
	'packages/agent-sdlc/persistence/migrations/baseline-schema.ts',
	'packages/agent-sdlc/persistence/migrations/upgrades-v1-v7.ts',
	'packages/agent-sdlc/persistence/migrations/upgrades-v8-v13.ts',
];

const SPECS = [
	'packages/agent-sdlc/persistence/runtime-store.spec.mjs',
	'packages/agent-sdlc/persistence/store-migrations.spec.mjs',
	'packages/agent-sdlc/persistence/store-integrity.spec.mjs',
	'packages/agent-sdlc/persistence/run-ledger.spec.mjs',
	'packages/agent-sdlc/persistence/checkpoint-records.spec.mjs',
	'packages/agent-sdlc/persistence/delivery-records.spec.mjs',
	'packages/agent-sdlc/persistence/review-records.spec.mjs',
	'packages/agent-sdlc/persistence/generation-records.spec.mjs',
	'packages/agent-sdlc/persistence/task-plan-records.spec.mjs',
	'packages/agent-sdlc/persistence/interrupt-records.spec.mjs',
	'packages/agent-sdlc/persistence/model-operation-records.spec.mjs',
	'packages/agent-sdlc/persistence/projection-records.spec.mjs',
	'packages/agent-sdlc/persistence/learning-records.spec.mjs',
	'packages/agent-sdlc/persistence/friction-records.spec.mjs',
	'packages/agent-sdlc/persistence/migrations/baseline-schema.spec.mjs',
	'packages/agent-sdlc/persistence/migrations/upgrades-v1-v7.spec.mjs',
	'packages/agent-sdlc/persistence/migrations/upgrades-v8-v13.spec.mjs',
	'packages/agent-sdlc/workflow/fleet.spec.mjs',
	'packages/agent-sdlc/testing/deepen-store.spec.mjs',
];

const EXCEPTION_PATHS = [
	...PRODUCTION,
	...SPECS,
	'packages/agent-sdlc/testing/legacy-store-schemas.mjs',
	'packages/agent-sdlc/testing/navigability-exceptions.json',
];

const SQL_OWNERS = PRODUCTION.filter((rel) => !rel.endsWith('/runtime-store.ts'));

function measure(rel) {
	const data = fs.readFileSync(path.join(ROOT, rel));
	let lines = 0;
	for (const byte of data) if (byte === 0x0a) lines += 1;
	return { lines, bytes: data.length };
}

function productionSources(directory, relBase, found) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const rel = `${relBase}/${entry.name}`;
		if (entry.isDirectory()) {
			productionSources(path.join(directory, entry.name), rel, found);
			continue;
		}
		if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) found.push(rel);
	}
	return found;
}

test('@ac AC-05 @case AC-05.1 RuntimeStore keeps the frozen prototype names', () => {
	const names = Object.getOwnPropertyNames(RuntimeStore.prototype).sort();
	assert.equal(names.length, 95);
	assert.deepEqual(names, FROZEN_PROTOTYPE_NAMES);
});

test('@ac AC-05 @case AC-05.2 production persistence modules do not import the store facade', () => {
	// Specs under persistence/ open RuntimeStore, including the pre-existing
	// langgraph checkpointer spec and the migration specs. The import ban is
	// the production module boundary.
	const sources = productionSources(PERSISTENCE, 'packages/agent-sdlc/persistence', []);
	for (const rel of sources) {
		if (rel === 'packages/agent-sdlc/persistence/runtime-store.ts') continue;
		const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
		assert.equal(/from\s+['"][^'"]*runtime-store\.(?:mjs|ts)['"]/.test(source), false, rel);
	}
});

test('@ac AC-05 @case AC-05.3 record and migration modules do not begin their own transactions', () => {
	for (const rel of SQL_OWNERS) {
		const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
		assert.equal(/\b(?:BEGIN|COMMIT|ROLLBACK)\b/.test(source), false, rel);
	}
});

test('@ac AC-05 @case AC-05.4 the run ledger imports no other record module', () => {
	const source = fs.readFileSync(path.join(PERSISTENCE, 'run-ledger.ts'), 'utf8');
	const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]).sort();
	assert.deepEqual(imports, ['../policy/contracts.ts', '../policy/errors.ts']);
});

test('@ac AC-05 @case AC-05.5 a new store exposes database as DatabaseSync', () => {
	const root = path.join(ROOT, 'tools/.agent-sdlc/test-fixtures', `database-sync-${crypto.randomUUID()}`);
	fs.mkdirSync(root, { recursive: true });
	try {
		const store = new RuntimeStore(path.join(root, 'runtime.sqlite'));
		assert.equal(store.database instanceof DatabaseSync, true);
		store.close();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-06 @case AC-06.1 store production modules are within the ceiling', () => {
	for (const rel of PRODUCTION) {
		const size = measure(rel);
		assert.ok(size.lines <= 500, `${rel} lines ${size.lines}`);
		assert.ok(size.bytes <= 20480, `${rel} bytes ${size.bytes}`);
	}
});

test('@ac AC-06 @case AC-06.2 store spec files are within the ceiling', () => {
	for (const rel of SPECS) {
		const size = measure(rel);
		assert.ok(size.lines <= 500, `${rel} lines ${size.lines}`);
		assert.ok(size.bytes <= 20480, `${rel} bytes ${size.bytes}`);
	}
});

test('@ac AC-06 @case AC-06.3 store paths are absent from the navigability exceptions', () => {
	const exceptions = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/agent-sdlc/testing/navigability-exceptions.json'), 'utf8'));
	for (const rel of EXCEPTION_PATHS) assert.equal(Object.hasOwn(exceptions, rel), false, rel);
});
