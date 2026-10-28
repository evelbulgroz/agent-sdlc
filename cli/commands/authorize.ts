import path from 'node:path';
import { RepositoryModelGovernor } from '../../adapters/model-governor.ts';
import {
	type DraftScopeInput,
	type TaskManifestScopeInput,
	createDefaultAuthorizationEnvelope,
	deriveScopeFromDraft,
} from '../../policy/authorization.ts';
import { SdlcError } from '../../policy/errors.ts';
import { type ParsedArguments, requiredValue } from '../arguments.ts';
import { type OpenContextOptions, openContext, readBoundedFile } from '../run-context.ts';
import type { CliStreams } from '../shell-driver.ts';

function gitText(
	gitCli: OpenContextOptions['gitCli'],
	args: readonly string[],
	options: Record<string, unknown>,
): string {
	if (!gitCli) return '';
	const result = gitCli('git', args, options);
	return typeof result === 'string' ? result : result.toString('utf8');
}

export async function authorizeRun(
	parsed: ParsedArguments,
	{
		rootDir,
		streams,
		governor: injectedGovernor,
		onBoundary,
		gitCli,
		execCli,
		ghCli,
	}: {
		rootDir: string;
		streams?: CliStreams;
		governor?: OpenContextOptions['governor'];
		onBoundary?: OpenContextOptions['onBoundary'];
		gitCli?: OpenContextOptions['gitCli'];
		execCli?: OpenContextOptions['execCli'];
		ghCli?: OpenContextOptions['ghCli'];
	},
): Promise<Record<string, unknown>> {
	const runId = requiredValue(parsed, '--run');
	const hasEnvelopeFile = parsed.values.has('--envelope-file');
	const isInteractive = parsed.booleans.has('--interactive');
	const context = openContext({
		rootDir,
		runId,
		governor: injectedGovernor ?? new RepositoryModelGovernor({ rootDir }),
		onBoundary,
		gitCli,
		execCli,
		ghCli,
	});
	try {
		await context.projection.reconcile();
		let state = context.store.getRun(runId);
		state = await context.runtime.synchronizeCheckpoint(state);
		if (state.state !== 'SPEC_APPROVED' && state.state !== 'WAITING_FOR_AUTHORIZATION') {
			throw new SdlcError(
				'INVALID_TRANSITION',
				`Cannot authorize run in state '${state.state}' (must be SPEC_APPROVED or WAITING_FOR_AUTHORIZATION)`,
			);
		}
		const push = parsed.booleans.has('--push') || parsed.booleans.has('--open-pr');
		const openPullRequest = parsed.booleans.has('--open-pr');
		const createLocalCommits = parsed.booleans.has('--create-local-commits') || push;
		const createBranch = parsed.booleans.has('--create-branch') || createLocalCommits;
		const targetBranch = parsed.values.get('--branch-name') ?? undefined;

		let envelope: unknown;
		if (hasEnvelopeFile) {
			const envelopeFilePath = path.resolve(
				rootDir,
				parsed.values.get('--envelope-file') ?? '',
			);
			const raw = readBoundedFile(envelopeFilePath, 65536);
			let parsedEnvelope: {
				allowedOperations?: Record<string, boolean>;
				targetBranch?: string;
				[key: string]: unknown;
			};
			try {
				parsedEnvelope = JSON.parse(raw) as {
					allowedOperations?: Record<string, boolean>;
					targetBranch?: string;
					[key: string]: unknown;
				};
			} catch (error: unknown) {
				throw new SdlcError(
					'INVALID_INPUT',
					'Authorization envelope is not valid JSON',
					{},
					{ cause: error },
				);
			}
			if (createBranch) {
				parsedEnvelope.allowedOperations = parsedEnvelope.allowedOperations ?? {};
				parsedEnvelope.allowedOperations.createBranch = true;
			}
			if (createLocalCommits) {
				parsedEnvelope.allowedOperations = parsedEnvelope.allowedOperations ?? {};
				parsedEnvelope.allowedOperations.createLocalCommits = true;
			}
			if (push) {
				parsedEnvelope.allowedOperations = parsedEnvelope.allowedOperations ?? {};
				parsedEnvelope.allowedOperations.push = true;
			}
			if (openPullRequest) {
				parsedEnvelope.allowedOperations = parsedEnvelope.allowedOperations ?? {};
				parsedEnvelope.allowedOperations.openPullRequest = true;
			}
			if (targetBranch) {
				parsedEnvelope.targetBranch = targetBranch;
			}
			envelope = parsedEnvelope;
		} else {
			const draft = context.artifacts.readJson(state.draftArtifact) as DraftScopeInput;
			let baseCommitSha: string;
			try {
				baseCommitSha = gitText(context.runtime.gitCli, ['rev-parse', 'HEAD'], {
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
				}).trim();
			} catch {
				baseCommitSha = '0000000000000000000000000000000000000000';
			}
			const taskManifest = state.taskManifestArtifact
				? (context.artifacts.readJson(state.taskManifestArtifact) as TaskManifestScopeInput)
				: null;
			const { allowedPackages, allowedPathPrefixes } = deriveScopeFromDraft(
				draft,
				taskManifest,
			);

			if (!parsed.booleans.has('--json') && streams?.stdout) {
				streams.stdout.write(
					`Authorization scope confirmed: packages: ${allowedPackages.join(', ') || '(none)'}, prefixes: ${allowedPathPrefixes.join(', ') || '(none)'}, base SHA: ${baseCommitSha}\n`,
				);
			}

			envelope = createDefaultAuthorizationEnvelope({
				runId: state.runId,
				approvedSpecHash: state.approvedSpecHash ?? state.draftHash ?? '',
				taskManifestHash: state.taskManifestHash,
				rootDir,
				baseCommitSha,
				allowedPackages,
				allowedPathPrefixes,
				createBranch,
				createLocalCommits,
				push,
				openPullRequest,
				targetBranch,
				approvalMethod: isInteractive ? 'local-interactive' : 'local-cli',
				now: new Date(),
			});
		}
		const next = await context.runtime.authorize(state, envelope);
		await context.projection.reconcile();
		return { ...context.projection.readStatusResult(), state: next.state };
	} finally {
		context.store.close();
	}
}
