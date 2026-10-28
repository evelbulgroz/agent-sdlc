import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	candidatePaths,
	looksLikeFileCitation,
	parseLineRange,
	resolveCitedFile,
	verifyFindingGrounding,
	verifyFindings,
} from './citation-verifier.ts';

function makeTempRepo(files) {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citation-verifier-'));
	for (const [relativePath, content] of Object.entries(files)) {
		const absolutePath = path.join(rootDir, relativePath);
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
		fs.writeFileSync(absolutePath, content, 'utf8');
	}
	return rootDir;
}

test('candidatePaths normalizes leading ./, backslashes, and diff a/ b/ prefixes', () => {
	assert.deepEqual(candidatePaths('./src/foo.ts'), ['./src/foo.ts', 'src/foo.ts']);
	assert.deepEqual(candidatePaths('a/src/foo.ts'), ['a/src/foo.ts', 'src/foo.ts']);
	assert.deepEqual(candidatePaths('src\\foo.ts'), ['src/foo.ts']);
	assert.deepEqual(candidatePaths(''), []);
	assert.deepEqual(candidatePaths(undefined), []);
	// Absolute paths are never treated as safe relative candidates
	assert.deepEqual(candidatePaths('/etc/passwd'), []);
});

test('parseLineRange handles common formats and rejects non-numeric text', () => {
	assert.deepEqual(parseLineRange('50-55'), { start: 50, end: 55 });
	assert.deepEqual(parseLineRange('(50-55)'), { start: 50, end: 55 });
	assert.deepEqual(parseLineRange('L50-L55'), { start: 50, end: 55 });
	assert.deepEqual(parseLineRange('55-50'), { start: 50, end: 55 }); // tolerate reversed order
	assert.deepEqual(parseLineRange('42'), { start: 42, end: 42 });
	assert.equal(parseLineRange('throughout'), null);
	assert.equal(parseLineRange(''), null);
	assert.equal(parseLineRange(undefined), null);
});

test('resolveCitedFile finds a real file under rootDir and rejects escapes', () => {
	const rootDir = makeTempRepo({ 'src/foo.ts': 'line1\nline2\n' });
	try {
		const found = resolveCitedFile({ rootDir, file: 'src/foo.ts' });
		assert.equal(found.found, true);
		assert.equal(found.matchedCandidate, 'src/foo.ts');

		const missing = resolveCitedFile({ rootDir, file: 'src/does-not-exist.ts' });
		assert.equal(missing.found, false);

		const escape = resolveCitedFile({ rootDir, file: '../../etc/passwd' });
		assert.equal(escape.found, false);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('verifyFindingGrounding flags a fabricated (nonexistent) file citation', () => {
	const rootDir = makeTempRepo({ 'src/real.ts': 'a\nb\n' });
	try {
		const finding = {
			severity: 'P1',
			category: 'correctness',
			file: 'tests/session_test.rb',
			lineRange: '10-20',
			evidence: 'fabricated',
			impact: 'x',
			remediation: 'y',
		};
		const result = verifyFindingGrounding({ finding, rootDir });
		assert.equal(result.groundingVerified, false);
		assert.match(result.groundingReason, /file-not-found/);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('verifyFindingGrounding flags a real file cited with an out-of-bounds line range', () => {
	const rootDir = makeTempRepo({ 'src/short.ts': 'only\nfour\nlines\nhere\n' });
	try {
		const finding = {
			severity: 'P1',
			category: 'correctness',
			file: 'src/short.ts',
			lineRange: '50-55',
			evidence: 'fabricated range',
			impact: 'x',
			remediation: 'y',
		};
		const result = verifyFindingGrounding({ finding, rootDir });
		assert.equal(result.groundingVerified, false);
		assert.match(result.groundingReason, /line-range-out-of-bounds/);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('verifyFindingGrounding accepts a real file with an in-bounds line range', () => {
	const rootDir = makeTempRepo({ 'src/real.ts': Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n' });
	try {
		const finding = {
			severity: 'P2',
			category: 'correctness',
			file: 'src/real.ts',
			lineRange: '10-20',
			evidence: 'grounded',
			impact: 'x',
			remediation: 'y',
		};
		const result = verifyFindingGrounding({ finding, rootDir });
		assert.equal(result.groundingVerified, true);
		assert.equal(result.groundingReason, null);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('verifyFindingGrounding does not block on an unparseable lineRange when the file exists', () => {
	const rootDir = makeTempRepo({ 'src/real.ts': 'a\nb\nc\n' });
	try {
		const finding = {
			severity: 'P3',
			category: 'testing',
			file: 'src/real.ts',
			lineRange: 'throughout',
			evidence: 'grounded but vague range',
			impact: 'x',
			remediation: 'y',
		};
		const result = verifyFindingGrounding({ finding, rootDir });
		assert.equal(result.groundingVerified, true);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('looksLikeFileCitation treats symbolic words as non-path citations and real paths as path citations', () => {
	assert.equal(looksLikeFileCitation('plan'), false);
	assert.equal(looksLikeFileCitation('spec'), false);
	assert.equal(looksLikeFileCitation('n/a'), true); // contains a slash, treated as path-like
	assert.equal(looksLikeFileCitation('src/foo.ts'), true);
	assert.equal(looksLikeFileCitation('foo.ts'), true);
	assert.equal(looksLikeFileCitation(''), false);
	assert.equal(looksLikeFileCitation(undefined), false);
});

test('verifyFindingGrounding does not filesystem-check a symbolic/document-level citation (e.g. plan-phase "plan")', () => {
	const rootDir = makeTempRepo({});
	try {
		const finding = {
			severity: 'P1',
			category: 'correctness',
			file: 'plan',
			evidence: 'High-risk path is sequenced after a consumer',
			impact: 'Unsafe worktree mutation',
			remediation: 'Serialize the kernel first',
		};
		const result = verifyFindingGrounding({ finding, rootDir });
		assert.equal(result.groundingVerified, true);
		assert.equal(result.groundingReason, null);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('verifyFindingGrounding flags a missing/empty file citation', () => {
	const rootDir = makeTempRepo({});
	try {
		const finding = {
			severity: 'P1',
			category: 'correctness',
			file: '',
			lineRange: '1-2',
			evidence: 'no file at all',
			impact: 'x',
			remediation: 'y',
		};
		const result = verifyFindingGrounding({ finding, rootDir });
		assert.equal(result.groundingVerified, false);
		assert.match(result.groundingReason, /missing-file-citation/);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('verifyFindings partitions grounded and ungrounded findings without dropping either silently', () => {
	const rootDir = makeTempRepo({ 'src/real.ts': 'a\nb\nc\nd\ne\n' });
	try {
		const grounded = {
			severity: 'P2',
			category: 'correctness',
			file: 'src/real.ts',
			lineRange: '1-3',
			evidence: 'ok',
			impact: 'x',
			remediation: 'y',
		};
		const fabricated = {
			severity: 'P1',
			category: 'security',
			file: 'src/does-not-exist.ts',
			lineRange: '1-3',
			evidence: 'fake',
			impact: 'x',
			remediation: 'y',
		};
		const { verified, unverified } = verifyFindings({ findings: [grounded, fabricated], rootDir });
		assert.equal(verified.length, 1);
		assert.equal(verified[0].file, 'src/real.ts');
		assert.equal(unverified.length, 1);
		assert.equal(unverified[0].file, 'src/does-not-exist.ts');
		assert.equal(unverified[0].groundingVerified, false);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});
