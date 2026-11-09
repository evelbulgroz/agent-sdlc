import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../policy/contracts.ts';
import { reviewRecord } from '../testing/critic-fixtures.ts';
import { makeFixture } from '../testing/test-support.mjs';
import {
	SPEC_CRITIC_CAP,
	assertCriticAllowed,
	findingsFromExistingReview,
	nextRound,
	planAttemptKey,
	qaAttemptKey,
	qaCheckpointAttemptKey,
	qaCheckpointReviewOperationId,
	specAttemptKey,
} from './critic-budget.ts';

test('assertCriticAllowed forbids spec critic after approvedSpecHash is frozen', () => {
	assert.throws(
		() =>
			assertCriticAllowed({
				phase: 'spec',
				snapshot: { approvedSpecHash: 'a'.repeat(64) },
			}),
		(error) => error.code === 'POLICY_VIOLATION',
	);
	assert.doesNotThrow(() =>
		assertCriticAllowed({ phase: 'spec', snapshot: { approvedSpecHash: null } }),
	);
});

test('@ac AC-04 @case AC-04.1 nextRound skips the same artifactHash and caps spec attempts per attemptKey', () => {
	const fixture = makeFixture('critic-gate-rounds', []);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Track critic rounds',
		});
		const hashA = 'a'.repeat(64);
		const hashB = 'b'.repeat(64);
		const hashC = 'c'.repeat(64);
		const snapshot = { runId: fixture.runId, approvedSpecHash: null };

		assert.equal(
			nextRound({
				phase: 'spec',
				snapshot,
				artifactHash: hashA,
				attemptKey: 'spec:0',
				runtimeStore: fixture.store,
			}).action,
			'dispatch',
		);

		fixture.store.saveCriticReview(reviewRecord(fixture.runId, { artifactHash: hashA }));
		const skip = nextRound({
			phase: 'spec',
			snapshot,
			artifactHash: hashA,
			attemptKey: 'spec:0',
			runtimeStore: fixture.store,
		});
		assert.equal(skip.action, 'skip');
		assert.equal(skip.existing.artifactHash, hashA);

		fixture.store.saveCriticReview(reviewRecord(fixture.runId, { artifactHash: hashB }));
		const exhausted = nextRound({
			phase: 'spec',
			snapshot,
			artifactHash: hashC,
			attemptKey: 'spec:0',
			runtimeStore: fixture.store,
		});
		assert.equal(exhausted.action, 'budget_exhausted');
		assert.equal(exhausted.count, SPEC_CRITIC_CAP);

		const newAttempt = nextRound({
			phase: 'spec',
			snapshot,
			artifactHash: hashC,
			attemptKey: 'spec:1',
			runtimeStore: fixture.store,
		});
		assert.equal(newAttempt.action, 'dispatch');
	} finally {
		fixture.close();
	}
});

test('@ac AC-09 @case AC-09.5 checkpoint QA keys isolate slice and final candidates from legacy QA reuse', () => {
	const fixture = makeFixture('critic-gate-checkpoint-qa', []);
	try {
		fixture.runtime.initialize({ runId: fixture.runId, goal: 'Checkpoint QA admission' });
		const specHash = 'a'.repeat(64);
		const planHash = 'b'.repeat(64);
		const firstKey = qaCheckpointAttemptKey({
			approvedSpecHash: specHash,
			taskPlanHash: planHash,
			checkpointKind: 'slice',
			sliceId: 'slice-one',
			treeSha: 'c'.repeat(40),
		});
		const nextSliceKey = qaCheckpointAttemptKey({
			approvedSpecHash: specHash,
			taskPlanHash: planHash,
			checkpointKind: 'slice',
			sliceId: 'slice-two',
			treeSha: 'd'.repeat(40),
		});
		const finalKey = qaCheckpointAttemptKey({
			approvedSpecHash: specHash,
			taskPlanHash: planHash,
			checkpointKind: 'final',
			treeSha: 'e'.repeat(40),
		});
		fixture.store.saveCriticReview(reviewRecord(fixture.runId, {
			phase: 'qa',
			artifactHash: 'f'.repeat(64),
			attemptKey: firstKey,
		}));
		const snapshot = { runId: fixture.runId };
		assert.equal(nextRound({
			phase: 'qa', snapshot, artifactHash: '1'.repeat(64), attemptKey: nextSliceKey,
			runtimeStore: fixture.store, checkpointAware: true,
		}).action, 'dispatch');
		assert.equal(nextRound({
			phase: 'qa', snapshot, artifactHash: '2'.repeat(64), attemptKey: finalKey,
			runtimeStore: fixture.store, checkpointAware: true,
		}).action, 'dispatch');
		assert.equal(nextRound({
			phase: 'qa', snapshot, artifactHash: 'f'.repeat(64), attemptKey: firstKey,
			runtimeStore: fixture.store, checkpointAware: true,
		}).action, 'skip');
		assert.match(firstKey, new RegExp(`^qa:${specHash}:${planHash}:slice:slice-one:${'c'.repeat(40)}$`));
		assert.match(finalKey, new RegExp(`^qa:${specHash}:${planHash}:final:${'e'.repeat(40)}$`));
		assert.notEqual(
			qaCheckpointReviewOperationId({
				runId: fixture.runId, checkpointId: 'checkpoint-one', candidateRevision: 0, attemptKey: firstKey,
			}),
			qaCheckpointReviewOperationId({
				runId: fixture.runId, checkpointId: 'checkpoint-one', candidateRevision: 1, attemptKey: firstKey,
			}),
		);
	} finally {
		fixture.close();
	}
});

test('checkpoint-aware QA admission lets persisted follow-up budget decide after the initial review', () => {
	const decision = nextRound({
		phase: 'qa',
		artifactHash: 'b'.repeat(64),
		attemptKey: 'qa:checkpoint',
		runtimeStore: {
			listCriticReviews: () => [{
				phase: 'qa',
				artifactHash: 'a'.repeat(64),
				attemptKey: 'qa:checkpoint',
			}],
		},
		checkpointAware: true,
		snapshot: { runId: '2026-11-01-sdlc-fixture' },
	});

	assert.equal(decision.action, 'dispatch');
	assert.equal(decision.count, 1);
});

test('nextRound skips a legacy QA review whose artifactHash and attemptKey do not match current keys', () => {
	const fixture = makeFixture('critic-gate-qa-legacy-skip', []);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Reuse stored QA critic',
		});
		const storedHash = '1'.repeat(64);
		const currentHash = '2'.repeat(64);
		const findings = [{ severity: 'P1', category: 'testing', file: 'a.spec.ts' }];
		fixture.store.saveCriticReview(
			reviewRecord(fixture.runId, {
				phase: 'qa',
				artifactHash: storedHash,
				attemptKey: `qa:${fixture.runId}:g0`,
				hasP1: true,
				findingsJson: JSON.stringify(findings),
			}),
		);
		const round = nextRound({
			phase: 'qa',
			snapshot: { runId: fixture.runId, approvedSpecHash: 'a'.repeat(64) },
			artifactHash: currentHash,
			attemptKey: qaAttemptKey('a'.repeat(64)),
			runtimeStore: fixture.store,
		});
		assert.equal(round.action, 'skip');
		assert.equal(round.existing.artifactHash, storedHash);
		assert.deepEqual(findingsFromExistingReview(round.existing), findings);
	} finally {
		fixture.close();
	}
});

test('findingsFromExistingReview hydrates skip payloads from findingsJson', () => {
	const findings = [
		{
			severity: 'P1',
			category: 'testing',
			file: 'frontends/example-pwa-frontend/src/ui/AnalysisPage.spec.tsx',
			evidence: 'DIVERGENT AC-04',
			impact: 'Invariant broken',
			remediation: 'Keep last series selected',
		},
	];
	assert.deepEqual(
		findingsFromExistingReview({ findingsJson: JSON.stringify(findings) }),
		findings,
	);
	assert.deepEqual(findingsFromExistingReview({ findingsJson: 'not-json' }), []);
	assert.deepEqual(findingsFromExistingReview({ hasP1: true }), []);
	assert.deepEqual(findingsFromExistingReview(null), []);
});

test('nextRound rejects missing artifactHash and attemptKey', () => {
	const fixture = makeFixture('critic-gate-nil', []);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: 'Nil critic inputs',
		});
		const snapshot = { runId: fixture.runId };
		assert.throws(
			() =>
				nextRound({
					phase: 'spec',
					snapshot,
					artifactHash: null,
					attemptKey: 'spec:0',
					runtimeStore: fixture.store,
				}),
			(error) => error.code === 'INVALID_CONTRACT',
		);
		assert.throws(
			() =>
				nextRound({
					phase: 'spec',
					snapshot,
					artifactHash: sha256('x'),
					attemptKey: '',
					runtimeStore: fixture.store,
				}),
			(error) => error.code === 'INVALID_CONTRACT',
		);
	} finally {
		fixture.close();
	}
});

test('assertCriticAllowed forbids plan critic before authorization and after freeze', () => {
	assert.throws(
		() =>
			assertCriticAllowed({
				phase: 'plan',
				snapshot: { approvedSpecHash: 'a'.repeat(64) },
			}),
		(error) => error.code === 'POLICY_VIOLATION',
	);
	assert.doesNotThrow(() =>
		assertCriticAllowed({
			phase: 'plan',
			snapshot: {
				approvedSpecHash: 'a'.repeat(64),
				approvedPlanPolicyHash: 'b'.repeat(64),
				taskPlanFrozen: false,
			},
		}),
	);
	assert.throws(
		() =>
			assertCriticAllowed({
				phase: 'plan',
				snapshot: {
					approvedSpecHash: 'a'.repeat(64),
					approvedPlanPolicyHash: 'b'.repeat(64),
					taskPlanFrozen: true,
				},
			}),
		(error) => error.code === 'POLICY_VIOLATION',
	);
	assert.equal(planAttemptKey('c'.repeat(64)), `plan:${'c'.repeat(64)}`);
});

test('assertCriticAllowed forbids QA critic without a bound green preflight', () => {
	assert.throws(
		() =>
			assertCriticAllowed({
				phase: 'qa',
				snapshot: { approvedSpecHash: 'a'.repeat(64) },
			}),
		(error) => error.code === 'POLICY_VIOLATION',
	);
	assert.doesNotThrow(() =>
		assertCriticAllowed({
			phase: 'qa',
			snapshot: {
				approvedSpecHash: 'a'.repeat(64),
				preflightBindingArtifact: 'b'.repeat(64),
			},
		}),
	);
	assert.equal(qaAttemptKey('d'.repeat(64)), `qa:${'d'.repeat(64)}`);
});

test('assertCriticAllowed still accepts phase code once the spec is approved and the plan is frozen', () => {
	assert.throws(
		() =>
			assertCriticAllowed({
				phase: 'code',
				snapshot: { approvedSpecHash: 'a'.repeat(64), taskPlanFrozen: false },
			}),
		(error) => error.code === 'POLICY_VIOLATION',
	);
	assert.doesNotThrow(() =>
		assertCriticAllowed({
			phase: 'code',
			snapshot: { approvedSpecHash: 'a'.repeat(64), taskPlanFrozen: true },
		}),
	);
	assert.throws(
		() => assertCriticAllowed({ phase: 'bogus', snapshot: {} }),
		(error) => error.code === 'INVALID_CONTRACT',
	);
});

test('specAttemptKey defaults to attempt zero', () => {
	assert.equal(specAttemptKey(undefined), 'spec:0');
	assert.equal(specAttemptKey(2), 'spec:2');
});
