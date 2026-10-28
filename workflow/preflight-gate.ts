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
import { executePreflightVerifier } from '../review/verifier.ts';
import {
	type WorkflowRuntimeLike,
	getAndValidateAuthorization,
	resolvePreflightWorktree,
} from './node-helpers.ts';

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
	}: {
		preflightBindingArtifact?: string | null;
		verificationEvidenceHash?: string;
	} = {},
): { snapshot: Readonly<RuntimeState> } {
	const draft = runtime.artifactStore.readJson(snapshot.draftArtifact);
	const searchDirs = coverageWorktreeDirs(snapshot);
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
		if (!(error instanceof SdlcError)) throw error;
		coverage = {
			pass: false,
			uncoveredAcIds: [],
			unknownCitations: [],
			citeWithoutAssertion: [],
			uncitedTouchedTests: [],
			emptyAssertFiles: [],
			staleOracleCitations: [],
			rows: [],
			errors: [{ code: error.code, message: error.message }],
		};
	}
	const coverageArtifact = runtime.artifactStore.writeJson('ac-coverage', coverage);
	const next = runtime.transition(snapshot, {
		to: 'REVIEWING_QA',
		eventType: 'AC_COVERAGE_PASSED',
		causalId: `ac-coverage-pass-${snapshot.runtimeRevision}`,
		updates: {
			preflightBindingArtifact,
		},
		payload: {
			worktreePath: worktreeDir,
			baseCommitSha: auth.baseCommitSha,
			targetTreeSha: snapshot.targetTreeSha,
			preflightBindingArtifact,
			verificationEvidenceHash,
			canonical: true,
			status: 'OK',
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
	});

	if (verifierResult.status === 'FAIL') {
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
			causalId: `verifier-fail-${snapshot.runtimeRevision}`,
			failurePacket: verifierResult.failurePacket,
			failurePacketArtifact: verifierResult.outputArtifact,
		});
	}

	const bindingArtifact = runtime.artifactStore.writeJson(
		'preflight-binding',
		verifierResult.binding,
	);
	return applyAcCoverageGate(runtime, snapshot, auth, worktreeDir, {
		preflightBindingArtifact: bindingArtifact,
		verificationEvidenceHash:
			verifierResult.binding.preflightResultHash || sha256(verifierResult.binding),
	});
}
