import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { DatabaseSync } from 'node:sqlite';
import { ArtifactStore } from './artifacts.ts';
import { STORE_SCHEMA_VERSION, createEvent, emptyDraft, sha256 } from '../policy/contracts.ts';
import { RuntimeStoreCheckpointer } from './langgraph-checkpointer.ts';
import { REPOSITORY_ROOT } from './run-paths.ts';
import { RuntimeStore } from './runtime-store.ts';
import { makeFixture } from '../testing/test-support.mjs';

test('public custom checkpointer persists interrupt and resumes after reopen', async () => {
	const root = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`checkpoint-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(root, { recursive: true });
	const databasePath = path.join(root, 'runtime.sqlite');
	const counters = { before: 0, after: 0 };
	const build = (store) => {
		const State = Annotation.Root({ answer: Annotation() });
		return new StateGraph(State)
			.addNode('ask', () => {
				counters.before += 1;
				const answer = interrupt({ question: 'Continue?' });
				counters.after += 1;
				return { answer };
			})
			.addEdge(START, 'ask')
			.addEdge('ask', END)
			.compile({ checkpointer: new RuntimeStoreCheckpointer(store) });
	};
	let store = new RuntimeStore(databasePath);
	const config = {
		configurable: {
			thread_id: 'durable-thread',
			checkpoint_ns: 'caller-supplied-root',
		},
	};
	try {
		const paused = await build(store).invoke({}, config);
		assert.equal(paused.__interrupt__[0].value.question, 'Continue?');
		assert.equal(counters.before, 1);
		assert.equal(counters.after, 0);
		store.close();
		store = new RuntimeStore(databasePath);
		const resumed = await build(store).invoke(new Command({ resume: 'yes' }), config);
		assert.equal(resumed.answer, 'yes');
		assert.deepEqual(counters, { before: 2, after: 1 });
		const tuples = [];
		for await (const tuple of new RuntimeStoreCheckpointer(store).list({
			configurable: { thread_id: 'durable-thread' },
		})) {
			tuples.push(tuple);
		}
		assert.ok(tuples.length >= 2);
		assert.ok(
			tuples.every((tuple) => tuple.config.configurable.checkpoint_ns === ''),
			'LangGraph owns the root checkpoint namespace and normalizes it to the empty string',
		);
	} finally {
		store.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('runtime store creates, reopens, appends idempotent events, and reconciles revisions', () => {
	const fixture = makeFixture('store', []);
	try {
		const initial = fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Build a durable specification workflow',
		});
		assert.equal(initial.state, 'SPEC_DRAFTING');
		const event = createEvent({
			eventType: 'PROJECTION_WRITTEN',
			runId: fixture.runId,
			runtimeRevision: initial.runtimeRevision,
			state: initial,
			input: null,
			output: { hash: sha256('projection') },
			causalId: 'projection-test',
			payload: { hash: sha256('projection') },
			now: new Date(initial.updatedAt),
		});
		fixture.store.appendEvent(event);
		fixture.store.appendEvent(event);
		assert.equal(
			fixture.store.listEvents(fixture.runId).filter((item) => item.eventId === event.eventId)
				.length,
			1,
		);
		assert.equal(fixture.store.reconcile(fixture.runId).state.runId, fixture.runId);
		fixture.store.close();
		fixture.store = new RuntimeStore(path.join(fixture.runtimeDir, 'runtime.sqlite'));
		assert.equal(fixture.store.getRun(fixture.runId).state, 'SPEC_DRAFTING');
		fixture.store.close();
	} finally {
		fixture.close();
	}
});

test('store rejects lock contention, corruption, and unknown migrations', () => {
	const root = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`store-errors-${crypto.randomUUID()}`,
	);
	fs.mkdirSync(root, { recursive: true });
	const busyPath = path.join(root, 'busy.sqlite');
	const store = new RuntimeStore(busyPath, { busyTimeoutMs: 25 });
	const lock = new DatabaseSync(busyPath);
	try {
		lock.exec('BEGIN IMMEDIATE');
		assert.throws(
			() => store.transaction(() => store.database.exec('CREATE TABLE blocked (id INTEGER)')),
			(error) => error.code === 'STORE_BUSY',
		);
		lock.exec('ROLLBACK');
		store.close();
		const corruptPath = path.join(root, 'corrupt.sqlite');
		fs.writeFileSync(corruptPath, new Uint8Array([1, 2, 3, 4]));
		assert.throws(
			() => new RuntimeStore(corruptPath),
			(error) => error.code === 'STORE_CORRUPT',
		);
		const newerPath = path.join(root, 'newer.sqlite');
		const newer = new DatabaseSync(newerPath);
		newer.exec(
			'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
		);
		newer
			.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
			.run(STORE_SCHEMA_VERSION + 1, new Date().toISOString());
		newer.close();
		assert.throws(
			() => new RuntimeStore(newerPath),
			(error) => error.code === 'STORE_VERSION_UNSUPPORTED',
		);
	} finally {
		try {
			lock.close();
		} catch {
			// The test assertion is authoritative.
		}
		try {
			store.close();
		} catch {
			// The test assertion is authoritative.
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('artifact storage verifies JSON, blob-like text, and hash corruption', () => {
	const fixture = makeFixture('artifact', []);
	try {
		const artifact = fixture.artifacts.writeJson('draft', emptyDraft('Artifact test'));
		assert.equal(fixture.artifacts.readJson(artifact).goal, 'Artifact test');
		const metadata = fixture.store.getArtifact(artifact);
		const filename = path.join(fixture.runtimeDir, metadata.storagePath);
		fs.writeFileSync(filename, 'tampered');
		assert.throws(
			() => fixture.artifacts.read(artifact),
			(error) => error.code === 'ARTIFACT_CORRUPT',
		);
	} finally {
		fixture.close();
	}
});
