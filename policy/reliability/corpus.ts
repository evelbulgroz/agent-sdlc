// Provider-free replay of the checked-in reliability corpus.

import fs from 'node:fs';
import path from 'node:path';
import {
	bindAcCoverageToExecution,
	evaluateAcCoverage,
} from '../../execution/ac-coverage.ts';
import { getEvaluator } from '../../review/evaluator-registry.ts';
import { AGENT_SDLC_PACKAGE_ROOT } from '../canary-planning-files.ts';
import {
	RELIABILITY_FAILURE_CATEGORIES,
	RELIABILITY_SCHEMA_VERSION,
	type ReliabilityFailureCategory,
	canonicalJson,
} from '../contracts.ts';
import {
	type FailureCandidate,
	classifyReliabilityFailure,
} from './failure-classification.ts';
import {
	assertClosedObject,
	assertContainedFixturePath,
	assertSanitizedValue,
	invalidContract,
} from './sanitization.ts';

export const RELIABILITY_CORPUS_VERSION = '1.0.0';

const CORPUS_KEYS = Object.freeze([
	'schemaVersion',
	'caseId',
	'failureCategory',
	'entryPoint',
	'input',
	'expected',
]);

export interface ReliabilityCorpusCase {
	readonly schemaVersion: string;
	readonly caseId: string;
	readonly failureCategory: ReliabilityFailureCategory;
	readonly entryPoint:
		| 'classify-failure'
		| 'review-status'
		| 'ac-coverage'
		| 'ac-execution-coverage';
	readonly input: Record<string, unknown>;
	readonly expected: Record<string, unknown>;
}

export function validateReliabilityCorpusCase(input: unknown): Readonly<ReliabilityCorpusCase> {
	assertClosedObject(input, CORPUS_KEYS, 'reliability corpus case');
	if (input.schemaVersion !== RELIABILITY_CORPUS_VERSION) {
		throw invalidContract('Unsupported reliability corpus schemaVersion');
	}
	if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(String(input.caseId ?? ''))) {
		throw invalidContract('Corpus caseId is invalid');
	}
	if (
		!RELIABILITY_FAILURE_CATEGORIES.includes(
			input.failureCategory as ReliabilityFailureCategory,
		)
	) {
		throw invalidContract('Corpus failureCategory is invalid');
	}
	if (
		![
			'classify-failure',
			'review-status',
			'ac-coverage',
			'ac-execution-coverage',
		].includes(String(input.entryPoint))
	) {
		throw invalidContract('Corpus entryPoint is unsupported');
	}
	if (input.entryPoint === 'classify-failure') {
		assertClosedObject(input.input, ['code', 'message', 'path'], 'corpus input');
		assertClosedObject(input.expected, ['failureCategory'], 'corpus expected');
		if (input.expected.failureCategory !== input.failureCategory) {
			throw invalidContract(
				'Corpus expected category must match failureCategory',
			);
		}
	} else if (input.entryPoint === 'review-status') {
		assertClosedObject(input.input, ['status', 'findings'], 'corpus input');
		assertClosedObject(input.expected, ['status'], 'corpus expected');
		if (!Array.isArray(input.input.findings)) {
			throw invalidContract('Corpus review findings must be an array');
		}
	} else if (input.entryPoint === 'ac-coverage') {
		assertClosedObject(
			input.input,
			['acceptanceCriteria', 'testSource', 'path'],
			'corpus input',
		);
		assertClosedObject(input.expected, ['uncoveredAcIds'], 'corpus expected');
		if (
			!Array.isArray(input.input.acceptanceCriteria) ||
			!Array.isArray(input.expected.uncoveredAcIds)
		) {
			throw invalidContract('Corpus AC coverage arrays are invalid');
		}
	} else if (input.entryPoint === 'ac-execution-coverage') {
		assertClosedObject(
			input.input,
			['acceptanceCriteria', 'testSource', 'path', 'executionOutput'],
			'corpus input',
		);
		assertClosedObject(input.expected, ['notExecutedAcIds'], 'corpus expected');
		if (
			!Array.isArray(input.input.acceptanceCriteria) ||
			!Array.isArray(input.expected.notExecutedAcIds) ||
			typeof input.input.executionOutput !== 'string'
		) {
			throw invalidContract('Corpus AC execution coverage input is invalid');
		}
	}
	assertSanitizedValue(input);
	const rawInput = input.input as Record<string, unknown>;
	if (rawInput.path !== null && rawInput.path !== undefined) {
		assertContainedFixturePath(rawInput.path);
	}
	const cloned: unknown = structuredClone(input);
	return Object.freeze(cloned as ReliabilityCorpusCase);
}

const BUNDLED_CORPUS_DIR = path.join(AGENT_SDLC_PACKAGE_ROOT, 'testing/reliability-corpus');

export function replayReliabilityCorpus({
	rootDir = process.cwd(),
	corpusDir,
}: {
	rootDir?: string;
	corpusDir?: string;
} = {}): Record<string, unknown> {
	const hostCorpusCandidate = path.join(rootDir, 'packages/agent-sdlc/testing/reliability-corpus');
	const resolvedCorpusDir =
		corpusDir ?? (fs.existsSync(hostCorpusCandidate) ? hostCorpusCandidate : BUNDLED_CORPUS_DIR);
	const files = fs
		.readdirSync(resolvedCorpusDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
		.map((entry) => entry.name)
		.sort();
	if (files.length === 0) throw invalidContract('Reliability corpus is empty');
	const seen = new Set<string>();
	const cases: Array<{
		caseId: string;
		failureCategory: ReliabilityFailureCategory;
		entryPoint: string;
		passed: boolean;
	}> = [];
	const environment = providerFreeEnvironment();
	for (const filename of files) {
		const casePath = path.join(resolvedCorpusDir, filename);
		if (fs.lstatSync(casePath).isSymbolicLink()) {
			throw invalidContract('Reliability corpus cannot contain symbolic links');
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(casePath, 'utf8'));
		} catch (error) {
			throw invalidContract(
				`Malformed reliability corpus fixture: ${filename}`,
				error,
			);
		}
		const fixture = validateReliabilityCorpusCase(parsed);
		if (seen.has(fixture.caseId))
			throw invalidContract(`Duplicate corpus caseId: ${fixture.caseId}`);
		seen.add(fixture.caseId);
		const actual = replayCorpusCase(fixture);
		cases.push({
			caseId: fixture.caseId,
			failureCategory: fixture.failureCategory,
			entryPoint: fixture.entryPoint,
			passed: canonicalJson(actual) === canonicalJson(fixture.expected),
		});
	}
	const failed = cases.filter((entry) => !entry.passed);
	return {
		schemaVersion: RELIABILITY_SCHEMA_VERSION,
		corpusVersion: RELIABILITY_CORPUS_VERSION,
		providerOperations: 0,
		providerCredentialVariablesPresent: Object.keys(environment).filter(
			isProviderCredentialName,
		),
		total: cases.length,
		passed: cases.length - failed.length,
		failed: failed.length,
		cases,
		status: failed.length === 0 ? 'PASSED' : 'FAILED',
	};
}

function replayCorpusCase(fixture: ReliabilityCorpusCase): Record<string, unknown> {
	if (fixture.entryPoint === 'classify-failure') {
		return {
			failureCategory: classifyReliabilityFailure(fixture.input as FailureCandidate),
		};
	}
	if (fixture.entryPoint === 'review-status') {
		const evaluated = getEvaluator('review-rubric-v1').evaluate(fixture.input, {
			runId: '2026-09-29-reliability-replay',
			generation: 0,
		});
		return { status: evaluated.status };
	}
	if (fixture.entryPoint === 'ac-coverage') {
		const evaluated = evaluateAcCoverage({
			acceptanceCriteria: fixture.input.acceptanceCriteria as string[],
			touchedFiles: [
				{
					path: String(fixture.input.path ?? ''),
					content: String(fixture.input.testSource ?? ''),
				},
			],
		});
		return { uncoveredAcIds: evaluated.uncoveredAcIds };
	}
	if (fixture.entryPoint === 'ac-execution-coverage') {
		const staticCoverage = evaluateAcCoverage({
			acceptanceCriteria: fixture.input.acceptanceCriteria as string[],
			touchedFiles: [
				{
					path: String(fixture.input.path ?? ''),
					content: String(fixture.input.testSource ?? ''),
				},
			],
		});
		const evaluated = bindAcCoverageToExecution(
			staticCoverage,
			String(fixture.input.executionOutput ?? ''),
		);
		return { notExecutedAcIds: evaluated.notExecutedAcIds };
	}
	throw invalidContract('Corpus entryPoint is unsupported');
}

function providerFreeEnvironment(): Record<string, string | undefined> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !isProviderCredentialName(name),
		),
	);
}

function isProviderCredentialName(name: string): boolean {
	return /(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|XAI|GROK|MODEL).*(?:KEY|TOKEN|CREDENTIAL)/i.test(
		name,
	);
}
