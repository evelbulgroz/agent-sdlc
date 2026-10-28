import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import {
	replayReliabilityCorpus,
	validateReliabilityCorpusCase,
} from './corpus.ts';

test('@ac AC-07 reliability corpus replays canary failures without provider operations', () => {
	const result = replayReliabilityCorpus({ rootDir: REPOSITORY_ROOT });
	assert.equal(result.status, 'PASSED');
	assert.equal(result.total, 20);
	assert.equal(result.providerOperations, 0);
	assert.deepEqual(result.providerCredentialVariablesPresent, []);
	for (const caseId of [
		'reviewer-contradictory-status',
		'repair-missing-ac-citations',
		'implementer-nonexecuted-ac-evidence',
		'implementer-step-limit',
	]) {
		assert.equal(
			result.cases.find((entry) => entry.caseId === caseId)?.passed,
			true,
		);
	}
	assert.equal(
		result.cases.some((entry) => entry.entryPoint === 'executor-progress'),
		false,
	);
});

test('@ac AC-06 @case AC-06.4 reliability corpus rejects an executor-progress entry point', () => {
	assert.throws(
		() =>
			validateReliabilityCorpusCase({
				schemaVersion: '1.0.0',
				caseId: 'retired-executor-progress',
				failureCategory: 'UNCLASSIFIED',
				entryPoint: 'executor-progress',
				input: { code: 'X', message: 'safe' },
				expected: { failureCategory: 'UNCLASSIFIED' },
			}),
		(error) => error.code === 'INVALID_CONTRACT',
	);
});

test('@ac AC-03 corpus validation rejects secret-like values and escaping paths without echoing values', () => {
	const secretLikeValue = ['sk', 'abcdefghijklmnop'].join('-');
	const base = {
		schemaVersion: '1.0.0',
		caseId: 'unsafe-case',
		failureCategory: 'UNCLASSIFIED',
		entryPoint: 'classify-failure',
		input: { code: 'X', message: 'safe', path: 'src/file.ts' },
		expected: { failureCategory: 'UNCLASSIFIED' },
	};
	assert.throws(
		() =>
			validateReliabilityCorpusCase({
				...base,
				input: { ...base.input, message: secretLikeValue },
			}),
		(error) => {
			assert.equal(error.message.includes(secretLikeValue), false);
			return /Secret-like/.test(error.message);
		},
	);
	assert.throws(
		() =>
			validateReliabilityCorpusCase({
				...base,
				input: { ...base.input, path: '../../outside.ts' },
			}),
		/path traversal/,
	);
});

test('@ac AC-18 replay output is canonical across filesystem order', () => {
	const source = path.join(
		REPOSITORY_ROOT,
		'testing/reliability-corpus',
	);
	const temp = fs.mkdtempSync(
		path.join(os.tmpdir(), 'reliability-corpus-order-'),
	);
	try {
		for (const filename of fs.readdirSync(source).reverse()) {
			fs.copyFileSync(path.join(source, filename), path.join(temp, filename));
		}
		assert.deepEqual(
			replayReliabilityCorpus({ rootDir: REPOSITORY_ROOT, corpusDir: temp }),
			replayReliabilityCorpus({ rootDir: REPOSITORY_ROOT, corpusDir: source }),
		);
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

test('@ac AC-02 @case AC-02.1 replayReliabilityCorpus returns PASSED with no provider operations', () => {
	const result = replayReliabilityCorpus({ rootDir: REPOSITORY_ROOT });
	assert.equal(result.status, 'PASSED');
	assert.equal(result.total, 20);
	assert.equal(result.providerOperations, 0);
	assert.deepEqual(result.providerCredentialVariablesPresent, []);
});

test('@ac AC-02 @case AC-02.2 replay output is identical when corpus files are read in reverse order', () => {
	const source = path.join(REPOSITORY_ROOT, 'testing/reliability-corpus');
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-corpus-reverse-'));
	try {
		for (const filename of fs.readdirSync(source).reverse()) {
			fs.copyFileSync(path.join(source, filename), path.join(temp, filename));
		}
		assert.deepEqual(
			replayReliabilityCorpus({ rootDir: REPOSITORY_ROOT, corpusDir: temp }),
			replayReliabilityCorpus({ rootDir: REPOSITORY_ROOT, corpusDir: source }),
		);
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

test('@ac AC-02 @case AC-02.3 executor-progress throws INVALID_CONTRACT with the unsupported message', () => {
	assert.throws(
		() =>
			validateReliabilityCorpusCase({
				schemaVersion: '1.0.0',
				caseId: 'retired-executor-progress',
				failureCategory: 'UNCLASSIFIED',
				entryPoint: 'executor-progress',
				input: { code: 'X', message: 'safe' },
				expected: { failureCategory: 'UNCLASSIFIED' },
			}),
		(error) => {
			assert.equal(error.code, 'INVALID_CONTRACT');
			assert.equal(error.message, 'Corpus entryPoint is unsupported');
			return true;
		},
	);
});

test('replayReliabilityCorpus rejects an empty corpus directory', () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-corpus-empty-'));
	try {
		assert.throws(
			() => replayReliabilityCorpus({ rootDir: REPOSITORY_ROOT, corpusDir: temp }),
			(error) =>
				error.code === 'INVALID_CONTRACT' && error.message === 'Reliability corpus is empty',
		);
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

test('replayReliabilityCorpus rejects a corpus whose only fixture is a symbolic link', () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-corpus-link-'));
	const corpus = path.join(temp, 'corpus');
	try {
		fs.mkdirSync(corpus);
		fs.writeFileSync(path.join(temp, 'real.json'), '{}\n');
		fs.symlinkSync(path.join(temp, 'real.json'), path.join(corpus, 'link.json'));
		assert.throws(
			() => replayReliabilityCorpus({ rootDir: REPOSITORY_ROOT, corpusDir: corpus }),
			(error) =>
				error.code === 'INVALID_CONTRACT' && error.message === 'Reliability corpus is empty',
		);
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
});

test('@ac AC-02 @case AC-02.2 replayReliabilityCorpus falls back to package-bundled testing/reliability-corpus when host repo has no packages/agent-sdlc directory', () => {
	const externalHost = fs.mkdtempSync(path.join(os.tmpdir(), 'reliability-corpus-ext-host-'));
	try {
		const replayed = replayReliabilityCorpus({ rootDir: externalHost });
		assert.equal(replayed.status, 'PASSED');
		assert.equal(replayed.total, 20);
	} finally {
		fs.rmSync(externalHost, { recursive: true, force: true });
	}
});
