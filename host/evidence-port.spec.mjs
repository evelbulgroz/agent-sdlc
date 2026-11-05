import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { sha256 } from '../policy/contracts/primitives.ts';
import { executeEvidence } from './evidence-port.ts';
import { hashEvidenceBytes } from './evidence-files.ts';
import { fixture, H } from './evidence-port-fixture.mjs';
import { createEvidenceRecordStore } from './evidence-store.ts';

test('reserves before exact no-shell stdin execution and publishes raw byte hashes', async () => {
	await fixture(async (f) => {
		const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
		assert.equal(result.receipt.status, 'passed');
		assert.deepEqual(result.receipt.dischargedObligationIds, ['obligation-1']);
		assert.equal(result.receipt.reportHash, hashEvidenceBytes(Buffer.from(JSON.stringify(f.report()))));
		assert.deepEqual(f.events, ['reserve', 'running', 'spawn', 'complete']);
		assert.deepEqual(result.observations.before, f.observation);
		assert.deepEqual(result.observations.after, f.observation);
	});
});

test('reuses only a completed matching receipt without spawning again', async () => {
	await fixture(async (f) => {
		await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
		const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
		assert.equal(result.reused, true);
		assert.equal(f.spawns(), 1);
		f.request.binding.candidateRevision++;
		await assert.rejects(executeEvidence(f.request, f.registration, f.context, f.spawn, f.store), /operation-id-conflict/);
	});
});

test('rejects replay of a reserved operation after crash without respawning', async () => {
	await fixture(async (f) => {
		const brokenStore = { ...f.store, async started() { throw new Error('interruption'); }, async complete() { throw new Error('storage-offline'); } };
		await assert.rejects(executeEvidence(f.request, f.registration, f.context, f.spawn, brokenStore), /storage-offline/);
		assert.equal(f.durable().status, 'reserved');
		await assert.rejects(executeEvidence(f.request, f.registration, f.context, f.spawn, f.store), /not-reusable/);
		assert.equal(f.spawns(), 0);
	});
});

test('unit and browser raw fixture shapes remain opaque artifacts with identical wire normalization', async () => {
	for (const layer of ['unit', 'browser']) {
		await fixture(async (f) => {
			const raw = layer === 'unit' ? { tests: [{ name: 'ready', status: 'pass' }] } :
				{ suites: [{ specs: [{ title: 'ready', tests: [{ results: [{ status: 'passed', retry: 0 }] }] }] }] };
			const bytes = Buffer.from(JSON.stringify(raw));
			const baseReport = f.report;
			f.report = () => baseReport();
			const wrapped = (command, args, options) => {
				const child = f.spawn(command, args, options);
				child.stdout.removeAllListeners('data');
				const write = child.stdout.write.bind(child.stdout);
				child.stdout.write = () => {
					fs.writeFileSync(path.join(f.artifacts, 'raw.json'), bytes);
					const normalized = baseReport();
					normalized.artifacts = [{ path: 'raw.json', sha256: hashEvidenceBytes(bytes), sizeBytes: bytes.length }];
					normalized.cases[0].attempts[0].artifactPaths = ['raw.json'];
					return write(JSON.stringify(normalized));
				};
				return child;
			};
			const result = await executeEvidence(f.request, f.registration, f.context, wrapped, f.store);
			assert.equal(result.receipt.status, 'passed');
			assert.equal(result.report.cases[0].file, 'src/check.spec.ts');
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.artifacts, 'raw.json'))), raw);
		}, layer);
	}
});

function outputSpawn(f, makeOutput, exitCode = 0, signal = null) {
	return (command, args, options) => {
		const child = f.spawn(command, args, options);
		const write = child.stdout.write.bind(child.stdout);
		child.stdout.write = () => write(makeOutput());
		const emit = child.emit.bind(child);
		child.emit = (event, ...values) => event === 'close' ? emit(event, exitCode, signal) : emit(event, ...values);
		return child;
	};
}

const invalidReports = {
	'null': () => null,
	'empty': () => ({}),
	'unsupported version': (r) => ({ ...r, schemaVersion: '9.0.0' }),
	'missing cases': (r) => ({ ...r, cases: [] }),
	'foreign file': (r) => ({ ...r, cases: [{ ...r.cases[0], file: 'src/other.spec.ts' }] }),
	'foreign case': (r) => ({ ...r, cases: [{ ...r.cases[0], caseKey: 'other' }] }),
	'foreign obligation': (r) => ({ ...r, cases: [{ ...r.cases[0], obligationIds: ['foreign'] }] }),
	'duplicate case': (r) => ({ ...r, cases: [...r.cases, ...r.cases] }),
	'wrong request hash': (r) => ({ ...r, requestHash: 'c'.repeat(64) }),
	'wrong profile': (r) => ({ ...r, profileId: 'foreign' }),
	'no attempt': (r) => ({ ...r, cases: [{ ...r.cases[0], attempts: [] }] }),
	'noncontiguous attempts': (r) => ({ ...r, cases: [{ ...r.cases[0], attempts: [{ ...r.cases[0].attempts[0], index: 1 }] }] }),
	'flaky retry': (r) => ({ ...r, cases: [{ ...r.cases[0], attempts: [
		{ ...r.cases[0].attempts[0], outcome: 'failed' }, { ...r.cases[0].attempts[0], index: 1 },
	] }] }),
};
for (const [name, change] of Object.entries(invalidReports)) {
	test(`fails closed on ${name} report`, async () => {
		await fixture(async (f) => {
			const spawn = outputSpawn(f, () => JSON.stringify(change(f.report())));
			const result = await executeEvidence(f.request, f.registration, f.context, spawn, f.store);
			assert.notEqual(result.receipt.status, 'passed');
			assert.deepEqual(result.receipt.dischargedObligationIds, []);
			assert.equal(f.completion().receipt.status, 'incomplete');
		});
	});
}

test('rejects exit-only, multiple JSON documents, nonzero exit, and signaled execution', async () => {
	for (const [output, exitCode, signal] of [['', 0, null], ['{}{}', 0, null], [null, 1, null], [null, null, 'SIGTERM']]) {
		await fixture(async (f) => {
			const spawn = outputSpawn(f, () => output ?? JSON.stringify(f.report()), exitCode, signal);
			const result = await executeEvidence(f.request, f.registration, f.context, spawn, f.store);
			assert.notEqual(result.receipt.status, 'passed');
		});
	}
});

test('explicit failed, skipped, not-run and incomplete cases never discharge obligations', async () => {
	for (const outcome of ['failed', 'skipped', 'not-run', 'incomplete']) {
		await fixture(async (f) => {
			const spawn = outputSpawn(f, () => {
				const report = f.report();
				report.cases[0].outcome = outcome;
				report.cases[0].attempts = outcome === 'not-run' ? [] : [{ index: 0, outcome, durationMs: 1, artifactPaths: [] }];
				return JSON.stringify(report);
			});
			const result = await executeEvidence(f.request, f.registration, f.context, spawn, f.store);
			assert.notEqual(result.receipt.status, 'passed');
			assert.deepEqual(result.receipt.dischargedObligationIds, []);
		});
	}
});

test('rejects browser reports without independently required native capabilities', async () => {
	await fixture(async (f) => {
		const spawn = outputSpawn(f, () => {
			const report = f.report();
			report.cases[0].exercisedCapabilities = ['native-browser'];
			return JSON.stringify(report);
		});
		const result = await executeEvidence(f.request, f.registration, f.context, spawn, f.store);
		assert.equal(result.receipt.status, 'incomplete');
	}, 'browser');
	await fixture(async (f) => {
		const spawn = outputSpawn(f, () => {
			const report = f.report();
			report.cases[0].exercisedCapabilities = ['native-browser'];
			return JSON.stringify(report);
		});
		const result = await executeEvidence(f.request, f.registration, f.context, spawn, f.store);
		assert.equal(result.receipt.status, 'incomplete');
	});
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
			assert.equal(f.spawns(), 0);
			assert.deepEqual(f.events, []);
		});
	}
});

test('freezes raw bundle, dependency and config bytes and rejects symlinked inputs', async () => {
	for (const file of ['adapter.mjs', 'dependency.mjs', 'config.json']) {
		await fixture(async (f) => {
			fs.appendFileSync(path.join(f.root, 'src', file), 'changed');
			const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
			assert.equal(result.receipt.status, 'incomplete');
			assert.equal(f.spawns(), 0);
		});
	}
	await fixture(async (f) => {
		fs.unlinkSync(path.join(f.root, 'src/adapter.mjs'));
		fs.symlinkSync('dependency.mjs', path.join(f.root, 'src/adapter.mjs'));
		const result = await executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
		assert.equal(result.receipt.status, 'incomplete');
		assert.equal(f.spawns(), 0);
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

test('bounds reports and kills timed-out commands before incomplete completion', async () => {
	await fixture(async (f) => {
		const spawn = outputSpawn(f, () => 'x'.repeat(20000));
		const result = await executeEvidence(f.request, f.registration, f.context, spawn, f.store);
		assert.equal(result.receipt.status, 'incomplete');
		assert.equal(result.invocation.failureReason, 'report-byte-limit');
	});
	await fixture(async (f) => {
		const spawn = (command, args, options) => {
			const child = f.spawn(command, args, options);
			child.stdin = new PassThrough();
			return child;
		};
		f.registration.limits.timeoutMs = 5;
		f.request.adapterBindingHash = f.request.obligations[0].adapterBindingHash = f.context.frozenAdapterBindingHash = sha256(f.registration);
		f.context.authorization.qualityPlan.adapterBindings = structuredClone([f.registration]);
		f.context.authorization.qualityPlan.evidenceObligations = structuredClone(f.request.obligations);
		const result = await executeEvidence(f.request, f.registration, f.context, spawn, f.store);
		assert.equal(result.invocation.failureReason, 'timeout');
		assert.equal(result.receipt.status, 'incomplete');
	});
});

test('rejects artifact traversal, symlinks, nonregular files, size/hash mismatches and undeclared references', async () => {
	for (const kind of ['traversal', 'symlink', 'directory', 'wrong-hash', 'oversize', 'undeclared']) {
		await fixture(async (f) => {
			const spawn = outputSpawn(f, () => {
				const bytes = Buffer.from('raw');
				let file = 'raw.txt';
				if (kind === 'traversal') file = '../src/code.ts';
				if (kind === 'directory') fs.mkdirSync(path.join(f.artifacts, file));
				else if (kind === 'symlink') fs.symlinkSync('../src/code.ts', path.join(f.artifacts, file));
				else if (kind !== 'traversal') fs.writeFileSync(path.join(f.artifacts, file), kind === 'oversize' ? Buffer.alloc(3000) : bytes);
				const report = f.report();
				report.artifacts = [{ path: file, sha256: kind === 'wrong-hash' ? H : hashEvidenceBytes(bytes), sizeBytes: bytes.length }];
				if (kind === 'undeclared') report.cases[0].attempts[0].artifactPaths = ['missing.txt'];
				return JSON.stringify(report);
			});
			const result = await executeEvidence(f.request, f.registration, f.context, spawn, f.store);
			assert.equal(result.receipt.status, 'incomplete', kind);
		});
	}
});

test('durable adapter reserves budget and invocation together and charges completion atomically', async () => {
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

test('runtime duration ceiling only narrows frozen timeout and rejects exhausted budgets', async (t) => {
		let timeout;
		const original = globalThis.setTimeout;
		t.mock.method(globalThis, 'setTimeout', (fn, ms) => { timeout = ms; return original(fn, ms); });
		for (const ceiling of [undefined, 25, 2000, 0, -1, null, '', 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			await fixture(async (f) => {
				f.context.executionDurationCeilingMs = ceiling;
				const execution = executeEvidence(f.request, f.registration, f.context, f.spawn, f.store);
				if (ceiling === undefined || ceiling === 25 || ceiling === 2000) {
					await execution;
					assert.equal(timeout, ceiling === 25 ? 25 : 1000);
				} else {
					await assert.rejects(execution);
					assert.deepEqual(f.events, []);
				}
			});
		}
});

test('surfaces unclassified failure causes and adapter stderr only through the diagnostics callback', async () => {
	await fixture(async (f) => {
		const messages = [];
		const spawn = (command, args, options) => {
			const child = f.spawn(command, args, options);
			child.stderr.write('browser runner produced no report: API_TOKEN=sk-secret-value timed out\n');
			const write = child.stdout.write.bind(child.stdout);
			child.stdout.write = () => write('not json');
			const emit = child.emit.bind(child);
			child.emit = (event, ...values) => event === 'close' ? setImmediate(() => emit(event, 1, null)) : emit(event, ...values);
			return child;
		};
		const result = await executeEvidence(f.request, f.registration, f.context, spawn, f.store,
			{ onDiagnostics: (message) => messages.push(message) });
		assert.equal(result.invocation.failureReason, 'invalid-evidence');
		assert.equal(messages.length, 2, JSON.stringify(messages));
		assert.match(messages[0], /produced no report/);
		assert.match(messages[1], /^evidence-port: /);
		assert.ok(messages.every((message) => !message.includes('sk-secret-value')));
		assert.ok(!JSON.stringify(f.completion()).includes('produced no report'));
	});
});
