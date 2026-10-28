import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assessSemanticFindingEvidence } from './semantic-review-evidence.ts';

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-review-evidence-'));
	const sourceDir = path.join(root, 'src');
	fs.mkdirSync(sourceDir, { recursive: true });
	fs.writeFileSync(
		path.join(sourceDir, 'SignInPage.tsx'),
		[
			'const [userName, setUserName] = useState("");',
			'const [password, setPassword] = useState("");',
			'<Button disabled={!userName || !password}>Sign in</Button>',
		].join('\n'),
	);
	return {
		root,
		close() {
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

function assess(root, finding) {
	return assessSemanticFindingEvidence({
		finding,
		worktreeDir: root,
		allowedPathPrefixes: ['src'],
	});
}

test('@ac AC-01 marks exact authorized source citations as grounded but not defect-corroborated', () => {
	const testFixture = fixture();
	try {
		const result = assess(testFixture.root, {
			path: 'src/SignInPage.tsx',
			lineRange: [3, 3],
			evidence: 'disabled={!userName || !password}',
		});
		assert.equal(result.citationGrounded, true);
		assert.equal(result.deterministicallyCorroborated, false);
		assert.equal(result.reason, 'CITATION_MATCHED');
	} finally {
		testFixture.close();
	}
});

test('@ac AC-01 reports explicit reasons for unusable semantic citations', () => {
	const testFixture = fixture();
	try {
		assert.equal(
			assess(testFixture.root, {
				path: 'src/SignInPage.tsx',
				lineRange: [3, 3],
				evidence: '',
			}).reason,
			'EMPTY_EVIDENCE',
		);
		assert.equal(
			assess(testFixture.root, {
				path: 'src/SignInPage.tsx',
				lineRange: [30, 30],
				evidence: 'missing',
			}).reason,
			'LINE_RANGE_OUT_OF_BOUNDS',
		);
		assert.equal(
			assess(testFixture.root, {
				path: 'src/missing.ts',
				lineRange: [1, 1],
				evidence: 'missing',
			}).reason,
			'FILE_NOT_FOUND',
		);
		assert.equal(
			assess(testFixture.root, {
				path: '../outside.ts',
				lineRange: [1, 1],
				evidence: 'outside',
			}).reason,
			'OUT_OF_SCOPE_PATH',
		);
		assert.equal(
			assess(testFixture.root, {
				path: 'src/SignInPage.tsx',
				lineRange: [1, 1],
				evidence: 'disabled={!userName || !password}',
			}).reason,
			'EVIDENCE_NOT_IN_CITED_RANGE',
		);
	} finally {
		testFixture.close();
	}
});

test('@ac AC-01 does not ground evidence against an empty cited line', () => {
	const testFixture = fixture();
	try {
		fs.writeFileSync(path.join(testFixture.root, 'src/empty.ts'), '');
		const result = assess(testFixture.root, {
			path: 'src/empty.ts',
			lineRange: [1, 1],
			evidence: 'arbitrary claim',
		});
		assert.equal(result.citationGrounded, false);
		assert.equal(result.reason, 'EVIDENCE_NOT_IN_CITED_RANGE');
	} finally {
		testFixture.close();
	}
});
