// Canonical preflight and acceptance-coverage gate for a workflow snapshot.

import fs from 'node:fs';
import path from 'node:path';
import {
	evaluateAcCoverageFromWorktree,
	listFilesRecursive,
} from '../execution/ac-worktree-coverage.ts';
import {
	type RunAuthorizationRecord,
	type RuntimeState,
	sha256,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { collectTouchedTestFiles, isTouchedTestFile } from '../review/critic-gate.ts';
import { finalPreparationHook } from '../execution/verification-preparation.ts';
import { executePreflightVerifier } from '../review/verifier.ts';
import {
	type WorkflowRuntimeLike,
	getAndValidateAuthorization,
	getRunCheckpointQualityPolicy,
	resolveCheckpointQualityContext,
	resolvePreflightWorktree,
} from './node-helpers.ts';
import { prepareFinalQualityCheckpoint } from './final-quality-checkpoint.ts';
import { blockQualityCheckpoint } from './quality-interrupt.ts';
import { timedSpan } from '../persistence/run-spans.ts';

function boundQualityContext(runtime: WorkflowRuntimeLike, snapshot: Readonly<RuntimeState>) {
	if (!snapshot.qualityCheckpointId && !snapshot.qualityCheckpointKind &&
		!snapshot.qualityCheckpointTreeSha && !snapshot.qualityCheckpointBindingHash) return null;
	try {
		return resolveCheckpointQualityContext(runtime, snapshot);
	} catch (error: unknown) {
		// An accepted slice checkpoint has no reviewable context; the caller's own failure must surface instead.
		if (snapshot.qualityCheckpointKind !== 'final' && error instanceof SdlcError && error.code === 'POLICY_VIOLATION') return null;
		throw error;
	}
}

export async function blockFinalCoverageFailure(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
): Promise<Readonly<RuntimeState>> {
	if (snapshot.blockedReason !== 'AC_COVERAGE_FAILED') return snapshot;
	const context = boundQualityContext(runtime, snapshot);
	if (!context) return snapshot;
	return blockQualityCheckpoint({
		runtime,
		snapshot,
		context,
		status: 'COVERAGE_FAILED',
		reason: 'New-policy acceptance coverage failed for the bound final candidate',
	});
}

function collectSpecFilesFromDirs(
	dirs: readonly string[],
	allowedPathPrefixes: readonly string[] = [],
): string[] {
	const files = new Set<string>();
	for (const dir of dirs) {
		if (!dir || !fs.existsSync(dir)) continue;
		try {
			if (!fs.statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		const roots =
			allowedPathPrefixes.length > 0
				? allowedPathPrefixes
						.map((p) => path.join(dir, p))
						.filter((p) => fs.existsSync(p))
				: [dir];
		for (const root of roots) {
			for (const abs of listFilesRecursive(root)) {
				const rel = path.relative(dir, abs).split(path.sep).join('/');
				if (isTouchedTestFile(rel)) files.add(rel);
			}
		}
	}
	return [...files];
}

function coverageWorktreeDirs(snapshot: Readonly<RuntimeState>): string[] {
	const dirs = new Set<string>();
	for (const dir of [snapshot.integrationWorktreePath, snapshot.worktreePath]) {
		if (dir) dirs.add(dir);
	}
	for (const dir of [...dirs]) {
		const parent = path.dirname(dir);
		const name = path.basename(dir);
		const worktreesRoot =
			name === 'worktree'
				? path.join(parent, 'worktrees')
				: path.basename(parent) === 'worktrees'
					? parent
					: null;
		if (!worktreesRoot || !fs.existsSync(worktreesRoot)) continue;
		try {
			for (const child of fs.readdirSync(worktreesRoot, { withFileTypes: true })) {
				if (child.isDirectory()) dirs.add(path.join(worktreesRoot, child.name));
			}
		} catch {
			// Best-effort sibling worktree discovery.
		}
	}
	return [...dirs];
}

export function applyAcCoverageGate(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
	auth: Readonly<RunAuthorizationRecord>,
	worktreeDir: string,
	{
		preflightBindingArtifact = snapshot.preflightBindingArtifact,
		verificationEvidenceHash,
		transitionFrom,
	}: {
		preflightBindingArtifact?: string | null;
		verificationEvidenceHash?: string;
		// The persisted state; the transition's input hash must chain from it, not from an in-memory candidate.
		transitionFrom?: Readonly<RuntimeState>;
	} = {},
): { snapshot: Readonly<RuntimeState> } {
	const draft = runtime.artifactStore.readJson(snapshot.draftArtifact);
	const qualityPolicy = getRunCheckpointQualityPolicy(runtime, snapshot);
	const newPolicy = qualityPolicy !== null;
	const searchDirs = newPolicy ? [worktreeDir] : coverageWorktreeDirs(snapshot);
	const collected = collectTouchedTestFiles({
		runtime,
		snapshot,
		auth,
		worktreeDirs: searchDirs,
	});
	const touchedTestFiles =
		collected.length > 0
			? collected
			: collectSpecFilesFromDirs(searchDirs, auth?.allowedPathPrefixes);
	let coverage: {
		pass: boolean;
		uncoveredAcIds?: readonly string[];
		unknownCitations?: readonly unknown[];
		citeWithoutAssertion?: readonly unknown[];
		uncitedTouchedTests?: readonly unknown[];
		emptyAssertFiles?: readonly string[];
		staleOracleCitations?: readonly unknown[];
		rows?: readonly unknown[];
		errors?: readonly { code: string; message: string }[];
	};
	try {
		coverage = evaluateAcCoverageFromWorktree({
			draft,
			baseCommitSha: auth?.baseCommitSha,
			gitCli: runtime.gitCli,
			worktreeDir,
			touchedTestFiles,
			allowedPathPrefixes: auth.allowedPathPrefixes ?? [],
			searchDirs,
		});
	} catch (error: unknown) {
		if (!(error instanceof SdlcError) && !newPolicy) throw error;
		coverage = {
			pass: false,
			uncoveredAcIds: [],
			unknownCitations: [],
			citeWithoutAssertion: [],
			uncitedTouchedTests: [],
			emptyAssertFiles: [],
			staleOracleCitations: [],
			rows: [],
			errors: [{
				code: error instanceof SdlcError ? error.code : 'AC_COVERAGE_EVALUATION_FAILED',
				message: error instanceof Error ? error.message : String(error),
			}],
		};
	}
	const coverageArtifact = runtime.artifactStore.writeJson('ac-coverage', coverage);
	const failedNewPolicyCoverage = newPolicy && coverage.pass !== true;
	const next = runtime.transition(transitionFrom ?? snapshot, {
		to: failedNewPolicyCoverage ? 'BLOCKED' : 'REVIEWING_QA',
		eventType: failedNewPolicyCoverage ? 'AC_COVERAGE_FAILED' : 'AC_COVERAGE_PASSED',
		causalId: `ac-coverage-${failedNewPolicyCoverage ? 'failed' : 'pass'}-${snapshot.runtimeRevision}`,
		updates: {
			preflightBindingArtifact,
			...(qualityPolicy ? { qualityPolicy } : {}),
			...(snapshot.qualityCheckpointId ? {
				qualityCheckpointId: snapshot.qualityCheckpointId,
				qualityCheckpointKind: snapshot.qualityCheckpointKind,
				qualityCheckpointSliceId: snapshot.qualityCheckpointSliceId,
				qualityCheckpointTreeSha: snapshot.qualityCheckpointTreeSha,
				qualityCheckpointBindingHash: snapshot.qualityCheckpointBindingHash,
			} : {}),
			...(failedNewPolicyCoverage ? {
				blockedReason: 'AC_COVERAGE_FAILED',
				lastError: {
					code: 'AC_COVERAGE_FAILED',
					message: 'New-policy acceptance coverage failed; QA and delivery are blocked',
				},
			} : {}),
		},
		payload: {
			worktreePath: worktreeDir,
			baseCommitSha: auth.baseCommitSha,
			targetTreeSha: snapshot.targetTreeSha,
			...(qualityPolicy ? { qualityPolicyHash: sha256(qualityPolicy) } : {}),
			...(snapshot.qualityCheckpointBindingHash ? {
				qualityCheckpointBindingHash: snapshot.qualityCheckpointBindingHash,
				qualityCheckpointId: snapshot.qualityCheckpointId,
				qualityCheckpointKind: snapshot.qualityCheckpointKind,
				qualityCheckpointTreeSha: snapshot.qualityCheckpointTreeSha,
			} : {}),
			preflightBindingArtifact,
			verificationEvidenceHash,
			canonical: true,
			status: failedNewPolicyCoverage ? 'FAILED' : 'OK',
			coverageArtifact,
			coveragePass: coverage.pass,
			uncoveredAcIds: coverage.uncoveredAcIds ?? [],
			uncitedTouchedTests: coverage.uncitedTouchedTests ?? [],
			emptyAssertFiles: coverage.emptyAssertFiles ?? [],
			staleOracleCitations: coverage.staleOracleCitations ?? [],
			errors: coverage.errors ?? [],
		},
	});
	return { snapshot: next };
}

export async function escalateAutonomousRepairRetired(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
	{
		causalId = `repair-retired-${snapshot.runtimeRevision}`,
		failurePacket = null,
		failurePacketArtifact = null,
	}: {
		causalId?: string;
		failurePacket?: unknown;
		failurePacketArtifact?: string | null;
	} = {},
): Promise<{ snapshot: Readonly<RuntimeState> }> {
	let packet = failurePacket;
	let artifact = failurePacketArtifact;
	if (!packet) {
		const events = runtime.runtimeStore.listEvents(snapshot.runId);
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const payload =
				events[index]?.payload && typeof events[index]?.payload === 'object'
					? (events[index]?.payload as Record<string, unknown>)
					: null;
			if (payload?.failurePacket) {
				packet = payload.failurePacket;
				artifact =
					artifact ??
					(typeof payload.failurePacketArtifact === 'string'
						? payload.failurePacketArtifact
						: null);
				break;
			}
		}
	}
	const next = runtime.transition(snapshot, {
		to: 'ESCALATED',
		eventType: 'RUN_BLOCKED',
		causalId,
		updates: {
			blockedReason: 'AUTONOMOUS_REPAIR_RETIRED',
			lastError: {
				code: 'AUTONOMOUS_REPAIR_RETIRED',
				message: 'Autonomous repair is retired; the failure packet stays on this event',
				metadata: {
					failurePacketArtifact: artifact,
				},
			},
		},
		payload: {
			reason: 'AUTONOMOUS_REPAIR_RETIRED',
			failurePacket: packet,
			failurePacketArtifact: artifact,
		},
	});
	await runtime.onBoundary('autonomous-repair-retired-transition-recorded', {
		runId: next.runId,
		runtimeRevision: next.runtimeRevision,
	});
	return { snapshot: next };
}

export async function executePreflightForSnapshot(
	runtime: WorkflowRuntimeLike,
	snapshot: Readonly<RuntimeState>,
): Promise<{ snapshot: Readonly<RuntimeState> }> {
	const auth = getAndValidateAuthorization(runtime, snapshot);
	const worktreeDir = resolvePreflightWorktree(snapshot);
	const verifierResult = await executePreflightVerifier({
		runId: snapshot.runId,
		generation: snapshot.activeGeneration ?? 0,
		worktreeDir,
		baseCommitSha: auth.baseCommitSha,
		targetTreeSha: snapshot.targetTreeSha ?? '',
		targetPaths: auth.allowedPathPrefixes,
		artifactStore: runtime.artifactStore,
		execCli: runtime.execCli,
		prepare: finalPreparationHook({
			runId: snapshot.runId, runtimeRevision: snapshot.runtimeRevision, worktreeDir, execCli: runtime.execCli,
			planTasks: runtime.runtimeStore.getTaskPlan(snapshot.runId)?.tasks ?? [],
			authorizedPolicyHash: auth.preparationPolicyHash, frozenSelectionHash: snapshot.preparationSelectionHash,
			artifactStore: runtime.artifactStore, runtimeStore: runtime.runtimeStore, now: () => runtime.now(),
		}),
	});

	if (verifierResult.status === 'FAIL') {
		const qualityContext = boundQualityContext(runtime, snapshot);
		if (qualityContext) {
			return {
				snapshot: await blockQualityCheckpoint({
					runtime,
					snapshot,
					context: qualityContext,
					status: 'PREFLIGHT_FAILED',
					reason: 'Canonical final preflight failed for the bound quality candidate',
					findings: verifierResult.failurePacket ? [verifierResult.failurePacket] : [],
				}),
			};
		}
		if (verifierResult.repairable === false) {
			const next = runtime.transition(snapshot, {
				to: 'ESCALATED',
				eventType: 'RUN_BLOCKED',
				causalId: `verifier-out-of-scope-${snapshot.runtimeRevision}`,
				updates: {
					blockedReason: 'VERIFICATION_OUTSIDE_AUTHORIZED_SCOPE',
					lastError: {
						code: 'VERIFICATION_OUTSIDE_AUTHORIZED_SCOPE',
						message:
							verifierResult.failurePacket?.classification === 'infrastructure_failure'
								? 'Canonical preflight failed on a host condition that source edits cannot fix (for example a busy port)'
								: 'Canonical preflight failed only in packages outside the authorized task scope',
						metadata: {
							failurePacketArtifact: verifierResult.outputArtifact,
							rawOutputArtifact: verifierResult.rawOutputArtifact ?? null,
						},
					},
				},
				payload: {
					failurePacketArtifact: verifierResult.outputArtifact,
					rawOutputArtifact: verifierResult.rawOutputArtifact ?? null,
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
			causalId: `verifier-fail-${snapshot.runtimeRevision}`,
			failurePacket: verifierResult.failurePacket,
			failurePacketArtifact: verifierResult.outputArtifact,
		});
	}

	const bindingArtifact = runtime.artifactStore.writeJson(
		'preflight-binding',
		verifierResult.binding,
	);
	let finalQualityFields: Partial<RuntimeState>;
	try {
		finalQualityFields = await timedSpan(runtime.runtimeStore, 'prepare', 'final checkpoint preparation',
			() => prepareFinalQualityCheckpoint(runtime, snapshot, worktreeDir));
	} catch (error: unknown) {
		const qualityContext = boundQualityContext(runtime, snapshot);
		if (qualityContext) {
			return {
				snapshot: await blockQualityCheckpoint({
					runtime,
					snapshot,
					context: qualityContext,
					status: 'EVIDENCE_FAILED',
					reason: error instanceof Error ? error.message : String(error),
				}),
			};
		}
		throw error;
	}
	const candidateSnapshot = { ...snapshot, ...finalQualityFields };
	const coverageResult = applyAcCoverageGate(runtime, candidateSnapshot, auth, worktreeDir, {
		preflightBindingArtifact: bindingArtifact,
		verificationEvidenceHash:
			verifierResult.binding.preflightResultHash || sha256(verifierResult.binding),
		transitionFrom: snapshot,
	});
	if (coverageResult.snapshot.blockedReason !== 'AC_COVERAGE_FAILED') return coverageResult;
	return {
		snapshot: await blockFinalCoverageFailure(runtime, coverageResult.snapshot),
	};
}
