import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	approvedAcIds,
} from './ac-citations.ts';
import {
	evaluateAcCoverageFromWorktree,
} from './ac-worktree-coverage.ts';
import {
	SdlcError,
} from '../policy/errors.ts';

const AC01 =
	'AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.';
const AC02 =
	'AC-02: Second criterion is stored. Given a newline-separated answer. Then both ids are unique.';
const AC03 =
	'AC-03: Third criterion stays uncovered. Given no citing test. Then ac-coverage reports AC-03.';
const AC_WITH_CASES =
	'AC-04: Every branch is observed. Given either username or password is empty. Then submission is disabled. Cases: AC-04.1: username empty with password present; AC-04.2: password empty with username present.';

test('evaluateAcCoverageFromWorktree fails closed on nil draft, missing worktree, and missing file', () => {
	assert.throws(
		() => evaluateAcCoverageFromWorktree({ draft: null, worktreeDir: '/tmp' }),
		(error) => error instanceof SdlcError && error.code === 'INVALID_INPUT',
	);
	assert.throws(
		() =>
			evaluateAcCoverageFromWorktree({
				draft: { acceptanceCriteria: [AC01] },
				worktreeDir: '',
			}),
		(error) => error instanceof SdlcError && error.code === 'INVALID_INPUT',
	);
	assert.throws(
		() =>
			evaluateAcCoverageFromWorktree({
				draft: { acceptanceCriteria: [AC01] },
				worktreeDir: '/tmp',
				touchedTestFiles: ['missing.spec.ts'],
				readFile: () => {
					throw Object.assign(new Error('missing'), { code: 'ENOENT' });
				},
			}),
		(error) => error instanceof SdlcError && error.code === 'POLICY_VIOLATION',
	);
});

test('evaluateAcCoverageFromWorktree reads worktree files and scans leftover oracles', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-coverage-'));
	try {
		const specDir = path.join(root, 'services/billing/src');
		fs.mkdirSync(specDir, { recursive: true });
		fs.writeFileSync(
			path.join(specDir, 'feature.spec.ts'),
			`it('covers @ac AC-01', () => { expect(true).toBe(true); });\n`,
		);
		fs.writeFileSync(
			path.join(specDir, 'legacy.oracle.spec.ts'),
			`it('stale @ac AC-99 @oracle', () => { expect(1).toBe(1); });\n`,
		);
		const result = evaluateAcCoverageFromWorktree({
			draft: { acceptanceCriteria: [AC01] },
			worktreeDir: root,
			touchedTestFiles: ['services/billing/src/feature.spec.ts'],
			allowedPathPrefixes: ['services/billing'],
		});
		assert.equal(result.pass, true);
		assert.equal(result.staleOracleCitations[0].id, 'AC-99');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('evaluateAcCoverageFromWorktree extracts baseline citations via gitCli show', () => {
	const draft = {
		acceptanceCriteria: [
			'AC-01: User button readiness. Given credentials. Then button enabled.',
		],
	};
	const baseCommitSha = 'b'.repeat(40);
	const baseContent = `it('reports no axe violations @ac AC-05', () => { expect(true).toBe(true); });`;
	const worktreeContent = `
it('reports no axe violations @ac AC-05', () => { expect(true).toBe(true); });
it('enables button when credentials present @ac AC-01', () => { expect(true).toBe(true); });
`;

	const gitCli = (cmd, args) => {
		if (args[0] === 'show' && args[1] === `${baseCommitSha}:src/SignInPage.spec.tsx`) {
			return baseContent;
		}
		throw new Error('Not found');
	};

	const result = evaluateAcCoverageFromWorktree({
		draft,
		baseCommitSha,
		gitCli,
		worktreeDir: '/tmp/worktree',
		touchedTestFiles: ['src/SignInPage.spec.tsx'],
		allowedPathPrefixes: ['src/'],
		readFile: () => worktreeContent,
		listFiles: () => [],
	});

	assert.equal(result.pass, true);
	assert.deepEqual(result.unknownCitations, []);
	assert.deepEqual(result.uncoveredAcIds, []);
	assert.deepEqual(result.approvedAcIds, ['AC-01']);
});
