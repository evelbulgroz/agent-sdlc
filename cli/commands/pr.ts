import fs from 'node:fs';
import path from 'node:path';
import {
	type PullRequestSpecLike,
	createDraftPullRequest,
	formatPullRequestBody,
} from '../../adapters/github-pr.ts';
import { RUNTIME_SCHEMA_VERSION, createEvent } from '../../policy/contracts.ts';
import { SdlcError } from '../../policy/errors.ts';
import { pushBranch } from '../../workflow/git-manager.ts';
import { type ParsedArguments, requiredValue } from '../arguments.ts';
import { type OpenContextOptions, openContext } from '../run-context.ts';

export async function prRun(
	parsed: ParsedArguments,
	{
		rootDir,
		governor: injectedGovernor,
		onBoundary,
		gitCli,
		execCli,
		ghCli,
	}: {
		rootDir: string;
		governor?: OpenContextOptions['governor'];
		onBoundary?: OpenContextOptions['onBoundary'];
		gitCli?: OpenContextOptions['gitCli'];
		execCli?: OpenContextOptions['execCli'];
		ghCli?: OpenContextOptions['ghCli'];
	},
): Promise<Record<string, unknown>> {
	const runId = requiredValue(parsed, '--run');
	const context = openContext({
		rootDir,
		runId,
		governor: injectedGovernor,
		onBoundary,
		gitCli,
		execCli,
		ghCli,
	});
	try {
		const state = context.store.getRun(runId);
		if (!state) {
			throw new SdlcError('RUN_NOT_FOUND', `No run exists with ID '${runId}'`, { runId });
		}
		if (state.state !== 'DONE' && state.state !== 'READY_FOR_GIT_APPROVAL') {
			throw new SdlcError(
				'INVALID_TRANSITION',
				`Cannot prepare or open PR for run in state '${state.state}' (must be READY_FOR_GIT_APPROVAL or DONE)`,
				{ state: state.state },
			);
		}
		const auth = context.store.getAuthorization(runId);
		const commitRecord = context.store.getGitCommit(runId);
		const draft = context.artifacts.readJson(state.draftArtifact) as PullRequestSpecLike & {
			assumptions?: readonly unknown[];
		};
		const worktreeDir = state.integrationWorktreePath || state.worktreePath || rootDir;
		const branchName = commitRecord?.targetBranch ?? auth?.targetBranch;

		// 1. Get or generate PR body
		let prBody: string;
		const prBodyFile = path.join(context.paths.artifactsDir, 'pr-body.md');
		if (fs.existsSync(prBodyFile)) {
			prBody = fs.readFileSync(prBodyFile, 'utf8');
		} else {
			prBody = formatPullRequestBody({
				spec: draft,
				decisions: draft?.assumptions ?? [],
				repairs: state.semanticRepairsCount ?? 0,
				touchedSurfaces: draft?.touchedSurfaces ?? [],
				allowedPackages: auth?.allowedPackages ?? [],
				runId,
				branchName,
			});
			context.artifacts.writeText('pr-body.md', prBody);
			try {
				fs.writeFileSync(prBodyFile, prBody, 'utf8');
			} catch {}
		}

		let pushed = false;
		if (parsed.booleans.has('--push') || parsed.booleans.has('--open-pr')) {
			if (!branchName) {
				throw new SdlcError('INVALID_INPUT', 'No target branch to push');
			}
			pushBranch({
				worktreeDir,
				branchName,
				remote: 'origin',
				gitCli: context.runtime.gitCli,
			});
			pushed = true;
			context.store.recordEvent(
				createEvent({
					runId,
					runtimeRevision: state.runtimeRevision,
					eventType: 'GIT_PUSHED',
					causalId: `cli-push-${Date.now()}`,
					payload: { branchName, remote: 'origin' },
				}),
			);
		}

		let prRecord = context.store.getPullRequest(runId);
		if (parsed.booleans.has('--open-pr')) {
			if (!branchName) {
				throw new SdlcError('INVALID_INPUT', 'No target branch to open PR for');
			}
			const title = draft?.goal
				? `feat: ${draft.goal}`
				: `feat: automated SDLC implementation (${runId})`;
			const rawGhCli = context.runtime.ghCli ?? context.runtime.execCli;
			const createdPr = createDraftPullRequest({
				worktreeDir,
				title,
				body: prBody,
				branchName,
				baseBranch: 'main',
				ghCli: (cmd, args, opts) => {
					const out = rawGhCli(cmd, args, opts);
					return typeof out === 'string' ? out : out.toString('utf8');
				},
			});
			prRecord = {
				schemaVersion: RUNTIME_SCHEMA_VERSION,
				runId,
				prUrl: createdPr.prUrl,
				prNumber: createdPr.prNumber,
				draft: true,
				branchName,
				baseBranch: 'main',
				createdAt: new Date().toISOString(),
			};
			context.store.savePullRequest(prRecord);
			context.store.recordEvent(
				createEvent({
					runId,
					runtimeRevision: state.runtimeRevision,
					eventType: 'GIT_PR_OPENED',
					causalId: `cli-pr-${Date.now()}`,
					payload: {
						prUrl: createdPr.prUrl,
						prNumber: createdPr.prNumber,
						branchName,
						draft: true,
					},
				}),
			);
		}

		await context.projection.reconcile();
		const result = context.projection.readStatusResult();
		return {
			...result,
			state: state.state,
			prBody,
			pushed,
			pullRequest: prRecord
				? {
						url: prRecord.prUrl,
						number: prRecord.prNumber,
						draft: prRecord.draft,
						branchName: prRecord.branchName,
						baseBranch: prRecord.baseBranch,
					}
				: null,
		};
	} finally {
		context.store.close();
	}
}
