import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readCandidateLearnings, writeCandidateLearningsProjection } from './projection-artifacts.ts';

test('@ac AC-04 @case AC-04.3 strict candidate reads throw and lenient reads return null', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-candidates-'));
	const legacyPath = path.join(directory, 'candidate-learnings.json');
	fs.writeFileSync(legacyPath, '{not json');
	const runtimeStore = { listCandidateLearnings() { return []; } };
	try {
		assert.throws(
			() => readCandidateLearnings({ mode: 'strict', runtimeStore, runId: 'run-1', legacyPath }),
			(error) => error.code === 'INVALID_CONTRACT',
		);
		assert.equal(
			readCandidateLearnings({ mode: 'lenient', legacyPath }),
			null,
		);
		assert.equal(readCandidateLearnings({ mode: 'lenient', legacyPath: path.join(directory, 'missing.json') }), null);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test('no candidates writes no projection file', () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-candidates-'));
	try {
		writeCandidateLearningsProjection(directory, 'run-1', { listCandidateLearnings() { return []; } });
		assert.equal(fs.existsSync(path.join(directory, 'candidate-learnings.json')), false);
		writeCandidateLearningsProjection(directory, 'run-1', {});
		assert.equal(fs.existsSync(path.join(directory, 'candidate-learnings.json')), false);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
