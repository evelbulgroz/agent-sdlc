// Local commit and committed-tree verification, including the draft pull request.

import fs from 'node:fs';
import path from 'node:path';
import { createDraftPullRequest, formatPullRequestBody } from '../../adapters/github-pr.ts';
import { loadHostProfileOrFallback } from '../../host/host-profile.ts';
import { type RuntimeState, createEvent, sha256 } from '../../policy/contracts.ts';
import { SdlcError } from '../../policy/errors.ts';
import { executeCommittedPreflightVerifier } from '../../review/verifier.ts';
import {
	type CreateLocalCommitResult,
	createLocalBranch,
	createLocalCommit,
	formatCommitMessage,
	pushBranch,
} from '../git-manager.ts';
import {
	type GraphStateValues,
	type WorkflowRuntimeLike,
	collectQaBriefAndAdvisories,
	getAndValidateAuthorization,
} from '../node-helpers.ts';
import { escalateAutonomousRepairRetired } from '../preflight-gate.ts';

function extractErrorCodeAndMessage(
	error: unknown,
	fallbackCode: string,
): { code: string; message: string } {
	const rec =
		error && typeof error === 'object'
			? (error as { code?: unknown; message?: unknown })
			: null;
	const code =
		typeof rec?.code === 'string' && rec.code.length > 0 ? rec.code : fallbackCode;
	const message = error instanceof Error ? error.message : String(rec?.message ?? error);
	return { code, message };
}

export function createCreateLocalCommitNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const auth = getAndValidateAuthorization(runtime, snapshot);
		if (!auth.allowedOperations?.createLocalCommits) {
			throw new SdlcError(
				'OPERATION_NOT_PERMITTED',
				'createLocalCommits operation is not permitted',
			);
		}

		const existingCommit = runtime.runtimeStore.getGitCommit(snapshot.runId);
		if (existingCommit) {
			const next = runtime.transition(snapshot, {
				to: 'VERIFYING_COMMITTED_TREE',
				eventType: 'GIT_COMMITTED',
				causalId: `commit-reused-${existingCommit.commitSha.slice(0, 16)}`,
				updates: {},
				payload: {
					commitSha: existingCommit.commitSha,
					branchName: existingCommit.targetBranch,
					treeSha: existingCommit.treeSha,
					message: existingCommit.message,
				},
			});
			await runtime.onBoundary('committed-transition-recorded', {
				runId: next.runId,
				commitSha: existingCommit.commitSha,
			});
			return { snapshot: next };
		}

		const draft = runtime.artifactStore.readJson(snapshot.draftArtifact) as {
			goal?: string;
			owningContext?: string;
			assumptions?: readonly unknown[];
		};
		const message = formatCommitMessage({
			spec: draft,
			decisions: draft.assumptions ?? [],
			repairs: snapshot.semanticRepairsCount ?? 0,
			type: 'feat',
		});

		const worktreeDir = snapshot.integrationWorktreePath || snapshot.worktreePath || '';
		const hostProfile = loadHostProfileOrFallback(worktreeDir || undefined);
		const commitAuthorName = hostProfile.git?.authorName ?? 'agent-sdlc';
		const commitAuthorEmail = hostProfile.git?.authorEmail ?? 'agent@sdlc.local';
		if (auth.taskManifestHash && auth.allowedOperations?.createBranch) {
			createLocalBranch({
				worktreeDir,
				baseCommitSha: auth.baseCommitSha,
				branchName: auth.targetBranch ?? '',
				gitCli: runtime.gitCli,
			});
		}
		let commitResult: CreateLocalCommitResult;
		try {
			commitResult = createLocalCommit({
				worktreeDir,
				message,
				allowedPathPrefixes: auth.allowedPathPrefixes,
				allowedPackages: auth.allowedPackages,
				authorName: commitAuthorName,
				authorEmail: commitAuthorEmail,
				gitCli: runtime.gitCli,
			});
		} catch (error: unknown) {
			const errInfo = extractErrorCodeAndMessage(error, 'GIT_COMMIT_FAILED');
			const failed = runtime.transition(snapshot, {
				to: 'FAILED',
				eventType: 'RUN_FAILED',
				causalId: `commit-failed-${snapshot.runtimeRevision}`,
				updates: {
					lastError: {
						code: errInfo.code,
						message: errInfo.message,
					},
				},
				payload: { error: errInfo.message },
			});
			return { snapshot: failed };
		}

		if (!commitResult.committed) {
			const ready = runtime.transition(snapshot, {
				to: 'READY_FOR_GIT_APPROVAL',
				eventType: 'RUN_READY_FOR_GIT_APPROVAL',
				causalId: `ready-no-changes-${snapshot.runtimeRevision}`,
				updates: {},
				payload: {
					worktreePath: worktreeDir,
					baseCommitSha: auth.baseCommitSha,
					targetTreeSha: snapshot.targetTreeSha,
					reason: 'NO_CHANGES_STAGED',
				},
			});
			await runtime.onBoundary('ready-git-approval-transition-recorded', {
				runId: ready.runId,
				runtimeRevision: ready.runtimeRevision,
			});
			return { snapshot: ready };
		}

		runtime.runtimeStore.saveGitCommit({
			schemaVersion: '1.0.0',
			runId: snapshot.runId,
			targetBranch: commitResult.branchName || auth.targetBranch,
			commitSha: commitResult.commitSha,
			treeSha: commitResult.treeSha,
			parentSha: commitResult.parentSha || auth.baseCommitSha,
			message,
			authorName: commitAuthorName,
			authorEmail: commitAuthorEmail,
			committedAt: runtime.now().toISOString(),
		});

		const next = runtime.transition(snapshot, {
			to: 'VERIFYING_COMMITTED_TREE',
			eventType: 'GIT_COMMITTED',
			causalId: `commit-${commitResult.commitSha.slice(0, 16)}`,
			updates: {},
			payload: {
				commitSha: commitResult.commitSha,
				branchName: commitResult.branchName,
				treeSha: commitResult.treeSha,
				message,
			},
		});

		await runtime.onBoundary('committed-transition-recorded', {
			runId: next.runId,
			commitSha: commitResult.commitSha,
		});

		return { snapshot: next };
	};
}

export function createVerifyCommittedTreeNode(runtime: WorkflowRuntimeLike) {
	return async ({
		snapshot,
	}: GraphStateValues): Promise<{ snapshot: Readonly<RuntimeState> }> => {
		const advanced = runtime.currentOrAlreadyAdvanced(snapshot);
		if (advanced) return { snapshot: advanced };
		const auth = getAndValidateAuthorization(runtime, snapshot);
		const worktreeDir = snapshot.integrationWorktreePath || snapshot.worktreePath || '';

		const commitRecord = runtime.runtimeStore.getGitCommit(snapshot.runId);
		let commitSha: string | null = commitRecord?.commitSha ?? null;
		if (!commitSha) {
			try {
				const raw = runtime.gitCli('git', ['rev-parse', 'HEAD'], {
					cwd: worktreeDir,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
				});
				commitSha = (typeof raw === 'string' ? raw : raw.toString('utf8')).trim();
			} catch {
				commitSha = null;
			}
		}

		const verifierResult = await executeCommittedPreflightVerifier({
			runId: snapshot.runId,
			generation: snapshot.activeGeneration ?? 0,
			worktreeDir,
			baseCommitSha: auth.baseCommitSha,
			commitSha: commitSha ?? '',
			targetTreeSha: snapshot.targetTreeSha ?? '',
			targetPaths: auth.allowedPathPrefixes,
			artifactStore: runtime.artifactStore,
			execCli: runtime.execCli,
			gitCli: runtime.gitCli,
		});

		if (verifierResult.status === 'FAIL') {
			if (verifierResult.repairable === false) {
				const next = runtime.transition(snapshot, {
					to: 'ESCALATED',
					eventType: 'RUN_BLOCKED',
					causalId: `committed-verifier-out-of-scope-${snapshot.runtimeRevision}`,
					updates: {
						blockedReason: 'VERIFICATION_OUTSIDE_AUTHORIZED_SCOPE',
						lastError: {
							code: 'VERIFICATION_OUTSIDE_AUTHORIZED_SCOPE',
							message:
								verifierResult.failurePacket?.classification === 'infrastructure_failure'
									? 'Committed preflight failed on a host condition that source edits cannot fix (for example a busy port)'
									: 'Committed preflight failed only in packages outside the authorized task scope',
							metadata: {
								failurePacketArtifact: verifierResult.outputArtifact,
							},
						},
					},
					payload: {
						failurePacketArtifact: verifierResult.outputArtifact,
						failurePacket: verifierResult.failurePacket,
					},
				});
				await runtime.onBoundary('verification-out-of-scope-transition-recorded', {
					runId: next.runId,
					runtimeRevision: next.runtimeRevision,
				});
				return { snapshot: next };
			}
			return escalateAutonomousRepairRetired(runtime, snapshot, {
				causalId: `committed-verifier-fail-${snapshot.runtimeRevision}`,
				failurePacket: verifierResult.failurePacket,
				failurePacketArtifact: verifierResult.outputArtifact,
			});
		}

		const bindingArtifact = runtime.artifactStore.writeJson(
			'committed-preflight-binding',
			verifierResult.binding,
		);
		const verificationEvidenceHash =
			verifierResult.binding.preflightResultHash || sha256(verifierResult.binding);

		let prBodyArtifact: string | null = null;
		let prBody: string | null = null;
		const { qaDivergences, coverageAdvisories, semanticReviewAdvisories } =
			collectQaBriefAndAdvisories(runtime, snapshot);
		const draft = runtime.artifactStore.readJson(snapshot.draftArtifact) as {
			goal?: string;
			owningContext?: string;
			assumptions?: readonly unknown[];
			touchedSurfaces?: readonly string[];
		};
		try {
			prBody = formatPullRequestBody({
				spec: draft,
				decisions: draft?.assumptions ?? [],
				repairs: snapshot.semanticRepairsCount ?? 0,
				preflightEvidence: verifierResult.binding,
				touchedSurfaces: draft?.touchedSurfaces ?? [],
				allowedPackages: auth.allowedPackages ?? [],
				runId: snapshot.runId,
				branchName: commitRecord?.targetBranch ?? auth.targetBranch,
				qaDivergences,
				coverageAdvisories,
				semanticReviewAdvisories,
			});
			prBodyArtifact = runtime.artifactStore.writeText('pr-body.md', prBody);
			try {
				fs.writeFileSync(
					path.join(runtime.artifactStore.artifactsDir, 'pr-body.md'),
					prBody,
					'utf8',
				);
			} catch {
				// Best-effort copy
			}
			runtime.runtimeStore.recordEvent(
				createEvent({
					runId: snapshot.runId,
					runtimeRevision: snapshot.runtimeRevision,
					eventType: 'PR_BODY_PREPARED',
					causalId: `pr-body-${snapshot.runtimeRevision}`,
					payload: { prBodyArtifact },
				}),
			);
		} catch {
			// Non-fatal if PR body formatting fails
		}

		if (auth.allowedOperations?.push) {
			const branchToPush = commitRecord?.targetBranch ?? auth.targetBranch ?? '';
			try {
				pushBranch({
					worktreeDir,
					branchName: branchToPush,
					remote: 'origin',
					gitCli: runtime.gitCli,
				});
			} catch (error: unknown) {
				const errInfo = extractErrorCodeAndMessage(error, 'GIT_PUSH_FAILED');
				const failed = runtime.transition(snapshot, {
					to: 'FAILED',
					eventType: 'RUN_FAILED',
					causalId: `push-failed-${snapshot.runtimeRevision}`,
					updates: {
						lastError: {
							code: errInfo.code,
							message: errInfo.message,
						},
					},
					payload: { error: errInfo.message },
				});
				return { snapshot: failed };
			}
		}

		let prRecord: {
			schemaVersion: string;
			runId: string;
			prUrl: string;
			prNumber: number;
			draft: boolean;
			branchName: string;
			baseBranch: string;
			createdAt: string;
		} | null = null;
		if (auth.allowedOperations?.openPullRequest) {
			const branchToPush = commitRecord?.targetBranch ?? auth.targetBranch ?? '';
			const title = `feat(${auth.allowedPackages[0] || 'core'}): ${draft?.goal || 'SDLC change'}`;
			const createdPr = createDraftPullRequest({
				worktreeDir,
				title,
				body: prBody ?? 'Automated SDLC implementation',
				branchName: branchToPush,
				baseBranch: 'main',
				ghCli: runtime.ghCli,
			});
			prRecord = {
				schemaVersion: '1.0.0',
				runId: snapshot.runId,
				prUrl: createdPr.prUrl,
				prNumber: createdPr.prNumber,
				draft: true,
				branchName: createdPr.branchName,
				baseBranch: createdPr.baseBranch,
				createdAt: runtime.now().toISOString(),
			};
			runtime.runtimeStore.savePullRequest(prRecord);
			runtime.runtimeStore.recordEvent(
				createEvent({
					runId: snapshot.runId,
					runtimeRevision: snapshot.runtimeRevision,
					eventType: 'GIT_PR_OPENED',
					causalId: `git-pr-${snapshot.runtimeRevision}`,
					payload: {
						prUrl: createdPr.prUrl,
						prNumber: createdPr.prNumber,
						branchName: branchToPush,
						draft: true,
					},
				}),
			);
		}

		const terminal = runtime.transition(snapshot, {
			to: 'DONE',
			eventType: 'RUN_COMPLETED',
			causalId: `run-done-${snapshot.runtimeRevision}`,
			updates: {
				preflightBindingArtifact: bindingArtifact,
			},
			payload: {
				commitSha,
				branchName: commitRecord?.targetBranch ?? null,
				targetTreeSha: snapshot.targetTreeSha,
				status: 'DONE',
				preflightBindingArtifact: bindingArtifact,
				verificationEvidenceHash,
				prBodyArtifact,
				qaDivergences,
				coverageAdvisories,
				semanticReviewAdvisories,
				pullRequest: prRecord
					? {
							url: prRecord.prUrl,
							number: prRecord.prNumber,
							draft: prRecord.draft,
							branchName: prRecord.branchName,
					  }
					: null,
			},
		});

		await runtime.onBoundary('done-transition-recorded', {
			runId: terminal.runId,
			runtimeRevision: terminal.runtimeRevision,
		});

		return { snapshot: terminal };
	};
}
