import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson, sha256, validateRuntimeState } from '../policy/contracts.ts';
import { MinimalExecutor } from '../execution/minimal-executor.ts';
import type { MinimalExecutorOptions, MinimalExecutorInput } from '../execution/minimal-executor-types.ts';
import type { ModelOperationInput } from '../persistence/model-operation-records.ts';
import type { FakeGovernorScriptItem } from './fake-model-governor.ts';
import { makeFixture } from './test-support-fixtures.ts';

type Transcript = Record<string, unknown> & { attempt: number };

function isTranscript(value: unknown): value is Transcript {
	const record = value as { kind?: unknown } | null;
	return record?.kind === 'minimal-executor-attempt';
}

interface StoreWithDatabase {
	database: { prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } };
}

export function readTranscripts(artifactsDir: string): Array<Record<string, unknown> & { attempt: number }> {
	return fs
		.readdirSync(artifactsDir)
		.filter((name) => name.endsWith('.json'))
		.map((name): unknown => JSON.parse(fs.readFileSync(path.join(artifactsDir, name), 'utf8')))
		.filter(isTranscript)
		.sort((left, right) => left.attempt - right.attempt);
}

export function sizedLog(bytes: number): string {
	const tail: string[] = [];
	for (let index = 0; index < 37; index += 1) tail.push(`pad-${index}`);
	tail.push('expected 1', 'expected 2', 'tests failed');
	const tailText = tail.join('\n');
	const chunks: string[] = [];
	let used = 0;
	let number = 0;
	while (used + Buffer.byteLength(tailText, 'utf8') < bytes) {
		const line = `H${String(number).padStart(5, '0')}\n`;
		if (used + Buffer.byteLength(line, 'utf8') + Buffer.byteLength(tailText, 'utf8') > bytes) break;
		chunks.push(line);
		used += Buffer.byteLength(line, 'utf8');
		number += 1;
	}
	chunks.push('x'.repeat(bytes - used - Buffer.byteLength(tailText, 'utf8')));
	chunks.push(tailText);
	const log = chunks.join('');
	assert.equal(Buffer.byteLength(log, 'utf8'), bytes);
	return log;
}

export function failedCommand(stdout: string): Error & { status: number; stdout: string; stderr: string } {
	return Object.assign(new Error('tests failed'), { status: 1, stdout, stderr: '' });
}

export interface OpenLoopOptions {
	label: string;
	script?: FakeGovernorScriptItem[];
	execCli?: MinimalExecutorOptions['execCli'];
	clock?: MinimalExecutorOptions['clock'];
	estimatePromptTokens?: MinimalExecutorOptions['estimatePromptTokens'];
	artifactStore?: MinimalExecutorOptions['artifactStore'];
	runtimeStore?: MinimalExecutorOptions['runtimeStore'];
	completionValidator?: MinimalExecutorOptions['completionValidator'];
}

export function openLoop({
	label,
	script,
	execCli,
	clock,
	estimatePromptTokens,
	artifactStore,
	runtimeStore,
	completionValidator,
}: OpenLoopOptions) {
	const fixture = makeFixture(label, script);
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-exec-'));
	const recorded: ModelOperationInput[] = [];
	const executor = new MinimalExecutor({
		governor: fixture.governor,
		artifactStore: artifactStore ?? fixture.artifacts,
		roleRegistry: fixture.registry,
		runtimeStore:
			runtimeStore === undefined
				? { recordModelOperation(operation: ModelOperationInput) { recorded.push(operation); } }
				: runtimeStore,
		execCli: execCli ?? (() => ''),
		...(clock ? { clock } : {}),
		...(estimatePromptTokens ? { estimatePromptTokens } : {}),
		...(completionValidator ? { completionValidator } : {}),
	});
	return {
		fixture,
		executor,
		worktreeDir,
		governor: fixture.governor,
		recorded,
		async close() {
			fixture.close();
			fs.rmSync(worktreeDir, { recursive: true, force: true });
		},
	};
}

export function loopInput(worktreeDir: string, extra: Partial<MinimalExecutorInput> = {}): MinimalExecutorInput {
	return {
		runId: 'run-minimal',
		taskId: 'task-a',
		worktreeDir,
		verificationCommands: [['pnpm', 'run', 'test:unit']],
		specSummary: 'Ship the slice',
		acceptanceCriteria: ['AC-04: the verification log survives'],
		agentsMd: 'Use pnpm',
		allowedWritePathPrefixes: ['src'],
		allowedPackages: [],
		...extra,
	};
}

export function seedRun(store: StoreWithDatabase, runId: string): void {
	const now = new Date().toISOString();
	const state = validateRuntimeState({
		schemaVersion: '1.0.0',
		runId,
		threadId: 'thread-1',
		runtimeRevision: 0,
		state: 'EXECUTING_IMPLEMENTATION',
		goalArtifact: 'a'.repeat(64),
		draftArtifact: null,
		draftHash: null,
		completeness: { complete: true, missingFields: [], ambiguousFields: [] },
		pendingInterruptId: null,
		approvedSpecHash: null,
		modelOperations: [],
		blockedReason: null,
		lastError: null,
		workflowHash: 'e'.repeat(64),
		roleHash: 'f'.repeat(64),
		promptPolicyHash: '1'.repeat(64),
		capabilitySetHash: '2'.repeat(64),
		evaluatorSetHash: '3'.repeat(64),
		completenessHash: null,
		activeModelOperationId: null,
		activeProposalArtifact: null,
		interviewRound: 0,
		activeGeneration: 0,
		worktreePath: null,
		semanticRepairsCount: 0,
		createdAt: now,
		updatedAt: now,
	});
	store.database
		.prepare(
			`
			INSERT INTO runs (
				run_id, thread_id, runtime_revision, state, state_hash,
				state_json, semantic_repairs_count, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		)
		.run(
			state.runId,
			state.threadId,
			state.runtimeRevision,
			state.state,
			sha256(state),
			canonicalJson(state),
			state.semanticRepairsCount,
			state.createdAt,
			state.updatedAt,
		);
}

export function operationRows(store: StoreWithDatabase, runId: string): unknown[] {
	return store.database
		.prepare(
			'SELECT status, output_artifact FROM model_operations WHERE run_id = ? ORDER BY operation_id',
		)
		.all(runId);
}
