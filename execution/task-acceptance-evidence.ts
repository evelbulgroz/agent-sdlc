import fs from 'node:fs';
import path from 'node:path';
import { formatAcCoverageFailure } from './ac-author-feedback.ts';
import { type BoundAcCoverageReport, bindAcCoverageToExecution } from './ac-coverage.ts';
import { type GitShowFn, evaluateAcCoverageFromWorktree } from './ac-worktree-coverage.ts';
import type { MinimalToolCallRecord } from './minimal-prompt.ts';
import type { CompletionValidationResult, CompletionValidatorFn } from './minimal-verification.ts';
import {
	evaluateTaskQualityGate,
	hasTaskQualityGateConfig,
} from './task-quality-gate.ts';
import { type TaskScopeTaskLike, taskAuthoredWritePaths } from './task-scope.ts';

export interface CreateAcceptanceEvidenceValidatorOptions {
	readonly acceptanceCriteria: readonly string[];
	readonly knownAcceptanceCriteria?: readonly string[];
	readonly baseCommitSha?: string | null;
	readonly gitCli?: GitShowFn | null;
	readonly worktreeDir: string;
	readonly authoredTestPaths: readonly string[];
	readonly allowedPathPrefixes: readonly string[];
	readonly acceptanceEvidenceCommand: readonly string[] | null;
}

export interface AcceptanceEvidenceResult extends CompletionValidationResult {
	readonly pass: boolean;
	readonly evidenceMissing: boolean;
	readonly coverageIncomplete?: boolean;
	readonly summary: string;
	readonly targetPaths: readonly string[];
	readonly coverage: BoundAcCoverageReport | null;
}

export function createAcceptanceEvidenceValidator({
	acceptanceCriteria,
	knownAcceptanceCriteria = acceptanceCriteria,
	baseCommitSha = null,
	gitCli = null,
	worktreeDir,
	authoredTestPaths,
	allowedPathPrefixes,
	acceptanceEvidenceCommand,
}: CreateAcceptanceEvidenceValidatorOptions): CompletionValidatorFn | null {
	// Enabling slices carry no acceptance criteria by contract
	// (contracts.ts: acceptanceCriteria must be empty for kind 'enabling').
	// AC-citation coverage has nothing to validate for them; completion is
	// still gated by the separate "declared verification must pass" check.
	if (
		!acceptanceEvidenceCommand ||
		authoredTestPaths.length === 0 ||
		acceptanceCriteria.length === 0
	) {
		return null;
	}
	return ({
		state,
	}: {
		state: { toolHistory?: readonly MinimalToolCallRecord[]; lastSubstantiveWriteStep?: number };
	}): AcceptanceEvidenceResult => {
		try {
			const evidenceEntry = [...(state.toolHistory ?? [])]
				.reverse()
				.find(
					(entry) =>
						entry.toolName === 'run_allowlisted_command' &&
						entry.parameters?.command === acceptanceEvidenceCommand[0] &&
						JSON.stringify(entry.parameters?.args ?? []) ===
							JSON.stringify(acceptanceEvidenceCommand.slice(1)) &&
						(entry.stepIndex ?? 0) > (state.lastSubstantiveWriteStep ?? -1),
				);
			if (!evidenceEntry) {
				return {
					pass: false,
					evidenceMissing: true,
					summary: `acceptance execution evidence is required: ${acceptanceEvidenceCommand.join(' ')}`,
					targetPaths: authoredTestPaths,
					coverage: null,
				};
			}
			const entryResult = evidenceEntry.result;
			if (entryResult?.error || entryResult?.exitCode !== 0) {
				return {
					pass: false,
					evidenceMissing: false,
					summary: [
						'ac-coverage failed',
						'[execution-evidence] Acceptance evidence command failed',
						entryResult?.stderr,
						entryResult?.stdout,
					]
						.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
						.join('\n'),
					targetPaths: authoredTestPaths,
					coverage: null,
				};
			}
			const staticCoverage = evaluateAcCoverageFromWorktree({
				draft: { acceptanceCriteria },
				knownAcceptanceCriteria,
				baseCommitSha,
				gitCli,
				worktreeDir,
				touchedTestFiles: authoredTestPaths,
				allowedPathPrefixes,
			});
			const coverage = bindAcCoverageToExecution(
				staticCoverage,
				entryResult?.testExecutionEvidence ??
					[entryResult?.stdout, entryResult?.stderr]
						.filter((value): value is string => typeof value === 'string')
						.join('\n'),
			);
			return {
				pass: coverage.pass,
				evidenceMissing: false,
				coverageIncomplete: !coverage.pass,
				summary: formatAcCoverageFailure(coverage),
				targetPaths: authoredTestPaths,
				coverage,
			};
		} catch (error) {
			return {
				pass: false,
				evidenceMissing: false,
				summary: `ac-coverage failed\n[execution-evidence] ${error instanceof Error ? error.message : 'Evidence evaluation failed'}`,
				targetPaths: authoredTestPaths,
				coverage: null,
			};
		}
	};
}

export interface ComposeCompletionValidatorTask extends TaskScopeTaskLike {
	readonly targetPackage?: string;
	readonly baseCommitSha?: string | null;
}

export function composeCompletionValidator({
	worktreeDir,
	task,
	gitCli,
	completionValidator,
	authoredPaths = taskAuthoredWritePaths(task),
}: {
	worktreeDir: string;
	task: ComposeCompletionValidatorTask;
	gitCli?: GitShowFn | null;
	completionValidator: CompletionValidatorFn | null;
	authoredPaths?: readonly string[];
}): CompletionValidatorFn | null {
	const hasQualityConfig = hasTaskQualityGateConfig(worktreeDir);
	if (!hasQualityConfig) return completionValidator;
	return (validatorInput) => {
		const acResult =
			typeof completionValidator === 'function' ? completionValidator(validatorInput) : null;
		if (acResult && acResult.pass === false) return acResult;
		const qualityResult = evaluateTaskQualityGate({
			worktreeDir,
			targetPackage: task.targetPackage,
			authoredPaths,
			baseCommitSha: task.baseCommitSha,
			gitCli,
		});
		if (!qualityResult.pass) return qualityResult;
		return acResult ?? { pass: true };
	};
}
