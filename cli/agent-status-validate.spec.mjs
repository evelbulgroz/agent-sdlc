import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateStatus } from '../agent-status-validate.ts';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../agent-status-validate.ts', import.meta.url));

function buildValidStatus(overrides = {}) {
	return {
		schemaVersion: 1,
		runId: "2026-09-01-test-feature",
		revision: 1,
		updatedAt: new Date().toISOString(),
		git: {
			branch: "main",
			headSha: "0123456789abcdef0123456789abcdef01234567",
			dirty: false,
		},
		lane: "agent",
		phase: "implement",
		activeOwner: "role:implement",
		changeClass: "A",
		retry: {
			count: 0,
			maxRetries: 2,
		},
		packages: ["packages/example"],
		tasks: [
			{
				id: "t1",
				title: "Implement feature",
				owner: "role:implement",
				status: "in_progress",
			},
		],
		verification: {
			lastResult: "not_run",
			preflight: {
				status: "not_run",
			},
		},
		...overrides,
	};
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'status-validate-'));

describe('agent-status-validate', () => {
	after(() => fs.rmSync(TMP, { recursive: true, force: true }));

	it('passes for a valid status.json', () => {
		const status = buildValidStatus();
		const result = validateStatus(status);
		assert.equal(result.ok, true);
		assert.equal(result.errors.length, 0);
	});

	it('accepts canonical phase: escalated with lane: escalate', () => {
		const status = buildValidStatus({
			phase: "escalated",
			lane: "escalate",
		});
		const result = validateStatus(status);
		assert.equal(result.ok, true);
	});

	it('validates optional orchestrated projection while preserving manual schema v1', () => {
		const hash = 'a'.repeat(64);
		const orchestrated = buildValidStatus({
			phase: 'spec',
			activeOwner: 'human',
			retry: { count: 0, maxRetries: 2, source: 'runtime.sqlite' },
			orchestration: {
				mode: 'langgraph',
				schemaVersion: '1.0.0',
				runtimeRevision: 7,
				state: 'WAITING_FOR_ANSWERS',
				eventLogHash: hash,
				draftHash: hash,
				pendingInterruptId: 'interrupt-1',
				projectionHash: hash,
			},
		});
		assert.equal(validateStatus(orchestrated).ok, true);
		const manual = buildValidStatus();
		assert.equal(validateStatus(manual).ok, true);
	});

	it('validates Slice 2 orchestrated status projections across execution phases and READY_FOR_GIT_APPROVAL', () => {
		const hash = 'a'.repeat(64);
		const base = {
			retry: { count: 0, maxRetries: 2, source: 'runtime.sqlite' },
			packages: ['packages/example'],
		};

		// 1. implement phase with EXECUTING_IMPLEMENTATION
		const implementStatus = buildValidStatus({
			...base,
			phase: 'implement',
			activeOwner: 'orchestrator:agent-sdlc',
			orchestration: {
				mode: 'langgraph',
				schemaVersion: '1.0.0',
				runtimeRevision: 10,
				state: 'EXECUTING_IMPLEMENTATION',
				eventLogHash: hash,
				draftHash: hash,
				pendingInterruptId: null,
				projectionHash: hash,
			},
		});
		assert.equal(validateStatus(implementStatus).ok, true);

		// 2. review phase with REVIEWING_GENERATION
		const reviewStatus = buildValidStatus({
			...base,
			phase: 'review',
			activeOwner: 'orchestrator:agent-sdlc',
			orchestration: {
				mode: 'langgraph',
				schemaVersion: '1.0.0',
				runtimeRevision: 12,
				state: 'REVIEWING_GENERATION',
				eventLogHash: hash,
				draftHash: hash,
				pendingInterruptId: null,
				projectionHash: hash,
			},
		});
		assert.equal(validateStatus(reviewStatus).ok, true);

		// 3. verify phase with VERIFYING_PREFLIGHT
		const verifyStatus = buildValidStatus({
			...base,
			phase: 'verify',
			activeOwner: 'orchestrator:agent-sdlc',
			orchestration: {
				mode: 'langgraph',
				schemaVersion: '1.0.0',
				runtimeRevision: 14,
				state: 'VERIFYING_PREFLIGHT',
				eventLogHash: hash,
				draftHash: hash,
				pendingInterruptId: null,
				projectionHash: hash,
			},
		});
		assert.equal(validateStatus(verifyStatus).ok, true);

		// 4. repair phase with REPAIRING_FAILURE
		const repairStatus = buildValidStatus({
			...base,
			phase: 'repair',
			activeOwner: 'orchestrator:agent-sdlc',
			retry: { count: 1, maxRetries: 2, source: 'runtime.sqlite' },
			orchestration: {
				mode: 'langgraph',
				schemaVersion: '1.0.0',
				runtimeRevision: 16,
				state: 'REPAIRING_FAILURE',
				eventLogHash: hash,
				draftHash: hash,
				pendingInterruptId: null,
				projectionHash: hash,
			},
		});
		assert.equal(validateStatus(repairStatus).ok, true);

		// 5. terminal READY_FOR_GIT_APPROVAL in phase review with activeOwner human
		const readyStatus = buildValidStatus({
			...base,
			phase: 'review',
			activeOwner: 'human',
			verification: {
				lastCommand: 'pnpm run verify -- --base 0123456789abcdef0123456789abcdef01234567',
				lastResult: 'pass',
				lastExitCode: 0,
				preflight: {
					status: 'OK',
				},
			},
			orchestration: {
				mode: 'langgraph',
				schemaVersion: '1.0.0',
				runtimeRevision: 20,
				state: 'READY_FOR_GIT_APPROVAL',
				eventLogHash: hash,
				draftHash: hash,
				pendingInterruptId: null,
				projectionHash: hash,
			},
		});
		assert.equal(validateStatus(readyStatus).ok, true);
	});

	it('rejects invalid orchestrated state, hash, source, and done projection', () => {
		const invalid = buildValidStatus({
			phase: 'done',
			verification: { preflight: { status: 'OK' } },
			retry: { count: 0, maxRetries: 2, source: 'status.json' },
			orchestration: {
				mode: 'langgraph',
				schemaVersion: '1.0.0',
				runtimeRevision: 1,
				state: 'UNKNOWN',
				eventLogHash: 'bad',
				draftHash: null,
				pendingInterruptId: null,
				projectionHash: null,
			},
		});
		const result = validateStatus(invalid);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((error) => error.includes('orchestration.state')));
		assert.ok(result.errors.some((error) => error.includes('runtime.sqlite')));
		assert.ok(result.errors.some((error) => error.includes("cannot project phase 'done'")));
	});

	it('fails on missing or invalid schemaVersion', () => {
		const status = buildValidStatus({ schemaVersion: 2 });
		const result = validateStatus(status);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => e.includes('schemaVersion')));
	});

	it('fails on invalid lane or phase enum', () => {
		const status = buildValidStatus({ lane: "unknown_lane", phase: "invalid_phase" });
		const result = validateStatus(status);
		assert.equal(result.ok, false);
		assert.ok(result.errors.some((e) => e.includes('Invalid lane')));
		assert.ok(result.errors.some((e) => e.includes('Invalid phase')));
	});

	it('enforces autonomous retry budget <= 2 even when phase is done', () => {
		const overLimitDone = buildValidStatus({
			retry: { count: 3, maxRetries: 2 },
			lane: "agent",
			phase: "done",
			verification: { preflight: { status: "OK" } },
		});
		const res1 = validateStatus(overLimitDone);
		assert.equal(res1.ok, false);
		assert.ok(res1.errors.some((e) => e.includes('Autonomous retry cap exceeded')));

		const escalated = buildValidStatus({
			retry: { count: 3, maxRetries: 2 },
			lane: "lane:escalate",
		});
		const res2 = validateStatus(escalated);
		assert.equal(res2.ok, true);
	});

	it('enforces monotonic revision when previous is provided', () => {
		const prev = buildValidStatus({ revision: 5, phase: "implement" });
		const equal = buildValidStatus({ revision: 5, phase: "implement" });
		const lower = buildValidStatus({ revision: 4, phase: "implement" });
		const higher = buildValidStatus({ revision: 6, phase: "verify" });

		assert.equal(validateStatus(equal, { previous: prev }).ok, false);
		assert.equal(validateStatus(lower, { previous: prev }).ok, false);
		assert.equal(validateStatus(higher, { previous: prev }).ok, true);
	});

	it('rejects invalid phase transitions from previous status', () => {
		const prevDone = buildValidStatus({ revision: 5, phase: "done", verification: { preflight: { status: "OK" } } });
		const backToImplement = buildValidStatus({ revision: 6, phase: "implement" });
		const resDone = validateStatus(backToImplement, { previous: prevDone });
		assert.equal(resDone.ok, false);
		assert.ok(resDone.errors.some((e) => e.includes("terminal phase 'done' cannot transition")));

		const prevSpec = buildValidStatus({ revision: 1, phase: "spec" });
		const directToDone = buildValidStatus({ revision: 2, phase: "done", verification: { preflight: { status: "OK" } } });
		const resSpec = validateStatus(directToDone, { previous: prevSpec });
		assert.equal(resSpec.ok, false);
		assert.ok(resSpec.errors.some((e) => e.includes("Invalid phase transition from 'spec' to 'done'")));
	});

	it('requires verification.preflight.status == OK when phase is done', () => {
		const incomplete = buildValidStatus({
			phase: "done",
			verification: { preflight: { status: "FAIL" } },
		});
		const res1 = validateStatus(incomplete);
		assert.equal(res1.ok, false);
		assert.ok(res1.errors.some((e) => e.includes("requires verification.preflight.status == 'OK'")));

		const done = buildValidStatus({
			phase: "done",
			verification: { preflight: { status: "OK" } },
		});
		const res2 = validateStatus(done);
		assert.equal(res2.ok, true);
	});

	it('CLI exits with code 1 when invoked without arguments', async () => {
		await assert.rejects(
			execFileAsync('node', [CLI]),
			(err) => {
				assert.equal(err.code, 1);
				assert.match(err.stderr, /Usage:/);
				return true;
			},
		);
	});

	it('CLI returns exit 0 on valid status file and exit 1 on invalid', async () => {
		const tmpValid = path.join(TMP, 'test-tmp-valid-status.json');
		const tmpInvalid = path.join(TMP, 'test-tmp-invalid-status.json');

		fs.writeFileSync(tmpValid, JSON.stringify(buildValidStatus(), null, 2));
		fs.writeFileSync(tmpInvalid, JSON.stringify(buildValidStatus({ lane: "bad" }), null, 2));

		try {
			const { stdout } = await execFileAsync('node', [CLI, tmpValid]);
			assert.match(stdout, /agent-status-validate: OK/);

			await assert.rejects(
				execFileAsync('node', [CLI, tmpInvalid]),
				(err) => {
					assert.equal(err.code, 1);
					assert.match(err.stderr, /Invalid lane/);
					return true;
				},
			);
		} finally {
			if (fs.existsSync(tmpValid)) fs.unlinkSync(tmpValid);
			if (fs.existsSync(tmpInvalid)) fs.unlinkSync(tmpInvalid);
		}
	});

	it('CLI rejects invalid transition with non-zero exit code', async () => {
		const tmpPrev = path.join(TMP, 'test-tmp-prev-done.json');
		const tmpCurr = path.join(TMP, 'test-tmp-curr-reopened.json');

		fs.writeFileSync(
			tmpPrev,
			JSON.stringify(buildValidStatus({ revision: 2, phase: "done", verification: { preflight: { status: "OK" } } }), null, 2),
		);
		fs.writeFileSync(
			tmpCurr,
			JSON.stringify(buildValidStatus({ revision: 3, phase: "implement" }), null, 2),
		);

		try {
			await assert.rejects(
				execFileAsync('node', [
					CLI,
					tmpCurr,
					'--previous',
					tmpPrev,
				]),
				(err) => {
					assert.equal(err.code, 1);
					assert.match(err.stderr, /terminal phase 'done' cannot transition/);
					return true;
				},
			);
		} finally {
			if (fs.existsSync(tmpPrev)) fs.unlinkSync(tmpPrev);
			if (fs.existsSync(tmpCurr)) fs.unlinkSync(tmpCurr);
		}
	});
});
