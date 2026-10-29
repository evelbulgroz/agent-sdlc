import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runTraceSkillAuditor, ATTRIBUTION_OUTPUT_SCHEMA } from './trace-skill-auditor.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { createEvent } from '../policy/contracts.ts';
import { SdlcError, exitCodeForError } from '../policy/errors.ts';
import { validateOperationRequest } from '@evelbulgroz/model-usage-govenor/policy';
import { validateSchemaDefinition } from '@evelbulgroz/model-usage-govenor';

function setupRunFixture(rootDir, runId) {
	const runDir = path.join(rootDir, '.agent-sdlc', runId);
	fs.mkdirSync(runDir, { recursive: true });
	const store = new RuntimeStore(path.join(runDir, 'runtime.sqlite'));

	store.database.prepare(`
		INSERT INTO runs (run_id, thread_id, runtime_revision, state, state_hash, state_json, created_at, updated_at, semantic_repairs_count)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(runId, `thread-${runId}`, 2, 'READY_FOR_GIT_APPROVAL', 'hash', '{}', new Date().toISOString(), new Date().toISOString(), 1);

	store.appendEvent(
		createEvent({
			eventType: 'PROMPT_FRICTION_DETECTED',
			runId,
			runtimeRevision: 2,
			causalId: 'friction:1',
			payload: { repairs: 1, toolFailures: 1 },
		}),
	);

	store.recordToolExecution({
		schemaVersion: '1.0.0',
		executionId: `exec-${runId}-1`,
		runId,
		roleId: 'implementer',
		generation: 0,
		stepIndex: 0,
		toolName: 'run_allowlisted_command',
		inputHash: '1'.repeat(64),
		outputArtifact: null,
		exitCode: 1,
		createdAt: new Date().toISOString(),
	});

	store.close();
	return runDir;
}

test('AC-06 & AC-10: runTraceSkillAuditor attributes findings, enforces Layer 1 Ratchet rule, and operates idempotently', async () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`auditor-test-${crypto.randomUUID()}`,
	);
	const runId = '2026-09-01-attribution-test-run';
	setupRunFixture(tempRoot, runId);

	try {
		let capturedRequest = null;
		const mockGovernor = {
			assertAvailable: async () => true,
			execute: async (req) => {
				capturedRequest = req;
				validateOperationRequest(req);
				assert.equal(req.runId, `trace-audit-${runId}`);
				assert.equal(req.routingConstraints?.strategy, 'quality-first');
				assert.equal(req.routingConstraints?.minQualityTier, 3);
				return {
					output: {
						findings: [
							{
								roleId: 'implementer',
								signalType: 'tool_failure',
								category: 'script-missing',
								attributionLayer: 'layer1',
								explanation: 'Package test:unit script missing from package.json',
								evidence: 'script key: test:unit',
								proposedDiff: 'diff --git a/prompts/implementer.md', // Must be stripped for layer1!
							},
						],
					},
				};
			},
		};

		const result = await runTraceSkillAuditor({
			runId,
			rootDir: tempRoot,
			governor: mockGovernor,
		});

		assert.equal(result.ok, true);
		assert.ok(capturedRequest);
		assert.equal(result.findings.length, 1);
		const finding = result.findings[0];
		assert.equal(finding.findingKey, '[implementer] tool_failure:script-missing');
		assert.equal(finding.attributionLayer, 'layer1');
		assert.equal(finding.proposedDiff, null); // Layer 1 Ratchet rule enforced!
		// The governed model's free-text evidence string is re-wrapped into the
		// object shape SkillFindingsSyncArtifactSchema expects.
		assert.deepEqual(finding.evidence, { note: 'script key: test:unit' });

		// Verify sync artifact was written to .agents/trace-findings/<run-id>.json (AC-13)
		const artifactPath = path.join(tempRoot, `.agents/trace-findings/${runId}.json`);
		assert.ok(fs.existsSync(artifactPath));
		const artifactContent = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
		assert.equal(artifactContent.schemaVersion, '1.0.0');
		assert.equal(artifactContent.runId, runId);
		assert.equal(artifactContent.findings.length, 1);
		assert.equal(artifactContent.findings[0].findingKey, '[implementer] tool_failure:script-missing');

		// Invariant 2 verification: runtimeRevision is UNCHANGED
		const store = new RuntimeStore(path.join(tempRoot, '.agent-sdlc', runId, 'runtime.sqlite'));
		const runRow = store.database.prepare('SELECT runtime_revision FROM runs WHERE run_id = ?').get(runId);
		assert.equal(runRow.runtime_revision, 2); // Checkpoint preserved!
		assert.equal(store.hasUnreviewedFriction(runId), false);

		const events = store.listEvents(runId);
		const analyzedEvent = events.find((e) => e.eventType === 'PROMPT_FRICTION_ANALYZED');
		assert.ok(analyzedEvent);
		assert.equal(analyzedEvent.runtimeRevision, 2);

		// AC-10: Idempotent re-run
		const rerun = await runTraceSkillAuditor({
			runId,
			rootDir: tempRoot,
			governor: mockGovernor,
		});
		assert.equal(rerun.ok, true);
		assert.equal(rerun.findings.length, 1);
		const dbFindings = store.listPromptFrictionFindings(runId);
		assert.equal(dbFindings.length, 1); // Not duplicated
		store.close();
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('AC-07: runTraceSkillAuditor handles governor concurrency denial with exit code 3 and 0 DB corruption', async () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`auditor-concurrency-${crypto.randomUUID()}`,
	);
	const runId = '2026-09-02-concurrency-test-run';
	setupRunFixture(tempRoot, runId);

	try {
		const mockGovernor = {
			assertAvailable: async () => true,
			execute: async () => {
				throw new SdlcError('GOVERNOR_CONCURRENCY_DENIED', 'Rate limit exceeded on provider route');
			},
		};

		await assert.rejects(
			async () => {
				await runTraceSkillAuditor({
					runId,
					rootDir: tempRoot,
					governor: mockGovernor,
				});
			},
			(err) => {
				assert.equal(err.code, 'GOVERNOR_CONCURRENCY_DENIED');
				assert.equal(exitCodeForError(err), 3);
				return true;
			},
		);

		// Verify 0 SQLite corruption and no partial finding rows
		const store = new RuntimeStore(path.join(tempRoot, '.agent-sdlc', runId, 'runtime.sqlite'));
		const findings = store.listPromptFrictionFindings(runId);
		assert.equal(findings.length, 0);
		store.close();
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('AC-11: runTraceSkillAuditor rejects model output violating closed category vocabulary with atomic rollback', async () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`auditor-invalid-vocab-${crypto.randomUUID()}`,
	);
	const runId = '2026-09-03-invalid-vocab-test-run';
	setupRunFixture(tempRoot, runId);

	try {
		const mockGovernor = {
			assertAvailable: async () => true,
			execute: async () => ({
				output: {
					findings: [
						{
							roleId: 'implementer',
							signalType: 'tool_failure',
							category: 'invalid-open-ended-category', // VIOLATION!
							attributionLayer: 'layer3',
							explanation: 'Custom category',
						},
					],
				},
			}),
		};

		await assert.rejects(
			async () => {
				await runTraceSkillAuditor({
					runId,
					rootDir: tempRoot,
					governor: mockGovernor,
				});
			},
			(err) => {
				assert.equal(err.code, 'MODEL_OUTPUT_INVALID');
				return true;
			},
		);

		// Verify 0 rows inserted in SQLite
		const store = new RuntimeStore(path.join(tempRoot, '.agent-sdlc', runId, 'runtime.sqlite'));
		const findings = store.listPromptFrictionFindings(runId);
		assert.equal(findings.length, 0);
		store.close();
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('runTraceSkillAuditor sanitizes unsafe or traversal proposedDiff to null before persisting sync artifact', async () => {
	const tempRoot = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/test-fixtures',
		`auditor-unsafe-diff-${crypto.randomUUID()}`,
	);
	const runId = '2026-09-04-unsafe-diff-test-run';
	setupRunFixture(tempRoot, runId);

	try {
		const mockGovernor = {
			assertAvailable: async () => true,
			execute: async () => ({
				output: {
					findings: [
						{
							roleId: 'implementer',
							signalType: 'tool_failure',
							category: 'test-runner-lookup',
							attributionLayer: 'layer3',
							explanation: 'Runner lookup failure',
							// Unsafe diff targeting arbitrary file and traversal
							proposedDiff: 'diff --git a/../secret.txt b/../secret.txt\n+malicious',
						},
					],
				},
			}),
		};

		const result = await runTraceSkillAuditor({
			runId,
			rootDir: tempRoot,
			governor: mockGovernor,
		});

		assert.equal(result.ok, true);
		assert.equal(result.findings.length, 1);
		// proposedDiff must be sanitized to null
		assert.equal(result.findings[0].proposedDiff, null);

		const artifactPath = path.join(tempRoot, `.agents/trace-findings/${runId}.json`);
		assert.ok(fs.existsSync(artifactPath));
		const artifactContent = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
		assert.equal(artifactContent.findings[0].proposedDiff, null);
	} finally {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('regression: ATTRIBUTION_OUTPUT_SCHEMA is portable to the governed structured-output subset', () => {
	// Guards against GOVERNOR_UNAVAILABLE at runtime: the mockGovernor used above
	// forwards requests straight to validateOperationRequest(), which only checks
	// that structuredOutputSchema is an object — it does not exercise the real
	// governor's provider-portable keyword/type checks. Assert those directly
	// against the actual schema this script sends, so an unsupported construct
	// (e.g. a bare `type: [...]` array instead of `anyOf`) fails here instead of
	// surfacing only against a live governed run.
	assert.doesNotThrow(() => validateSchemaDefinition(ATTRIBUTION_OUTPUT_SCHEMA));
});
