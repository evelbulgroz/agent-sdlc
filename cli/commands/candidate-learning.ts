import path from 'node:path';
import readline from 'node:readline/promises';
import {
	extractLearningTokens,
	loadLearningStore,
	resolveLearningStorePath,
	validateLearningEntry,
} from '../../host/learnings.ts';
import { RepositoryModelGovernor } from '../../adapters/model-governor.ts';
import type { CandidateLearningInput } from '../../persistence/learning-records.ts';
import { SdlcError } from '../../policy/errors.ts';
import { resolveTargetScope } from '../../roles/upstream-recall.ts';
import { type ParsedArguments, requiredValue } from '../arguments.ts';
import { type OpenContextOptions, openContext } from '../run-context.ts';
import type { CliStreams } from '../shell-driver.ts';

export async function promptOptionalLearning(
	streams: CliStreams | null | undefined,
): Promise<{ insight: string; scope: string } | null> {
	if (!streams?.stdin?.isTTY) return null;
	const rawOutput: unknown = streams.stdout;
	const rl = readline.createInterface({
		input: streams.stdin,
		output: rawOutput as NodeJS.WritableStream,
	});
	try {
		const insight = await rl.question(
			'Capture post-mortem learning insight (optional, press Enter to skip): ',
		);
		if (!insight || !insight.trim()) return null;
		const scope = await rl.question('Scope (repository area or package name): ');
		return { insight: insight.trim(), scope: scope ? scope.trim() : '' };
	} finally {
		rl.close();
	}
}

export async function synthesizeLearningPayload({
	runId,
	generation,
	insight,
	scope,
	type = null,
	key = null,
	query = null,
	sourceRole = 'operator',
	existingLearnings = [],
	existingCandidates = [],
}: {
	runId: string;
	generation: number;
	insight: string;
	scope: string;
	type?: string | null;
	key?: string | null;
	query?: string | null;
	sourceRole?: string;
	existingLearnings?: ReadonlyArray<{ key: string }>;
	existingCandidates?: ReadonlyArray<{ key: string }>;
}): Promise<CandidateLearningInput> {
	const resolvedType = type || 'pitfall';
	const tokens = (await extractLearningTokens(insight)).filter((t) => t.length >= 3);
	const baseSlug = `${scope}-${tokens.slice(0, 4).join('-') || 'insight'}`;
	let resolvedKey = key || baseSlug;

	const allKeys = new Set([
		...existingLearnings.map((l) => l.key),
		...existingCandidates.map((c) => c.key),
	]);
	if (!key && allKeys.has(resolvedKey)) {
		resolvedKey = `${resolvedKey}-${runId.slice(-6)}`;
	}

	const resolvedQuery =
		query ||
		Array.from(new Set(await extractLearningTokens(`${scope} ${insight}`)))
			.slice(0, 8)
			.join(' ');

	const candidateLearning: CandidateLearningInput = {
		runId,
		generation,
		stage: 'operator.post_mortem',
		sourceRole,
		type: resolvedType,
		key: resolvedKey,
		scope,
		query: resolvedQuery,
		insight: insight.length > 300 ? insight.slice(0, 300) : insight,
		confidence: 9,
		source: 'user-stated',
	};

	const validation = await validateLearningEntry({
		type: candidateLearning.type,
		key: candidateLearning.key,
		scope: candidateLearning.scope,
		query: candidateLearning.query,
		insight: candidateLearning.insight,
		confidence: candidateLearning.confidence,
		source: candidateLearning.source,
	});

	if (!validation.valid) {
		throw new SdlcError(
			'INVALID_INPUT',
			`Post-mortem learning validation failed: ${validation.errors.join('; ')}`,
			{ errors: validation.errors },
		);
	}

	return candidateLearning;
}

export async function executePostMortem(
	parsed: ParsedArguments,
	{
		rootDir,
		governor: injectedGovernor,
		onBoundary,
		gitCli,
		execCli,
	}: {
		rootDir: string;
		governor?: OpenContextOptions['governor'];
		onBoundary?: OpenContextOptions['onBoundary'];
		gitCli?: OpenContextOptions['gitCli'];
		execCli?: OpenContextOptions['execCli'];
	},
): Promise<{ runId: string; learning: CandidateLearningInput }> {
	const runId = requiredValue(parsed, '--run');
	const insight = requiredValue(parsed, '--learning-insight');
	let rawScope = parsed.values.get('--learning-scope');

	const context = openContext({
		rootDir,
		runId,
		governor: injectedGovernor ?? new RepositoryModelGovernor({ rootDir }),
		onBoundary,
		gitCli,
		execCli,
	});
	try {
		const state = context.store.getRun(runId);
		if (!rawScope) {
			const auth = context.store.getAuthorization(runId);
			rawScope = auth?.allowedPathPrefixes?.[0] || auth?.allowedPackages?.[0] || 'global';
		}
		const scope = resolveTargetScope([rawScope], { rootDir });
		const type = parsed.values.get('--learning-type');
		const key = parsed.values.get('--learning-key');
		const query = parsed.values.get('--learning-query');

		const storePath = await resolveLearningStorePath({}, rootDir);
		const existingLearnings = await loadLearningStore(storePath);
		const existingCandidates = context.store.listCandidateLearnings(runId);

		const candidateLearning = await synthesizeLearningPayload({
			runId,
			generation: state.activeGeneration ?? 0,
			insight,
			scope,
			type,
			key,
			query,
			sourceRole: 'operator',
			existingLearnings,
			existingCandidates,
		});

		context.store.recordPostMortem({ runId, candidateLearning });
		await context.projection.reconcile();

		return {
			runId,
			learning: candidateLearning,
		};
	} finally {
		context.store.close();
	}
}
