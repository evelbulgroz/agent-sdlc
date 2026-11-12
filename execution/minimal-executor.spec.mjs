import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	SdlcError,
} from '../policy/errors.ts';
import {
	MINIMAL_ATTEMPT_WALL_MS,
	MINIMAL_TOOL_CALL_CAP,
	MinimalExecutor,
} from './minimal-executor.ts';
import {
	makeFixture,
} from '../testing/test-support.mjs';
import {
	REPOSITORY_ROOT,
} from '../persistence/run-paths.ts';
import {
	RoleRegistry,
} from '../roles/role-registry.ts';
import {
	failedCommand,
	loopInput,
	openLoop,
	operationRows,
	readTranscripts,
	seedRun,
} from '../testing/minimal-executor-fixtures.ts';
import { FILE_MODIFIED_FEEDBACK } from './last-summary.ts';

test('@ac AC-06 five identical reads stay open and can still complete', async () => {
	const loop = openLoop({
		label: 'repeat-reads',
		script: [
			...Array.from({ length: 5 }, () => ({
				action: { kind: 'tool_call', toolName: 'read_file', parameters: { path: 'note.txt' } },
			})),
			{ action: { kind: 'complete', summary: 'done' } },
		],
	});
	try {
		fs.writeFileSync(path.join(loop.worktreeDir, 'note.txt'), 'same-bytes\n');
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'completed');
		assert.equal(loop.governor.calls.length, 6);
		const transcripts = readTranscripts(loop.fixture.artifacts.artifactsDir);
		assert.equal(transcripts.length, 1);
		assert.equal(transcripts[0].passed, true);
		assert.equal(transcripts[0].failureReason, null);
		assert.equal(transcripts[0].toolCalls.length, 5);
		for (const call of transcripts[0].toolCalls) {
			assert.equal(call.parameters.path, 'note.txt');
			assert.match(call.result.content, /same-bytes/);
		}
	} finally {
		await loop.close();
	}
});

test('a null validator completes zero edits when verification exits 0', async () => {
	const loop = openLoop({
		label: 'null-validator',
		script: [{ action: { kind: 'complete', summary: 'done' } }],
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'completed');
		assert.equal(result.failureReason, null);
		assert.equal(loop.governor.calls.length, 1);
	} finally {
		await loop.close();
	}
});

test('@ac AC-07 @case AC-07.1 the 150th tool call stops the attempt without another model call', async () => {
	const read = {
		action: { kind: 'tool_call', toolName: 'read_file', parameters: { path: 'note.txt' } },
	};
	const loop = openLoop({
		label: 'tool-cap',
		script: Array.from({ length: MINIMAL_TOOL_CALL_CAP + 1 }, () => structuredClone(read)),
	});
	try {
		fs.writeFileSync(path.join(loop.worktreeDir, 'note.txt'), 'same-bytes\n');
		const result = await loop.executor.execute(loopInput(loop.worktreeDir, { maxSourceEditIterations: 1 }));
		assert.equal(result.status, 'failed');
		assert.equal(result.failureReason, 'tool-calls');
		assert.equal(result.attempts, 1);
		assert.equal(loop.governor.calls.length, MINIMAL_TOOL_CALL_CAP);
		assert.equal(readTranscripts(loop.fixture.artifacts.artifactsDir).length, 1);
	} finally {
		await loop.close();
	}
});

test('@ac AC-07 @case AC-07.2 an injected 60 minute clock stops the attempt', async () => {
	let ticks = 0;
	const loop = openLoop({
		label: 'wall-clock',
		script: [{ action: { kind: 'complete', summary: 'must not run' } }],
		clock: () => {
			ticks += 1;
			return ticks === 1 ? 0 : MINIMAL_ATTEMPT_WALL_MS;
		},
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'failed');
		assert.equal(result.failureReason, 'wall-time');
		assert.equal(loop.governor.calls.length, 0);
		assert.equal(loop.governor.reserveCalls.length, 0);
	} finally {
		await loop.close();
	}
});

test('@ac AC-03 @case AC-03.1 @ac AC-07 @case AC-07.3 a prompt over the implementer ceiling is not sent', async () => {
	const { role } = new RoleRegistry({ rootDir: REPOSITORY_ROOT }).loadRole('implementer');
	assert.equal(role.requestedLimits.maxPromptTokens, 968000);
	const loop = openLoop({
		label: 'prompt-ceiling',
		script: [{ action: { kind: 'complete', summary: 'must not run' } }],
		estimatePromptTokens: () => ({ promptTokens: 968001 }),
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'failed');
		assert.equal(result.failureReason, 'maxPromptTokens');
		assert.equal(loop.governor.calls.length, 0);
		assert.equal(loop.governor.reserveCalls.length, 0);
	} finally {
		await loop.close();
	}
});

test('a governor error is recorded and is not retried', async () => {
	const loop = openLoop({
		label: 'governor-error',
		script: [],
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'failed');
		assert.equal(result.failureReason, 'GOVERNOR_ROUTES_EXHAUSTED');
		assert.equal(loop.governor.calls.length, 1);
		assert.equal(loop.recorded.length, 1);
		assert.equal(loop.recorded[0].status, 'failed');
		assert.equal(loop.recorded[0].outputArtifact, null);
		assert.equal(loop.recorded[0].errorCode, 'GOVERNOR_ROUTES_EXHAUSTED');
		const transcripts = readTranscripts(loop.fixture.artifacts.artifactsDir);
		assert.equal(transcripts.length, 1);
		assert.equal(transcripts[0].failureReason, 'GOVERNOR_ROUTES_EXHAUSTED');
	} finally {
		await loop.close();
	}
});

test('an artifact store failure rejects the attempt and does not complete it', async () => {
	const loop = openLoop({
		label: 'store-down',
		script: [{ action: { kind: 'complete', summary: 'done' } }],
		artifactStore: {
			writeJson() {
				throw new Error('store-down');
			},
		},
		runtimeStore: null,
	});
	try {
		await assert.rejects(
			() => loop.executor.execute(loopInput(loop.worktreeDir)),
			(error) => error.message === 'store-down',
		);
		assert.equal(loop.governor.calls.length, 1);
	} finally {
		await loop.close();
	}
});

test('an empty verification sequence fails before a model call', async () => {
	const loop = openLoop({
		label: 'verification-missing',
		script: [{ action: { kind: 'complete', summary: 'must not run' } }],
	});
	try {
		const result = await loop.executor.execute(
			loopInput(loop.worktreeDir, { verificationCommands: [] }),
		);
		assert.equal(result.status, 'failed');
		assert.equal(result.failureReason, 'verification-missing');
		assert.equal(loop.governor.calls.length, 0);
		const transcripts = readTranscripts(loop.fixture.artifacts.artifactsDir);
		assert.equal(transcripts.length, 1);
		assert.equal(transcripts[0].failureReason, 'verification-missing');
	} finally {
		await loop.close();
	}
});

test('preferred routes and a failover cap reach the governor request', async () => {
	const previousPreferred = process.env.AGENT_SDLC_PREFERRED_ROUTES;
	const previousCap = process.env.AGENT_SDLC_MAX_ROUTE_FAILOVERS;
	process.env.AGENT_SDLC_PREFERRED_ROUTES = 'google-gemini-quality, anthropic-claude-quality';
	process.env.AGENT_SDLC_MAX_ROUTE_FAILOVERS = '0';
	const loop = openLoop({
		label: 'preferred-routes',
		script: [{ action: { kind: 'complete', summary: 'done' } }],
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'completed');
		assert.deepEqual(loop.governor.calls[0].routingConstraints.preferredRouteIds, [
			'google-gemini-quality',
			'anthropic-claude-quality',
		]);
		assert.equal(loop.governor.calls[0].requestedLimits.maxFailovers, 0);
	} finally {
		if (previousPreferred === undefined) delete process.env.AGENT_SDLC_PREFERRED_ROUTES;
		else process.env.AGENT_SDLC_PREFERRED_ROUTES = previousPreferred;
		if (previousCap === undefined) delete process.env.AGENT_SDLC_MAX_ROUTE_FAILOVERS;
		else process.env.AGENT_SDLC_MAX_ROUTE_FAILOVERS = previousCap;
		await loop.close();
	}
});

test('@ac AC-11 model calls stay on the governor and the module imports no provider SDK', async () => {
	const directory = new URL('./', import.meta.url);
	const sources = fs.readdirSync(directory).filter((name) => /^minimal-.*\.ts$/.test(name) && !name.endsWith('.spec.ts'));
	assert.ok(sources.includes('minimal-executor.ts'));
	assert.ok(sources.includes('minimal-prompt.ts'));
	assert.ok(sources.includes('minimal-verification.ts'));
	for (const name of sources) {
		const source = fs.readFileSync(new URL(name, directory), 'utf8');
		for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
			assert.equal(/openai|anthropic|@google|xai/.test(match[1]), false, name);
		}
	}
	const loop = openLoop({
		label: 'governor-only',
		script: [{ action: { kind: 'complete', summary: 'done' } }],
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'completed');
		assert.equal(loop.governor.calls.length, 1);
		assert.equal(loop.governor.calls[0].consumer, 'agent-sdlc');
		assert.equal(loop.governor.calls[0].profile, 'agent-sdlc-default');
		assert.equal(loop.recorded[0].status, 'succeeded');
		assert.match(loop.recorded[0].outputArtifact, /^[a-f0-9]{64}$/);
		assert.equal(
			loop.fixture.store.getArtifact(loop.recorded[0].outputArtifact).type,
			'model-proposal',
		);
	} finally {
		await loop.close();
	}
});

test('a thrown SdlcError from the governor keeps its code', async () => {
	const loop = openLoop({
		label: 'typed-governor-error',
		script: [new SdlcError('GOVERNOR_ROUTES_EXHAUSTED', 'No allowed governed model route completed')],
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.failureReason, 'GOVERNOR_ROUTES_EXHAUSTED');
		assert.equal(loop.governor.calls.length, 1);
	} finally {
		await loop.close();
	}
});

test('a succeeded operation row references a model-proposal artifact', async () => {
	const runId = '2026-10-16-proposal-artifact';
	const fixture = makeFixture('proposal-artifact', [
		{ action: { kind: 'complete', summary: 'done' } },
	]);
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-exec-'));
	seedRun(fixture.store, runId);
	const executor = new MinimalExecutor({
		governor: fixture.governor,
		artifactStore: fixture.artifacts,
		roleRegistry: fixture.registry,
		runtimeStore: fixture.store,
		execCli: () => '',
	});
	try {
		const result = await executor.execute(loopInput(worktreeDir, { runId }));
		assert.equal(result.status, 'completed');
		const rows = operationRows(fixture.store, runId);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].status, 'succeeded');
		assert.match(rows[0].output_artifact, /^[a-f0-9]{64}$/);
		assert.equal(fixture.store.getArtifact(rows[0].output_artifact).type, 'model-proposal');
		const verifications = fixture.store.listDiagnostics(runId, 'reliability.verification-attempt');
		assert.equal(verifications.length, 1);
		assert.equal(verifications[0].payload.phase, 'post-implementation');
		assert.equal(verifications[0].payload.status, 'passed');
		assert.equal(verifications[0].payload.exitCode, 0);
	} finally {
		fixture.close();
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
});

test('an attempt transcript above 524288 bytes is stored', async () => {
	const payload = 'x'.repeat(30_000);
	const loop = openLoop({
		label: 'large-transcript',
		script: [
			...Array.from({ length: 12 }, () => ({
				action: {
					kind: 'tool_call',
					toolName: 'run_allowlisted_command',
					parameters: { command: 'pnpm', args: ['run', 'test:unit'] },
				},
			})),
			{ action: { kind: 'complete', summary: 'done' } },
		],
		execCli: () => payload,
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'completed');
		const sizes = fs
			.readdirSync(loop.fixture.artifacts.artifactsDir)
			.map((name) => fs.statSync(path.join(loop.fixture.artifacts.artifactsDir, name)).size);
		assert.equal(sizes.some((size) => size > 524_288), true);
	} finally {
		await loop.close();
	}
});

test('a failed operation row stores no output artifact', async () => {
	const runId = '2026-10-16-proposal-artifact-failed';
	const fixture = makeFixture('proposal-artifact-failed', []);
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimal-exec-'));
	seedRun(fixture.store, runId);
	const executor = new MinimalExecutor({
		governor: fixture.governor,
		artifactStore: fixture.artifacts,
		roleRegistry: fixture.registry,
		runtimeStore: fixture.store,
		execCli: () => '',
	});
	try {
		const result = await executor.execute(loopInput(worktreeDir, { runId }));
		assert.equal(result.status, 'failed');
		const rows = operationRows(fixture.store, runId);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].status, 'failed');
		assert.equal(rows[0].output_artifact, null);
	} finally {
		fixture.close();
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
});

const readNote = () => ({ action: { kind: 'tool_call', toolName: 'read_file', parameters: { path: 'note.txt' } } });
const writeSrcNote = () => ({ action: { kind: 'tool_call', toolName: 'write_file', parameters: { path: 'src/note.txt', content: 'edited\n' } } });
const complete = (summary) => ({ action: { kind: 'complete', summary } });
const commandCall = { action: { kind: 'tool_call', toolName: 'run_allowlisted_command', parameters: { command: 'pnpm', args: ['run', 'test:unit'] } } };
const GATE_ESLINT = '[eslint] sonarjs/no-duplicate-string src/a.ts:1 - duplicate (abcd)';
const GATE_JSCPD = '[jscpd] clone src/a.ts:4-6 — baseline clone at src/a.ts:1-3 shifted to lines 4-6. Keep lines 1-3 at their original line numbers (place new imports after line 3).';
const GATE_NOTE = '[note] quality-gate only re-evaluates when you emit {"kind":"complete","summary":"..."}. Once your edits and test runs pass, declare complete to re-run quality-gate.';
const gateSummary = (lines) => ['quality-gate failed', ...lines].join('\n');

function assertAfter(prompt, head, parts) {
	const start = prompt.indexOf(head);
	assert.ok(start >= 0, head);
	for (const part of parts) assert.ok(prompt.indexOf(part) > start, part);
}

test('@ac AC-01 a tool-call cap before the last attempt continues with a residue and without raw tool bodies', async () => {
	let commands = 0;
	const loop = openLoop({
		label: 'cap-residue',
		script: [complete('first'), commandCall, ...Array.from({ length: 149 }, readNote), complete('last')],
		execCli() { commands += 1; if (commands === 2) throw failedCommand('cmd-sentinel-outcome'); return ''; },
		completionValidator: () => ({ pass: false, summary: gateSummary([GATE_ESLINT, GATE_NOTE]) }),
	});
	try {
		fs.writeFileSync(path.join(loop.worktreeDir, 'note.txt'), 'cap-sentinel-bytes');
		const result = await loop.executor.execute(loopInput(loop.worktreeDir, { authoredPaths: ['src/a.ts'] }));
		const prompt = loop.governor.calls.at(-1).prompt;
		assertAfter(prompt, 'Attempt ended at the tool-call cap of 150. Raw tool results were dropped.', [
			'note.txt', 'Last command exit 1', 'cmd-sentinel-outcome', 'quality-gate failed', 'sonarjs/no-duplicate-string',
		]);
		assert.equal(prompt.includes('### Tool results') || prompt.includes('cap-sentinel-bytes'), false);
		const capped = readTranscripts(loop.fixture.artifacts.artifactsDir).find((entry) => entry.attempt === 2);
		assert.equal(capped.failureReason, 'tool-calls');
		assert.equal(capped.toolCalls.filter((call) => call.toolName === 'read_file' && call.parameters.path === 'note.txt').length, 149);
		assert.equal(result.status, 'failed');
		assert.equal(result.attempts, 3);
	} finally { await loop.close(); }
});

test('@ac AC-02 a tool-call cap on the last attempt fails the task and the cap stays 150', async () => {
	assert.equal(MINIMAL_TOOL_CALL_CAP, 150);
	const loop = openLoop({ label: 'cap-last', script: Array.from({ length: 150 }, readNote) });
	try {
		fs.writeFileSync(path.join(loop.worktreeDir, 'note.txt'), 'x\n');
		const result = await loop.executor.execute(loopInput(loop.worktreeDir, { maxSourceEditIterations: 1 }));
		assert.equal(result.status, 'failed');
		assert.equal(result.failureReason, 'tool-calls');
		assert.equal(result.attempts, 1);
		assert.equal(loop.governor.calls.length, 150);
	} finally { await loop.close(); }
});

test('@ac AC-03 quality-gate findings stay as the pre-write result, including the re-run note', async () => {
	const loop = openLoop({
		label: 'pre-write-gate',
		script: [complete('gate'), writeSrcNote(), complete('after')],
		completionValidator: () => ({ pass: false, summary: gateSummary([GATE_ESLINT, GATE_JSCPD, GATE_NOTE]) }),
	});
	try {
		const result = await loop.executor.execute(loopInput(loop.worktreeDir, { maxSourceEditIterations: 2 }));
		const prompt = loop.governor.calls[2].prompt;
		assertAfter(prompt, 'Quality-gate findings below are the pre-write result.', [
			'sonarjs/no-duplicate-string', 'Keep lines 1-3', '[note] quality-gate only re-evaluates',
		]);
		assert.notEqual(prompt, FILE_MODIFIED_FEEDBACK);
		assert.equal(result.attempts, 2);
	} finally { await loop.close(); }
});

test('@ac AC-04 @case AC-04.1 a source write still replaces AUDIT_REQUIRED feedback', async () => {
	const loop = openLoop({ label: 'audit-write', script: [complete('candidate'), writeSrcNote(), complete('after')] });
	try {
		await loop.executor.execute(loopInput(loop.worktreeDir, { auditGate: true, maxSourceEditIterations: 1 }));
		const prompt = loop.governor.calls[2].prompt;
		assert.match(prompt, /Previous check reported an issue, and a file has since been modified/);
		assert.equal(prompt.includes('candidateDigest'), false);
	} finally { await loop.close(); }
});

test('@ac AC-04 @case AC-04.2 a continued cap clears the audit digest and the next complete verifies', async () => {
	let checks = 0;
	const loop = openLoop({
		label: 'cap-clears-digest',
		script: [complete('candidate'), ...Array.from({ length: MINIMAL_TOOL_CALL_CAP }, readNote), complete('verified')],
		completionValidator() { checks += 1; return { pass: true }; },
	});
	try {
		fs.writeFileSync(path.join(loop.worktreeDir, 'note.txt'), 'unchanged\n');
		const result = await loop.executor.execute(loopInput(loop.worktreeDir, { auditGate: true, maxSourceEditIterations: 2 }));
		assert.equal(checks, 2);
		assert.equal(loop.governor.calls.length, 152);
		assert.equal(result.status, 'completed');
		assert.equal(result.attempts, 2);
	} finally { await loop.close(); }
});

test('@ac AC-05 the executor and its spec stay within the navigability budget', () => {
	for (const name of ['minimal-executor.ts', 'minimal-executor.spec.mjs']) {
		const data = fs.readFileSync(new URL(name, import.meta.url));
		let lines = 0;
		for (const byte of data) if (byte === 10) lines += 1;
		assert.ok(lines <= 500 && data.length <= 20480, `${name} ${lines} lines ${data.length} bytes`);
	}
});

test('an exhausted governor script after a continued cap fails the task', async () => {
	const loop = openLoop({ label: 'cap-then-empty', script: Array.from({ length: MINIMAL_TOOL_CALL_CAP }, readNote) });
	try {
		fs.writeFileSync(path.join(loop.worktreeDir, 'note.txt'), 'x\n');
		const result = await loop.executor.execute(loopInput(loop.worktreeDir));
		assert.equal(result.status, 'failed');
		assert.equal(result.failureReason, 'GOVERNOR_ROUTES_EXHAUSTED');
	} finally { await loop.close(); }
});
