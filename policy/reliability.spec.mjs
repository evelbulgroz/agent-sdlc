import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import * as reliability from './reliability.ts';
import { recordVerificationAttempt } from './reliability.ts';
import { verificationAttempt } from '../testing/reliability-fixtures.mjs';

const FROZEN_RELIABILITY_EXPORTS = [
	'CANARY_LIMITS',
	'RELIABILITY_CORPUS_VERSION',
	'buildReliabilityReport',
	'classifyReliabilityFailure',
	'compareReliabilityRoutes',
	'currentCanaryBindings',
	'evaluateCanaryEligibility',
	'evaluateCanaryFreshness',
	'evaluateCanaryQualificationEvidence',
	'evaluateCurrentCanaryGate',
	'isDocumentationOnlyGitRange',
	'qualifyCanaryRun',
	'readArtifactJson',
	'readCanaryQualification',
	'readTerminalQaDivergences',
	'recordVerificationAttempt',
	'replayReliabilityCorpus',
	'resolveGitHead',
	'validateReliabilityCorpusCase',
	'validateSanitizedRunSummary',
];

test('@ac AC-01 @case AC-01.3 the facade export names equal the frozen list of 20', () => {
	assert.deepEqual(Object.keys(reliability).sort(), FROZEN_RELIABILITY_EXPORTS);
});

test('@ac AC-01 @case AC-01.4 no production file defines or imports recordMutationAttempt', () => {
	const hits = [];
	const walk = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (
				(!entry.name.endsWith('.mjs') && !entry.name.endsWith('.ts')) ||
				entry.name.endsWith('.spec.mjs') ||
				entry.name.endsWith('.spec.ts')
			) {
				continue;
			}
			if (fs.readFileSync(full, 'utf8').includes('recordMutationAttempt')) {
				hits.push(path.relative(REPOSITORY_ROOT, full).split(path.sep).join('/'));
			}
		}
	};
	walk(path.join(REPOSITORY_ROOT, 'tools'));
	assert.deepEqual(hits, []);
});

test('recordVerificationAttempt returns the stored diagnostic when the attemptId repeats', () => {
	const stored = [];
	const store = {
		listDiagnostics() {
			return stored;
		},
		recordDiagnostic(diagnostic) {
			stored.push(diagnostic);
			return diagnostic;
		},
	};
	const attempt = verificationAttempt('task-a', 1, 'passed');
	const first = recordVerificationAttempt(store, attempt);
	const second = recordVerificationAttempt(store, attempt);
	assert.equal(second, first);
	assert.equal(stored.length, 1);
	assert.equal(first.kind, 'reliability.verification-attempt');
	assert.equal(first.payload.attemptId, attempt.attemptId);
});
