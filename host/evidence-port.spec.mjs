import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { executeEvidence } from './evidence-port.ts';
import { hashEvidenceBytes } from './evidence-files.ts';
import { fixture, H } from './evidence-port-fixture.mjs';
import { createEvidenceRecordStore } from './evidence-store.ts';

test('reserves before the injected command run and publishes raw byte hashes', async () => {
	await fixture(async (f) => {
		const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
		assert.equal(result.receipt.status, 'passed');
		assert.deepEqual(result.receipt.dischargedObligationIds, ['obligation-1']);
		assert.equal(result.receipt.reportHash, hashEvidenceBytes(f.reportBytes));
		assert.deepEqual(f.events, ['reserve', 'running', 'run', 'complete']);
		assert.deepEqual(result.observations.before, f.observation);
		assert.deepEqual(result.observations.after, f.observation);
	});
});

test('reuses only a completed matching receipt without running again', async () => {
	await fixture(async (f) => {
		await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
		const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
		assert.equal(result.reused, true);
		assert.equal(f.runs(), 1);
		f.request.binding.candidateRevision++;
		await assert.rejects(executeEvidence(f.request, f.registration, f.context, f.spawn, f.store), /operation-id-conflict/);
	});
});

test('rejects replay of a reserved operation after crash without running again', async () => {
	await fixture(async (f) => {
		const brokenStore = { ...f.store, async started() { throw new Error('interruption'); }, async complete() { throw new Error('storage-offline'); } };
		await assert.rejects(executeEvidence(f.request, f.registration, f.context, f.spawn, brokenStore), /storage-offline/);
		assert.equal(f.durable().status, 'reserved');
		await assert.rejects(executeEvidence(f.request, f.registration, f.context, f.spawn, f.store), /not-reusable/);
		assert.equal(f.runs(), 0);
	});
});

test('unit and browser fixtures synthesize identical report shapes from command case results', async () => {
	for (const layer of ['unit', 'browser']) {
		await fixture(async (f) => {
			const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
			assert.equal(result.receipt.status, 'passed');
			assert.equal(result.report.cases[0].file, 'src/check.spec.ts');
			assert.deepEqual(result.report.artifacts, []);
		}, layer);
	}
});

const run = (f, behavior) => { f.behavior.run = async () => ({ exitCode: 0, reportBytes: f.reportBytes, cases: f.passedCases(), ...behavior }); };

const invalidResults = {
	'no case results': { cases: [] },
	'foreign case identity': { cases: [{ identity: 'AC-99.9', outcome: 'passed', message: '', attempts: 1 }] },
	'unknown outcome': { cases: [{ identity: 'AC-01.1', outcome: 'flaky', message: '', attempts: 1 }] },
};
for (const [name, behavior] of Object.entries(invalidResults)) {
	test(`fails closed on ${name} command result`, async () => {
		await fixture(async (f) => {
			run(f, behavior);
			const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
			assert.notEqual(result.receipt.status, 'passed');
			assert.deepEqual(result.receipt.dischargedObligationIds, []);
			assert.equal(f.completion().receipt.status, 'incomplete');
		});
	});
}

test('rejects nonzero exit, interrupted runs and runner-reported failure reasons', async () => {
	const failed = [{ identity: 'AC-01.1', outcome: 'failed', message: '', attempts: 1 }];
	for (const behavior of [{ exitCode: 1, cases: failed }, { exitCode: null }, { failureReason: 'timeout', exitCode: null }]) {
		await fixture(async (f) => {
			run(f, behavior);
			const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
			assert.notEqual(result.receipt.status, 'passed');
			assert.deepEqual(result.receipt.dischargedObligationIds, []);
			if (behavior.failureReason) assert.equal(result.invocation.failureReason, 'timeout');
		});
	}
});

test('explicit failed, skipped and not-run cases never discharge obligations', async () => {
	for (const outcome of ['failed', 'skipped', 'not-run']) {
		await fixture(async (f) => {
			run(f, { exitCode: outcome === 'skipped' ? 0 : 1, cases: [{ identity: 'AC-01.1', outcome, message: '', attempts: 1 }] });
			const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
			assert.notEqual(result.receipt.status, 'passed');
			assert.deepEqual(result.receipt.dischargedObligationIds, []);
		});
	}
});

test('rejects obligations requiring native capabilities the frozen profile does not qualify', async () => {
	for (const layer of ['browser', 'unit']) {
		await fixture(async (f) => {
			f.request.obligations[0].requiredCapabilities = ['static-check'];
			f.context.authorization.qualityPlan.evidenceObligations = structuredClone(f.request.obligations);
			await assert.rejects(executeEvidence(f.request, f.registration, f.context, f.spawn, f.store), /profile-not-qualified/);
			assert.equal(f.runs(), 0);
		}, layer);
	}
});

test('rejects unauthorized argv, package, paths, expired approval and malformed request before reservation', async () => {
	for (const mutate of [
		(f) => { f.context.allowedArgv = [['fake-evidence', 'different']]; },
		(f) => { f.context.authorization.allowedPackages = ['other']; },
		(f) => { f.context.authorization.allowedPathPrefixes = ['other']; },
		(f) => { f.context.authorization.expiresAt = '2020-01-01T00:00:00Z'; },
		(f) => { f.context.authorization.allowedOperations.runAllowlistedCommands = false; },
		(f) => { delete f.context.authorization.qualityPlan; },
		(f) => { f.context.authorization.qualityPlan.evidenceObligations[0].expectedResult = 'different'; },
		(f) => { f.request.binding.qualityPolicyHash = H; },
		(f) => { f.request.obligations = []; },
		(f) => { f.request.operationId = null; },
	]) {
		await fixture(async (f) => {
			mutate(f);
			await assert.rejects(executeEvidence(f.request, f.registration, f.context, f.spawn, f.store));
			assert.equal(f.runs(), 0);
			assert.deepEqual(f.events, []);
		});
	}
});

test('freezes pinned bytes, rejecting symlinked inputs before running', async () => {
	for (const file of ['dependency.mjs', 'config.json']) {
		await fixture(async (f) => {
			fs.appendFileSync(path.join(f.root, 'src', file), 'changed');
			const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
			assert.equal(result.receipt.status, 'incomplete');
			assert.equal(f.runs(), 0);
		});
	}
	await fixture(async (f) => {
		fs.unlinkSync(path.join(f.root, 'src/dependency.mjs'));
		fs.symlinkSync('config.json', path.join(f.root, 'src/dependency.mjs'));
		const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
		assert.equal(result.receipt.status, 'incomplete');
		assert.equal(f.runs(), 0);
	});
});

test('source or preparation drift before or after execution never creates a passing receipt', async () => {
	for (const field of ['treeSha', 'sourceHash', 'preparationHash']) {
		for (const when of ['before', 'after']) {
			await fixture(async (f) => {
				let observations = 0;
				f.context.observeSource = async () => {
					observations++;
					return { ...f.observation, [field]: when === 'before' || observations > 1 ? 'c'.repeat(field === 'treeSha' ? 40 : 64) : f.observation[field] };
				};
				const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
				assert.equal(result.receipt.status, 'incomplete');
				assert.equal(result.invocation.failureReason, 'candidate-source-or-preparation-changed');
			});
		}
	}
});

test('a command run never starts in a non-empty artifact directory', async () => {
	await fixture(async (f) => {
		fs.writeFileSync(path.join(f.artifacts, 'stale.txt'), 'stale');
		const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
		assert.equal(result.receipt.status, 'incomplete');
		assert.equal(result.invocation.failureReason, 'artifact-directory-not-fresh');
		assert.equal(f.runs(), 0);
	});
});

test('durable command reserves budget and invocation together and charges completion atomically', async () => {
	await fixture(async (f) => {
		const calls = [];
		const runtime = {
			transaction(callback) { calls.push('begin'); const value = callback(); calls.push('end'); return value; },
			quality: {
				reserveBudget() { calls.push('budget'); },
				reserveInvocation() { calls.push('invocation'); return { kind: 'reserved' }; },
				startInvocation() { calls.push('running'); },
				chargeBudget() { calls.push('charge'); },
				completeInvocation() { calls.push('completion'); },
			},
		};
		const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, createEvidenceRecordStore(runtime, f.request));
		assert.equal(result.receipt.status, 'passed');
		assert.deepEqual(calls, ['begin', 'budget', 'invocation', 'end', 'begin', 'running', 'end', 'begin', 'charge', 'completion', 'end']);
	});

});

test('runtime duration ceiling accepts only positive safe integers', async () => {
	for (const ceiling of [undefined, 25, 2000, 0, -1, null, '', 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		await fixture(async (f) => {
			f.context.executionDurationCeilingMs = ceiling;
			const execution = executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
			if (ceiling === undefined || ceiling === 25 || ceiling === 2000) {
				assert.equal((await execution).receipt.status, 'passed');
			} else {
				await assert.rejects(execution);
				assert.deepEqual(f.events, []);
			}
		});
	}
});

test('surfaces unclassified failure causes only through the diagnostics callback', async () => {
	await fixture(async (f) => {
		const messages = [];
		f.behavior.run = async () => { throw new Error('browser runner produced no report: API_TOKEN=sk-secret-value timed out'); };
		const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store,
			{ onDiagnostics: (message) => messages.push(message) });
		assert.equal(result.invocation.failureReason, 'invalid-evidence');
		assert.equal(messages.length, 2, JSON.stringify(messages));
		assert.match(messages[0], /^evidence-port: .*produced no report/);
		assert.match(messages[1], /^evidence-timing: verify-before=\d+ms observe-before=\d+ms record-start=\d+ms/);
		assert.ok(messages.every((message) => !message.includes('sk-secret-value')));
		assert.ok(!JSON.stringify(f.completion()).includes('produced no report'));
	});
});
