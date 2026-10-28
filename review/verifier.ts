import { execFileSync } from 'node:child_process';
import type { HostProfile, HostVerifyConfig } from '../host/host-profile.ts';
import { runHostVerify } from '../host/verify-runner.ts';
import {
	sha256,
	validatePreflightBinding,
	validateRunId,
	type FailurePacketRecord,
	type PreflightBindingRecord,
} from '../policy/contracts.ts';
import {
	buildFailurePacket,
	failureReferencesAuthorizedPackage,
	isEnvironmentFailure,
} from './failure-packet.ts';

export interface VerifierArtifactStoreLike {
	writeJson(prefix: string, payload: unknown): string;
}

export type VerifierExecCliFn = (
	command: string,
	args: readonly string[],
	options: {
		cwd: string;
		encoding: 'utf8';
		stdio: ['ignore', 'pipe', 'pipe'];
		env?: NodeJS.ProcessEnv;
	},
) => unknown;

export interface PreflightFailResult {
	status: 'FAIL';
	exitCode: number;
	failurePacket: Readonly<FailurePacketRecord>;
	outputArtifact: string | null;
	repairable?: boolean;
}

export interface PreflightPassResult {
	status: 'PASS';
	binding: Readonly<PreflightBindingRecord>;
	preflightResult: Record<string, unknown>;
	preflightResultHash: string;
	commitSha?: string;
	treeSha?: string | null;
}

export type PreflightVerifierResult = PreflightFailResult | PreflightPassResult;

export function verifyPreflightEvidence({
	baseCommitSha,
	targetTreeSha,
	command,
	preflightResultHash,
	status,
	canonical,
}: {
	baseCommitSha: unknown;
	targetTreeSha: unknown;
	command: unknown;
	preflightResultHash: unknown;
	status: unknown;
	canonical: unknown;
}): Readonly<PreflightBindingRecord> {
	return validatePreflightBinding({
		baseCommitSha,
		targetTreeSha,
		command,
		preflightResultHash,
		status,
		canonical,
	});
}

function failResult({
	artifactStore,
	failurePacket,
	exitCode,
	repairable,
}: {
	artifactStore?: VerifierArtifactStoreLike | null;
	failurePacket: Readonly<FailurePacketRecord>;
	exitCode: number;
	repairable?: boolean;
}): PreflightFailResult {
	return {
		status: 'FAIL',
		exitCode,
		failurePacket,
		outputArtifact: artifactStore ? artifactStore.writeJson('failure-packet', failurePacket) : null,
		...(repairable !== undefined ? { repairable } : {}),
	};
}

/**
 * Runs the host verify command via `runHostVerify`, validates status, canonical,
 * base, and `headField`, and binds the evidence. Shared by the worktree and
 * committed-tree verifiers; `expectedHeadSha` and `headLabel` only differ in the
 * head mismatch message.
 */
async function runPreflightAndBind({
	runId,
	generation,
	worktreeDir,
	rootDir,
	profile,
	verify,
	baseCommitSha,
	bindingTreeSha,
	expectedHeadSha,
	headLabel,
	targetPaths,
	artifactStore,
	execCli,
}: {
	runId: string;
	generation: number;
	worktreeDir: string;
	rootDir?: string;
	profile?: HostProfile;
	verify?: HostVerifyConfig;
	baseCommitSha: string;
	bindingTreeSha: string;
	expectedHeadSha: string;
	headLabel: string;
	targetPaths: readonly string[];
	artifactStore?: VerifierArtifactStoreLike | null;
	execCli: VerifierExecCliFn;
}): Promise<PreflightVerifierResult> {
	const outcome = await runHostVerify({
		worktreeDir,
		rootDir,
		profile,
		verify,
		baseSha: baseCommitSha,
		expectedBase: baseCommitSha,
		expectedHead: expectedHeadSha,
		headLabel,
		execCli,
	});

	if (!outcome.ok) {
		const failurePacket = buildFailurePacket({
			runId,
			generation,
			failedCommand: outcome.command,
			exitCode: outcome.exitCode,
			output: outcome.output,
			targetPaths,
			baseCommitSha,
		});
		if (outcome.processFailed) {
			return failResult({
				artifactStore,
				failurePacket,
				exitCode: outcome.exitCode,
				repairable:
					!isEnvironmentFailure(failurePacket.sanitizedOutput) &&
					failureReferencesAuthorizedPackage({
						output: failurePacket.sanitizedOutput,
						targetPaths,
					}),
			});
		}
		return failResult({
			artifactStore,
			failurePacket,
			exitCode: outcome.exitCode,
		});
	}

	const preflightResult = outcome.preflightResult;
	const preflightResultHash = artifactStore
		? artifactStore.writeJson('preflight-result', preflightResult)
		: sha256(preflightResult);

	const binding = verifyPreflightEvidence({
		baseCommitSha,
		targetTreeSha: bindingTreeSha,
		command: outcome.command,
		preflightResultHash,
		status: 'OK',
		canonical: true,
	});

	return {
		status: 'PASS',
		binding,
		preflightResult,
		preflightResultHash,
	};
}

export async function executePreflightVerifier({
	runId,
	generation = 0,
	worktreeDir,
	rootDir,
	profile,
	verify,
	baseCommitSha,
	targetTreeSha,
	targetPaths = [],
	artifactStore,
	execCli = execFileSync,
}: {
	runId: string;
	generation?: number;
	worktreeDir: string;
	rootDir?: string;
	profile?: HostProfile;
	verify?: HostVerifyConfig;
	baseCommitSha: string;
	targetTreeSha: string;
	targetPaths?: readonly string[];
	artifactStore?: VerifierArtifactStoreLike | null;
	execCli?: VerifierExecCliFn;
}): Promise<PreflightVerifierResult> {
	validateRunId(runId);
	return runPreflightAndBind({
		runId,
		generation,
		worktreeDir,
		rootDir,
		profile,
		verify,
		baseCommitSha,
		bindingTreeSha: targetTreeSha,
		expectedHeadSha: baseCommitSha,
		headLabel: 'authorized base',
		targetPaths,
		artifactStore,
		execCli,
	});
}

export async function executeCommittedPreflightVerifier({
	runId,
	generation = 0,
	worktreeDir,
	rootDir,
	profile,
	verify,
	baseCommitSha,
	commitSha,
	targetTreeSha,
	targetPaths = [],
	artifactStore,
	execCli = execFileSync,
	gitCli = execFileSync,
}: {
	runId: string;
	generation?: number;
	worktreeDir: string;
	rootDir?: string;
	profile?: HostProfile;
	verify?: HostVerifyConfig;
	baseCommitSha: string;
	commitSha?: string | null;
	targetTreeSha?: string | null;
	targetPaths?: readonly string[];
	artifactStore?: VerifierArtifactStoreLike | null;
	execCli?: VerifierExecCliFn;
	gitCli?: VerifierExecCliFn;
}): Promise<PreflightVerifierResult> {
	validateRunId(runId);
	const gitFailure = (failedCommand: string, output: string): PreflightFailResult => {
		const failurePacket = buildFailurePacket({
			runId,
			generation,
			failedCommand,
			exitCode: 1,
			output,
			targetPaths,
			baseCommitSha,
		});
		return failResult({ artifactStore, failurePacket, exitCode: 1 });
	};
	const git = (args: readonly string[]): string =>
		String(
			gitCli('git', args, {
				cwd: worktreeDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			}) ?? '',
		);

	// 1. Verify worktree is clean after commit
	let isClean = false;
	try {
		isClean = git(['status', '--porcelain']).trim().length === 0;
	} catch {
		isClean = false;
	}
	if (!isClean) {
		return gitFailure('git status --porcelain', 'Worktree is dirty after commit execution');
	}

	// 2. Resolve commitSha and treeSha from git
	let actualCommitSha = commitSha ?? '';
	let actualTreeSha: string | null = null;
	try {
		actualCommitSha = git(['rev-parse', 'HEAD']).trim();
		actualTreeSha = git(['rev-parse', 'HEAD^{tree}']).trim();
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return gitFailure('git rev-parse HEAD', `Failed to inspect git commit HEAD: ${message}`);
	}

	// 3. Verify committed tree SHA matches targetTreeSha (ensure hooks didn't modify files)
	if (targetTreeSha && actualTreeSha !== targetTreeSha) {
		return gitFailure(
			'git rev-parse HEAD^{tree}',
			`Committed tree SHA '${actualTreeSha}' does not match expected target tree SHA '${targetTreeSha}'`,
		);
	}

	// 4. Run preflight
	const result = await runPreflightAndBind({
		runId,
		generation,
		worktreeDir,
		rootDir,
		profile,
		verify,
		baseCommitSha,
		bindingTreeSha: actualTreeSha ?? targetTreeSha ?? '',
		expectedHeadSha: actualCommitSha,
		headLabel: 'committed HEAD',
		targetPaths,
		artifactStore,
		execCli,
	});
	if (result.status !== 'PASS') return result;
	return { ...result, commitSha: actualCommitSha, treeSha: actualTreeSha };
}
