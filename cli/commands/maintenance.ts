import { archiveCompletedLedgerRuns } from '../../persistence/ledger-archive.ts';
import { sweepRuns } from '../../persistence/run-archive.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { SdlcError } from '../../policy/errors.ts';
import {
	buildReliabilityReport,
	compareReliabilityRoutes,
	evaluateCanaryEligibility,
	qualifyCanaryRun,
	replayReliabilityCorpus,
} from '../../policy/reliability.ts';
import { evaluateTaskReadiness } from '../../policy/task-planner.ts';
import { RoleRegistry } from '../../roles/role-registry.ts';
import { evaluateAcceptanceCriteriaQuality } from '../../workflow/acceptance-criteria.ts';
import type { GitCliFn } from '../../workflow/git-manager.ts';
import {
	evaluateCompleteness,
	parseSpecification,
} from '../../workflow/specification.ts';
import { type ParsedArguments, requiredValue } from '../arguments.ts';
import { resolveGoalText, resolveTaskManifest } from '../run-context.ts';

export interface PruneRunsOptions {
	rootDir?: string;
	dryRun?: boolean;
	now?: number;
	gitCli?: GitCliFn;
}

export async function pruneRuns(
	parsedOrOptions: ParsedArguments | PruneRunsOptions = {},
	maybeOptions: PruneRunsOptions = {},
): Promise<Record<string, unknown>> {
	const hasParsed =
		'booleans' in parsedOrOptions && parsedOrOptions.booleans instanceof Set;
	const parsed = hasParsed ? (parsedOrOptions as ParsedArguments) : null;
	const options = hasParsed ? maybeOptions : (parsedOrOptions as PruneRunsOptions);
	const rootDir = options?.rootDir ?? REPOSITORY_ROOT;
	const dryRun = Boolean(parsed?.booleans?.has('--dry-run') || options?.dryRun);

	const sweep = sweepRuns({
		rootDir,
		now: options?.now,
		dryRun,
		gitCli: options?.gitCli,
	});
	const ledger = dryRun
		? { archived: [] as string[], freedTokens: 0, freedCalls: 0, freedCostMicrousd: 0 }
		: archiveCompletedLedgerRuns(rootDir);

	const message = `${dryRun ? '[dry-run] ' : ''}Sweep: ${sweep.cleaned.length} cleaned, ${sweep.archived.length} archived, ${sweep.kept.length} kept, ${sweep.skipped.length} skipped. Model-usage ledgers archived: ${ledger.archived.length} (${ledger.freedTokens} tokens freed across ${ledger.freedCalls} calls).`;
	return {
		state: 'DONE',
		dryRun,
		cleaned: sweep.cleaned,
		archived: sweep.archived,
		kept: sweep.kept,
		skipped: sweep.skipped,
		archivedCount: ledger.archived.length,
		archivedRuns: ledger.archived,
		freedTokens: ledger.freedTokens,
		freedCalls: ledger.freedCalls,
		freedCostMicrousd: ledger.freedCostMicrousd,
		message,
	};
}

export function checkSpecRun(
	parsed: ParsedArguments,
	{ rootDir }: { rootDir: string },
) {
	const loaded = new RoleRegistry({ rootDir }).load();
	const goal = resolveGoalText(parsed, {
		rootDir,
		maxGoalBytes: loaded.workflow.limits.maxGoalBytes,
		command: 'check-spec',
	});
	const draft = parseSpecification(goal);
	const completeness = evaluateCompleteness(draft);
	const acceptanceCriteriaQuality = evaluateAcceptanceCriteriaQuality(draft);
	const taskManifest = resolveTaskManifest(parsed, {
		rootDir,
		maxBytes: loaded.workflow.limits.maxGoalBytes,
	});
	const taskReadiness =
		completeness.complete === true && acceptanceCriteriaQuality.complete === true
			? evaluateTaskReadiness({ draft, taskManifest, rootDir })
			: null;
	return {
		ready:
			completeness.complete === true &&
			acceptanceCriteriaQuality.complete === true &&
			taskReadiness !== null,
		completeness,
		acceptanceCriteriaQuality,
		taskReadiness,
	};
}

export async function canaryStep(): Promise<never> {
	throw new SdlcError('INVALID_INPUT', 'canary step is retired');
}

export function canaryCheck(
	parsed: ParsedArguments,
	options: { rootDir: string },
): Record<string, unknown> {
	const checked = checkSpecRun(parsed, options);
	if (!checked.ready || !checked.taskReadiness) {
		return {
			schemaVersion: '1.0.0',
			status: 'CANARY_INELIGIBLE',
			eligible: false,
			violations: [{ dimension: 'specReadiness', actual: false, maximum: true }],
			spec: checked,
		};
	}
	return { ...evaluateCanaryEligibility(checked.taskReadiness), spec: checked };
}

export function reliabilityReport(
	parsed: ParsedArguments,
	{ rootDir }: { rootDir: string },
) {
	const runId = parsed.values.get('--run');
	return buildReliabilityReport({
		rootDir,
		runIds: runId ? [runId] : null,
	});
}

export async function qualifyCanaryCommand(
	parsed: ParsedArguments,
	options: { rootDir: string },
): Promise<Record<string, unknown>> {
	return qualifyCanaryRun({
		rootDir: options.rootDir,
		runId: requiredValue(parsed, '--run'),
	});
}

export function replayReliabilityCommand(
	_parsed: ParsedArguments,
	options: { rootDir?: string },
): Record<string, unknown> {
	return replayReliabilityCorpus(options);
}

export function compareReliabilityCommand(
	parsed: ParsedArguments,
	options: { rootDir: string },
): Record<string, unknown> {
	return compareReliabilityRoutes(reliabilityReport(parsed, options));
}
