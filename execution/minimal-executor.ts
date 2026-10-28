import crypto from 'node:crypto';
import { estimatePromptTokens as estimatePromptTokensDefault } from '@evelbulgroz/model-usage-govenor/tokenizer';
import type { ModelOperationInput } from '../persistence/model-operation-records.ts';
import { SdlcError } from '../policy/errors.ts';
import {
	type MinimalPromptInput,
	type MinimalToolCallRecord,
	promptBlocks as renderPromptBlocks,
} from './minimal-prompt.ts';
import {
	type CompletionValidatorFn,
	type VerificationRuntimeStoreLike,
	WRITE_TOOLS,
	buildAuditRequiredFeedback,
	checkMissingAuthoredFiles,
	computeWorktreeDigest,
	evaluateEvidence,
	runVerification,
} from './minimal-verification.ts';
import type { CommandExecFn } from './tool-commands.ts';
import { executeTool, minimalActionSchema } from './tools.ts';

export { minimalActionSchema };
export const MINIMAL_TOOL_CALL_CAP = 150;
export const MINIMAL_ATTEMPT_WALL_MS = 60 * 60 * 1000;
export const MINIMAL_MAX_ATTEMPTS = 3;

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
	readonly runId: string;
	readonly taskId: string;
	readonly worktreeDir: string;
	readonly verificationCommands: readonly (readonly string[])[];
	readonly acceptanceEvidenceCommand?: readonly string[] | null;
	readonly authoredPaths?: readonly string[];
	readonly authoredTestPaths?: readonly string[];
	readonly allowedWritePathPrefixes?: readonly string[];
	readonly allowedPackages?: readonly string[];
	readonly auditGate?: boolean;
}

export interface MinimalExecuteResult {
	readonly status: 'completed' | 'failed';
	readonly failureReason: string | null;
	readonly attempts: number;
}

interface AuditState {
	auditedDigest: string | null;
	challenged: boolean;
	qualityRetries?: number;
}

type AttemptOutcome =
	| { readonly done: true; readonly result: MinimalExecuteResult; readonly auditRequired?: false }
	| { readonly done: false; readonly auditRequired?: boolean; readonly feedback: string };

export interface MinimalExecutorOptions {
	readonly governor: GovernorLike;
	readonly artifactStore: ArtifactStoreLike;
	readonly roleRegistry: RoleRegistryLike;
	readonly runtimeStore?: MinimalRuntimeStoreLike | null;
	readonly execCli: CommandExecFn;
	readonly clock?: () => number;
	readonly estimatePromptTokens?: (input: {
		prompt: string;
		structuredOutputSchema: unknown;
	}) => { promptTokens: number };
	readonly completionValidator?: CompletionValidatorFn | null;
}

/**
 * Governed working-set implementer loop with post-hoc validation and optional
 * two-call AUDIT_REQUIRED completion gate. Model operations route exclusively
 * through the injected governor.
 */
export class MinimalExecutor {
	readonly governor: GovernorLike;
	readonly artifactStore: ArtifactStoreLike;
	readonly roleRegistry: RoleRegistryLike;
	readonly runtimeStore: MinimalRuntimeStoreLike | null;
	readonly execCli: CommandExecFn;
	readonly clock: () => number;
	readonly estimatePromptTokens: (input: {
		prompt: string;
		structuredOutputSchema: unknown;
	}) => { promptTokens: number };
	readonly completionValidator: CompletionValidatorFn | null;

	constructor({
		governor,
		artifactStore,
		roleRegistry,
		runtimeStore = null,
		execCli,
		clock = () => Date.now(),
		estimatePromptTokens = estimatePromptTokensDefault,
		completionValidator = null,
	}: MinimalExecutorOptions) {
		this.governor = governor;
		this.artifactStore = artifactStore;
		this.roleRegistry = roleRegistry;
		this.runtimeStore = runtimeStore;
		this.execCli = execCli;
		this.clock = clock;
		this.estimatePromptTokens = estimatePromptTokens;
		this.completionValidator = completionValidator;
	}

	async execute(input: MinimalExecutorInput): Promise<MinimalExecuteResult> {
		if (!Array.isArray(input.verificationCommands) || input.verificationCommands.length === 0) {
			await this.writeTranscript(input, {
				attempt: 1,
				prompt: '',
				toolCalls: [],
				failureReason: 'verification-missing',
				passed: false,
				started: this.clock(),
			});
			return { status: 'failed', failureReason: 'verification-missing', attempts: 1 };
		}
		let feedback = '';
		const toolCalls: MinimalToolCallRecord[] = [];
		const auditState: AuditState = { auditedDigest: null, challenged: false };
		for (let attempt = 1; attempt <= MINIMAL_MAX_ATTEMPTS; attempt += 1) {
			const outcome = await this.runAttempt(input, attempt, feedback, toolCalls, auditState);
			if (outcome.done) return outcome.result;
			feedback = outcome.feedback;
		}
		return { status: 'failed', failureReason: 'verification-failed', attempts: MINIMAL_MAX_ATTEMPTS };
	}

	async runAttempt(
		input: MinimalExecutorInput,
		attempt: number,
		initialFeedback: string,
		toolCalls: MinimalToolCallRecord[] = [],
		auditState: AuditState = { auditedDigest: null, challenged: false },
	): Promise<AttemptOutcome> {
		const started = this.clock();
		const schema = minimalActionSchema();
		let feedback = initialFeedback;
		let attemptToolCalls = 0;
		while (true) {
			if (this.clock() - started >= MINIMAL_ATTEMPT_WALL_MS) {
				const prompt = this.buildPrompt(input, feedback, toolCalls);
				await this.writeTranscript(input, { attempt, prompt, toolCalls, failureReason: 'wall-time', passed: false, started });
				return { done: true, result: { status: 'failed', failureReason: 'wall-time', attempts: attempt } };
			}
			const blocks = this.promptBlocks(input, feedback, toolCalls);
			const prompt = blocks.join('\n');
			const loaded = this.roleRegistry.loadRole('implementer');
			const estimate = this.estimatePromptTokens({ prompt, structuredOutputSchema: schema });
			if (estimate.promptTokens > loaded.role.requestedLimits.maxPromptTokens) {
				await this.writeTranscript(input, { attempt, prompt, toolCalls, failureReason: 'maxPromptTokens', passed: false, started });
				return { done: true, result: { status: 'failed', failureReason: 'maxPromptTokens', attempts: attempt } };
			}
			const request = this.buildRequest(input, loaded, prompt, blocks, schema, attempt, toolCalls.length, feedback);
			let result: GovernorExecuteResult;
			try {
				if (typeof this.governor?.assertCanReserve === 'function') {
					await this.governor.assertCanReserve(request);
				}
				result = await this.governor.execute(request);
			} catch (error) {
				const errCode =
					error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
						? error.code
						: 'governor';
				await this.writeTranscript(input, { attempt, prompt, toolCalls, failureReason: errCode, passed: false, started });
				this.recordOperation(request, 'failed', error, null);
				return { done: true, result: { status: 'failed', failureReason: errCode, attempts: attempt } };
			}
			this.recordOperation(request, 'succeeded', null, result);
			const outObj =
				result?.output && typeof result.output === 'object'
					? (result.output as { action?: unknown })
					: null;
			const action = (outObj?.action ?? null) as GovernorActionOutput | null;
			if (action?.kind === 'complete') {
				const finished = await this.finishAttempt(input, { attempt, prompt, toolCalls, started, feedback, auditState });
				if (!finished.done && finished.auditRequired) {
					feedback = finished.feedback;
					continue;
				}
				return finished;
			}
			if (action?.kind === 'tool_call') {
				const toolName = action.toolName ?? '';
				const dispatched = await this.dispatchTool({ toolName, parameters: action.parameters }, input);
				if (dispatched.terminal) {
					await this.writeTranscript(input, { attempt, prompt, toolCalls, failureReason: dispatched.reason, passed: false, started });
					return { done: true, result: { status: 'failed', failureReason: dispatched.reason, attempts: attempt } };
				}
				if (WRITE_TOOLS.has(toolName) && !dispatched.result?.error && !dispatched.result?.code) {
					auditState.auditedDigest = null;
					if (/^quality-gate failed|^AUDIT_REQUIRED/.test(feedback)) {
						feedback = 'Previous check reported an issue, and a file has since been modified. Once your edits and test runs pass, emit {"kind":"complete","summary":"..."} to re-verify.';
					}
				}
				toolCalls.push({ toolName, parameters: action.parameters ?? {}, result: dispatched.result ?? null });
				attemptToolCalls += 1;
				if (attemptToolCalls >= MINIMAL_TOOL_CALL_CAP) {
					await this.writeTranscript(input, { attempt, prompt, toolCalls, failureReason: 'tool-calls', passed: false, started });
					return { done: true, result: { status: 'failed', failureReason: 'tool-calls', attempts: attempt } };
				}
				continue;
			}
			await this.writeTranscript(input, { attempt, prompt, toolCalls, failureReason: 'model-output', passed: false, started });
			return { done: true, result: { status: 'failed', failureReason: 'model-output', attempts: attempt } };
		}
	}

	async finishAttempt(
		input: MinimalExecutorInput,
		{
			attempt,
			prompt,
			toolCalls,
			started,
			auditState,
		}: {
			attempt: number;
			prompt: string;
			toolCalls: MinimalToolCallRecord[];
			started: number;
			feedback?: string;
			auditState?: AuditState | null;
		},
	): Promise<AttemptOutcome> {
		const scopePaths = input.authoredPaths ?? input.allowedWritePathPrefixes ?? [];
		if (input.auditGate === true && auditState?.auditedDigest) {
			const currentDigest = computeWorktreeDigest(input.worktreeDir, scopePaths);
			if (currentDigest === auditState.auditedDigest) {
				await this.writeTranscript(input, { attempt, prompt, toolCalls: [...toolCalls], failureReason: null, passed: true, started });
				return { done: true, result: { status: 'completed', failureReason: null, attempts: attempt } };
			}
		}
		const missing =
			input.auditGate === true
				? checkMissingAuthoredFiles(input.worktreeDir, input.authoredPaths, input.authoredTestPaths)
				: null;
		if (missing && auditState && (auditState.qualityRetries = (auditState.qualityRetries ?? 0) + 1) <= 4) {
			return { done: false, auditRequired: true, feedback: missing };
		}
		const verification = runVerification({ execCli: this.execCli, runtimeStore: this.runtimeStore, clock: this.clock, input, attempt });
		const recorded: MinimalToolCallRecord[] = [...toolCalls];
		if (verification.output) {
			const command = input.verificationCommands[0] ?? [];
			recorded.push({
				toolName: 'run_allowlisted_command',
				parameters: { command: command[0], args: command.slice(1) },
				result: { exitCode: verification.exitCode ?? 1, stdout: verification.output, stderr: '' },
			});
		}
		if (!verification.ok) {
			if (auditState) auditState.auditedDigest = null;
			const reason = verification.reason;
			await this.writeTranscript(input, { attempt, prompt, toolCalls: recorded, failureReason: reason, passed: false, started });
			if (verification.terminal || attempt >= MINIMAL_MAX_ATTEMPTS) {
				return { done: true, result: { status: 'failed', failureReason: reason, attempts: attempt } };
			}
			return { done: false, feedback: verification.output };
		}
		const evidence = evaluateEvidence(input, toolCalls, verification, this.completionValidator);
		if (evidence && evidence.pass === false) {
			if (auditState) auditState.auditedDigest = null;
			const feedback = evidence.summary || verification.output;
			if ((evidence.auditRequired || input.auditGate === true) && auditState && (auditState.qualityRetries = (auditState.qualityRetries ?? 0) + 1) <= 4) {
				return { done: false, auditRequired: true, feedback };
			}
			await this.writeTranscript(input, { attempt, prompt, toolCalls: recorded, failureReason: 'evidence-failed', passed: false, started });
			if (attempt >= MINIMAL_MAX_ATTEMPTS) {
				return { done: true, result: { status: 'failed', failureReason: 'evidence-failed', attempts: attempt } };
			}
			return { done: false, feedback };
		}
		if (input.auditGate === true && auditState && !auditState.challenged) {
			const candidateDigest = computeWorktreeDigest(input.worktreeDir, scopePaths);
			auditState.auditedDigest = candidateDigest;
			auditState.challenged = true;
			return { done: false, auditRequired: true, feedback: buildAuditRequiredFeedback(candidateDigest) };
		}
		await this.writeTranscript(input, { attempt, prompt, toolCalls: recorded, failureReason: null, passed: true, started });
		return { done: true, result: { status: 'completed', failureReason: null, attempts: attempt } };
	}

	promptBlocks(input: MinimalExecutorInput, feedback: string, toolCalls: readonly MinimalToolCallRecord[]): string[] {
		return renderPromptBlocks(input, feedback, toolCalls);
	}

	buildPrompt(input: MinimalExecutorInput, feedback: string, toolCalls: readonly MinimalToolCallRecord[]): string {
		return this.promptBlocks(input, feedback, toolCalls).join('\n');
	}

	buildRequest(
		input: MinimalExecutorInput,
		loaded: LoadedImplementerRole,
		prompt: string,
		blocks: readonly string[],
		schema: Record<string, unknown>,
		attempt: number,
		step: number,
		feedback: string,
	) {
		const role = loaded.role;
		const cacheTail = Boolean(feedback) && blocks.length > 1;
		const preferredRouteIds = (process.env.AGENT_SDLC_PREFERRED_ROUTES ?? '').split(',').map((routeId) => routeId.trim()).filter(Boolean);
		const failoverCap = Number.parseInt(process.env.AGENT_SDLC_MAX_ROUTE_FAILOVERS ?? '', 10);
		const requestedLimits =
			Number.isSafeInteger(failoverCap) && failoverCap >= 0
				? { ...role.requestedLimits, maxFailovers: Math.min(role.requestedLimits.maxFailovers ?? failoverCap, failoverCap) }
				: role.requestedLimits;
		return {
			schemaVersion: '1.0.0',
			operationId: `minimal:${input.taskId}:${attempt}:${step}:${crypto.randomUUID()}`,
			runId: input.runId,
			consumer: 'agent-sdlc',
			profile: role.modelProfile,
			attribution: {
				taskId: input.taskId,
				nodeId: 'minimal-executor',
				roleId: 'implementer',
				generation: 0,
				nodeAttempt: attempt,
				phase: 'implementation',
			},
			prompt,
			...(blocks.length > 1 ? { promptBlocks: blocks } : {}),
			...(cacheTail ? { promptCacheBreakpoint: blocks.length - 2 } : {}),
			structuredOutputSchema: schema,
			routingConstraints: {
				requiredCapabilities: ['structured-output'],
				strategy: role.routingStrategy ?? 'balanced',
				...(role.minQualityTier != null ? { minQualityTier: role.minQualityTier } : {}),
				...(preferredRouteIds.length > 0 ? { preferredRouteIds } : {}),
			},
			requestedLimits,
		};
	}

	async dispatchTool(
		action: { toolName: string; parameters?: Record<string, unknown> },
		input: MinimalExecutorInput,
	): Promise<{ terminal: true; reason: string; result?: undefined } | { terminal?: false; result: Record<string, unknown> | null }> {
		try {
			const result = executeTool({
				toolName: action.toolName,
				parameters: action.parameters ?? {},
				worktreeDir: input.worktreeDir,
				allowedPathPrefixes: input.allowedWritePathPrefixes ?? [],
				allowedPackages: input.allowedPackages ?? [],
				pageOverflow: true,
				execCli: this.execCli,
			});
			return { result };
		} catch (error) {
			const errObj = error as { message?: string; code?: string; metadata?: { candidatePath?: unknown; candidates?: unknown } };
			if (String(errObj?.message ?? '').startsWith('page-write-failed')) {
				return { terminal: true, reason: 'page-write-failed' };
			}
			const metadata = errObj?.metadata ?? {};
			return {
				result: {
					error: errObj?.message ?? String(error),
					code: errObj?.code ?? 'INVALID_INPUT',
					...(typeof metadata.candidatePath === 'string' ? { candidatePath: metadata.candidatePath } : {}),
					...(Array.isArray(metadata.candidates) ? { candidates: metadata.candidates } : {}),
				},
			};
		}
	}

	recordOperation(
		request: { operationId: string; runId: string; attribution: { taskId: string } },
		status: 'succeeded' | 'failed',
		error: unknown,
		result: GovernorExecuteResult | null,
	): void {
		const record = this.runtimeStore?.recordModelOperation;
		if (typeof record !== 'function') return;
		let outputArtifact: string | null = null;
		if (status === 'succeeded') {
			if (typeof this.artifactStore?.writeJson !== 'function') {
				throw new SdlcError('INVALID_INPUT', 'Minimal executor requires an artifact store');
			}
			outputArtifact = this.artifactStore.writeJson('model-proposal', {
				kind: 'model-proposal',
				operationId: request.operationId,
				output: result?.output ?? null,
			});
		}
		const errCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
		record.call(this.runtimeStore, {
			operationId: request.operationId,
			runId: request.runId,
			synthetic: this.governor?.synthetic === true,
			status,
			outputArtifact,
			errorCode: errCode,
			taskId: request.attribution.taskId,
			roleId: 'implementer',
			routeId: result?.route?.routeId ?? null,
			provider: result?.route?.provider ?? null,
			modelId: result?.route?.model ?? null,
			usageRecordIds: result?.usageRecordIds ?? [],
		});
	}

	async writeTranscript(
		input: MinimalExecutorInput,
		{ attempt, prompt, toolCalls, failureReason, passed, started }: {
			attempt: number;
			prompt: string;
			toolCalls: readonly MinimalToolCallRecord[];
			failureReason: string | null;
			passed: boolean;
			started: number;
		},
	): Promise<void> {
		if (typeof this.artifactStore?.writeJson !== 'function') {
			throw new SdlcError('INVALID_INPUT', 'Minimal executor requires an artifact store');
		}
		await this.artifactStore.writeJson('minimal-executor-attempt', {
			kind: 'minimal-executor-attempt',
			taskId: input.taskId,
			attempt,
			prompt,
			toolCalls,
			failureReason: failureReason ?? null,
			passed: passed === true,
			wallMs: this.clock() - started,
		});
	}
}
