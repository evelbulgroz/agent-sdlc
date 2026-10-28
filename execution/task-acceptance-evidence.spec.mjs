import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
	createAcceptanceEvidenceValidator,
} from './task-acceptance-evidence.ts';

test('@ac AC-01 AC-03 AC-04 validates current source citations against executed JSON evidence', () => {
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-execution-validator-'));
	const testPath = 'apps/frontends/example/src/Page.spec.tsx';
	const absolutePath = path.join(worktreeDir, testPath);
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	fs.writeFileSync(
		absolutePath,
		`it('observable behavior @ac AC-01', () => { expect(true).toBe(true); });\n`,
	);
	try {
		const command = [
			'pnpm',
			'--filter',
			'@fitness-app/example',
			'test',
			'--',
			'src/Page.spec.tsx',
			'--reporter=json',
		];
		const validator = createAcceptanceEvidenceValidator({
			acceptanceCriteria: [
				'AC-01: Behavior is observed. Given valid input. Then the result is visible.',
			],
			worktreeDir,
			authoredTestPaths: [testPath],
			allowedPathPrefixes: ['apps/frontends/example'],
			acceptanceEvidenceCommand: command,
		});

		const state = {
			lastSubstantiveWriteStep: 1,
			toolHistory: [
				{
					stepIndex: 2,
					toolName: 'run_allowlisted_command',
					parameters: { command: command[0], args: command.slice(1) },
					result: {
						exitCode: 0,
						stdout: JSON.stringify({
							testResults: [
								{
									assertionResults: [
										{
											title: 'observable behavior @ac AC-01',
											status: 'passed',
										},
									],
								},
							],
						}),
					},
				},
			],
		};
		assert.equal(validator({ state }).pass, true);
		const missing = validator({
			state: {
				lastSubstantiveWriteStep: 3,
				toolHistory: state.toolHistory,
			},
		});
		assert.equal(missing.pass, false);
		assert.equal(missing.evidenceMissing, true);
		assert.match(missing.summary, /acceptance execution evidence is required/);
		state.toolHistory[0].result.stdout = '{malformed';
		const malformed = validator({ state });
		assert.equal(malformed.pass, false);
		assert.match(malformed.summary, /\[execution-evidence\]/);
	} finally {
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
});

test('@ac AC-02 bypasses AC-citation evidence for enabling slices with no acceptance criteria', () => {
	// Enabling slices are contract-required to carry acceptanceCriteria: []
	// (contracts.mjs validateManifestSlice). Authoring a spec file for an
	// enabling task must not be blocked by an unsatisfiable AC-citation
	// requirement; completion is still governed by the separate
	// "declared verification must pass" gate in controlled-executor.mjs.
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-enabling-validator-'));
	const testPath = 'apps/services/example/src/value.spec.ts';
	const absolutePath = path.join(worktreeDir, testPath);
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	fs.writeFileSync(
		absolutePath,
		`it('delegates equality', () => { expect(true).toBe(true); });\n`,
	);
	try {
		const validator = createAcceptanceEvidenceValidator({
			acceptanceCriteria: [],
			worktreeDir,
			authoredTestPaths: [testPath],
			allowedPathPrefixes: ['apps/services/example'],
			acceptanceEvidenceCommand: [
				'pnpm',
				'--filter',
				'@fitness-app/example',
				'test',
			],
		});
		assert.equal(validator, null);
	} finally {
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
});

test('@ac AC-03 AC-05 keeps a missing oracle branch in implementer convergence', () => {
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-case-validator-'));
	const testPath = 'apps/frontends/example/src/Page.spec.tsx';
	const absolutePath = path.join(worktreeDir, testPath);
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	fs.writeFileSync(
		absolutePath,
		`it('username empty @ac AC-01 @case AC-01.1', () => { expect(true).toBe(true); });\n`,
	);
	try {
		const command = [
			'pnpm',
			'--filter',
			'@fitness-app/example',
			'test',
			'--',
			'src/Page.spec.tsx',
			'--reporter=json',
		];
		const validator = createAcceptanceEvidenceValidator({
			acceptanceCriteria: [
				'AC-01: Incomplete input is blocked. Given either field is empty. Then submission is disabled. Cases: AC-01.1: username empty; AC-01.2: password empty.',
			],
			worktreeDir,
			authoredTestPaths: [testPath],
			allowedPathPrefixes: ['apps/frontends/example'],
			acceptanceEvidenceCommand: command,
		});
		const result = validator({
			state: {
				lastSubstantiveWriteStep: 1,
				toolHistory: [
					{
						stepIndex: 2,
						toolName: 'run_allowlisted_command',
						parameters: { command: command[0], args: command.slice(1) },
						result: {
							exitCode: 0,
							stdout: JSON.stringify({
								testResults: [
									{
										assertionResults: [
											{
												title:
													'username empty @ac AC-01 @case AC-01.1',
												status: 'passed',
											},
										],
									},
								],
							}),
						},
					},
				],
			},
		});
		assert.equal(result.pass, false);
		assert.match(result.summary, /\[uncovered-case\] AC-01\.2/);
		assert.match(result.summary, /\[not-executed-case\] AC-01\.2/);
	} finally {
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
});

test('createAcceptanceEvidenceValidator recognizes other spec criteria via knownAcceptanceCriteria and does not flag them as unknown in multi-task slices', () => {
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-multi-validator-'));
	const existingTestPath = 'apps/services/example/src/upstream.spec.ts';
	const newTestPath = 'apps/services/example/src/downstream.spec.ts';
	const absExisting = path.join(worktreeDir, existingTestPath);
	const absNew = path.join(worktreeDir, newTestPath);
	fs.mkdirSync(path.dirname(absExisting), { recursive: true });
	fs.writeFileSync(
		absExisting,
		`it('upstream behavior @ac AC-01', () => { expect(true).toBe(true); });\n`,
	);
	fs.writeFileSync(
		absNew,
		`it('downstream behavior @ac AC-03', () => { expect(true).toBe(true); });\n`,
	);
	try {
		const command = [
			'pnpm',
			'--filter',
			'@fitness-app/example',
			'test',
			'--',
			'src/upstream.spec.ts',
			'src/downstream.spec.ts',
			'--reporter=json',
		];
		const validator = createAcceptanceEvidenceValidator({
			acceptanceCriteria: [
				'AC-03: Downstream behavior. Given valid state. Then downstream result is returned.',
			],
			knownAcceptanceCriteria: [
				'AC-01: Upstream behavior. Given valid input. Then upstream result is returned.',
				'AC-02: Intermediate behavior. Given intermediate state. Then intermediate result is returned.',
				'AC-03: Downstream behavior. Given valid state. Then downstream result is returned.',
			],
			worktreeDir,
			authoredTestPaths: [existingTestPath, newTestPath],
			allowedPathPrefixes: ['apps/services/example'],
			acceptanceEvidenceCommand: command,
		});
		const result = validator({
			state: {
				lastSubstantiveWriteStep: 1,
				toolHistory: [
					{
						stepIndex: 2,
						toolName: 'run_allowlisted_command',
						parameters: { command: command[0], args: command.slice(1) },
						result: {
							exitCode: 0,
							stdout: JSON.stringify({
								testResults: [
									{
										assertionResults: [
											{
												title: 'upstream behavior @ac AC-01',
												status: 'passed',
											},
											{
												title: 'downstream behavior @ac AC-03',
												status: 'passed',
											},
										],
									},
								],
							}),
						},
					},
				],
			},
		});
		assert.equal(result.pass, true);
		assert.deepEqual(result.coverage.unknownCitations, []);
		assert.deepEqual(result.coverage.uncoveredAcIds, []);
	} finally {
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
});

test('createAcceptanceEvidenceValidator recognizes baseline citations via baseCommitSha and gitCli', () => {
	const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-baseline-validator-'));
	const testPath = 'apps/frontends/fitnessapp-pwa-frontend/src/ui/SignInPage.spec.tsx';
	const absPath = path.join(worktreeDir, testPath);
	fs.mkdirSync(path.dirname(absPath), { recursive: true });
	fs.writeFileSync(
		absPath,
		`it('reports no axe violations @ac AC-05', () => { expect(true).toBe(true); });\n` +
		`it('enables button when credentials present @ac AC-01', () => { expect(true).toBe(true); });\n`,
	);
	const baseCommitSha = 'c'.repeat(40);
	const baseContent = `it('reports no axe violations @ac AC-05', () => { expect(true).toBe(true); });\n`;
	const gitCli = (cmd, args) => {
		if (args[0] === 'show' && args[1] === `${baseCommitSha}:${testPath}`) {
			return baseContent;
		}
		throw new Error('Not found');
	};
	try {
		const command = [
			'pnpm',
			'--filter',
			'@fitness-app/pwa-frontend',
			'test',
			'--',
			'src/ui/SignInPage.spec.tsx',
			'--reporter=json',
		];
		const validator = createAcceptanceEvidenceValidator({
			acceptanceCriteria: [
				'AC-01: User button readiness. Given credentials. Then button enabled.',
			],
			baseCommitSha,
			gitCli,
			worktreeDir,
			authoredTestPaths: [testPath],
			allowedPathPrefixes: ['apps/frontends/fitnessapp-pwa-frontend'],
			acceptanceEvidenceCommand: command,
		});
		const result = validator({
			state: {
				lastSubstantiveWriteStep: 1,
				toolHistory: [
					{
						stepIndex: 2,
						toolName: 'run_allowlisted_command',
						parameters: { command: command[0], args: command.slice(1) },
						result: {
							exitCode: 0,
							stdout: JSON.stringify({
								testResults: [
									{
										assertionResults: [
											{
												title: 'reports no axe violations @ac AC-05',
												status: 'passed',
											},
											{
												title: 'enables button when credentials present @ac AC-01',
												status: 'passed',
											},
										],
									},
								],
							}),
						},
					},
				],
			},
		});
		assert.equal(result.pass, true);
		assert.deepEqual(result.coverage.unknownCitations, []);
		assert.deepEqual(result.coverage.uncoveredAcIds, []);
	} finally {
		fs.rmSync(worktreeDir, { recursive: true, force: true });
	}
});
