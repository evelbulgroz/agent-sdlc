import type { ModelOperationInput } from '../persistence/model-operation-records.ts';
import type { MinimalPromptInput } from './minimal-prompt.ts';
import type { CompletionValidatorFn, VerificationRuntimeStoreLike } from './minimal-verification.ts';
import type { CommandExecFn } from './tool-commands.ts';
import type { RunPreparationResult } from './verification-preparation.ts';

export interface LoadedImplementerRole {
	readonly role: {
		readonly modelProfile: string;
		readonly routingStrategy?: string;
		readonly minQualityTier?: string | number;
		readonly requestedLimits: {
			readonly maxPromptTokens: number;
			readonly maxFailovers?: number;
		};
	};
}

export interface RoleRegistryLike {
	loadRole(roleId: string): LoadedImplementerRole;
}

export interface ArtifactStoreLike {
	writeJson(kind: string, payload: Record<string, unknown>): string;
}

export interface MinimalRuntimeStoreLike extends VerificationRuntimeStoreLike {
	readonly recordModelOperation?: (record: ModelOperationInput) => unknown;
}

export interface GovernorActionOutput {
	readonly kind?: string;
	readonly toolName?: string;
	readonly parameters?: Record<string, unknown>;
	readonly summary?: string;
}

export interface GovernorExecuteResult {
	readonly output?: unknown;
	readonly route?: { readonly routeId?: string; readonly provider?: string; readonly model?: string } | null;
	readonly usageRecordIds?: readonly string[];
}

export interface GovernorLike {
	readonly synthetic?: boolean;
	readonly assertCanReserve?: (request: Record<string, unknown>) => Promise<unknown> | unknown;
	execute(request: Record<string, unknown>): Promise<GovernorExecuteResult>;
}

export interface MinimalExecutorInput extends MinimalPromptInput {
	readonly maxSourceEditIterations?: number;
	readonly verifyCheckpointEvidence?: () => Promise<void>;
	readonly runId: string;
	readonly taskId: string;
	readonly worktreeDir: string;
	readonly verificationCommands: readonly (readonly string[])[];
	readonly acceptanceEvidenceCommand?: readonly string[] | null;
	readonly prepareVerification?: () => RunPreparationResult;
	readonly prepareExploratory?: () => RunPreparationResult | null;
	readonly authoredPaths?: readonly string[];
	readonly removedPaths?: readonly string[];
	readonly authoredTestPaths?: readonly string[];
	readonly allowedWritePathPrefixes?: readonly string[];
	readonly allowedPackages?: readonly string[];
	readonly auditGate?: boolean;
}

export interface MinimalExecuteResult {
	readonly status: 'completed' | 'failed';
	readonly failureReason: string | null;
	readonly attempts: number;
	readonly lastSummary?: string;
}

export interface AuditState {
	auditedDigest: string | null;
	challenged: boolean;
}
export type AttemptOutcome =
	| { readonly done: true; readonly result: MinimalExecuteResult; readonly auditRequired?: false }
	| { readonly done: false; readonly auditRequired?: boolean; readonly feedback: string };

export type EstimatePromptTokensFn = (input: { prompt: string; structuredOutputSchema: unknown }) => { promptTokens: number };

export interface MinimalExecutorOptions {
	readonly governor: GovernorLike;
	readonly artifactStore: ArtifactStoreLike;
	readonly roleRegistry: RoleRegistryLike;
	readonly runtimeStore?: MinimalRuntimeStoreLike | null;
	readonly execCli: CommandExecFn;
	readonly clock?: () => number;
	readonly estimatePromptTokens?: EstimatePromptTokensFn;
	readonly completionValidator?: CompletionValidatorFn | null;
}
