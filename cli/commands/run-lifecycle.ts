import path from 'node:path';
import { RepositoryModelGovernor } from '../../adapters/model-governor.ts';
import { listContainedRunIds, resolveExportPath } from '../../persistence/run-paths.ts';
import { RUNTIME_SCHEMA_VERSION } from '../../policy/contracts.ts';
import { SdlcError, asSdlcError } from '../../policy/errors.ts';
import { type ParsedArguments, requiredValue } from '../arguments.ts';
import { validatePendingResponse } from '../hitl.ts';
import {
	type OpenContextOptions,
	openContext,
	readBoundedFile,
	readStdin,
} from '../run-context.ts';
import type { CliStreams } from '../shell-driver.ts';

export async function statusRun(
	parsed: ParsedArguments,
	{
		rootDir,
		governor: injectedGovernor,
		onBoundary,
		gitCli,
		execCli,
		localPolicyPath = null,
	}: {
		rootDir: string;
		governor?: OpenContextOptions['governor'];
		onBoundary?: OpenContextOptions['onBoundary'];
		gitCli?: OpenContextOptions['gitCli'];
		execCli?: OpenContextOptions['execCli'];
		localPolicyPath?: string | null;
	},
): Promise<Record<string, unknown>> {
	const runId = requiredValue(parsed, '--run');
	const context = openContext({
		rootDir,
		runId,
		governor: injectedGovernor ?? new RepositoryModelGovernor({ rootDir, localPolicyPath }),
		onBoundary,
		gitCli,
		execCli,
		localPolicyPath,
	});
	try {
		await context.projection.reconcile();
		const result = context.projection.readStatusResult();
		return { ...result, state: result.state };
	} finally {
		context.store.close();
	}
}

export async function approveRun(
	parsed: ParsedArguments,
	{
		rootDir,
		governor: injectedGovernor,
		onBoundary,
		gitCli,
		execCli,
	}: {
		rootDir: string;
		governor?: OpenContextOptions['governor'];
		onBoundary?: OpenContextOptions['onBoundary'];
		gitCli?: OpenContextOptions['gitCli'];
		execCli?: OpenContextOptions['execCli'];
	},
): Promise<Record<string, unknown>> {
	const runId = requiredValue(parsed, '--run');
	const specHash = requiredValue(parsed, '--spec-hash');
	const context = openContext({
		rootDir,
		runId,
		governor: injectedGovernor ?? new RepositoryModelGovernor({ rootDir }),
		onBoundary,
		gitCli,
		execCli,
	});
	try {
		await context.projection.reconcile();
		const state = context.store.getRun(runId);
		if (state.state !== 'WAITING_FOR_APPROVAL') {
			throw new SdlcError(
				'INVALID_INPUT',
				`Cannot approve run in state '${state.state}' (must be WAITING_FOR_APPROVAL)`,
			);
		}
		const pending = context.store.getPendingInterrupt(runId);
		if (!pending || pending.kind !== 'approval') {
			throw new SdlcError(
				'INVALID_INPUT',
				`Run '${runId}' has no pending approval interrupt`,
			);
		}
		const request = context.artifacts.readJson(pending.requestArtifact) as {
			draftHash?: string;
			approval?: { approvalHash?: string };
		};
		if (specHash !== state.draftHash || specHash !== request.draftHash) {
			throw new SdlcError(
				'STALE_RESPONSE',
				`Spec hash mismatch: provided '${specHash}' does not match current draft '${state.draftHash}'`,
				{ expectedHash: state.draftHash, actualHash: specHash },
			);
		}
		const responseObj = {
			schemaVersion: RUNTIME_SCHEMA_VERSION,
			interruptId: pending.interruptId,
			stateHash: pending.stateHash,
			action: 'approve',
			approvalHash: request.approval?.approvalHash,
			draftHash: state.draftHash,
		};
		const responseArtifact = context.artifacts.writeJson('human-response', responseObj);
		context.store.recordInterruptResponse(pending.interruptId, responseArtifact);
		const nextState = await context.runtime.invokeStoredResponse(state);
		await context.projection.reconcile();
		return { ...context.projection.readStatusResult(), state: nextState.state };
	} finally {
		context.store.close();
	}
}

export function listRuns({ rootDir }: { rootDir: string }): Record<string, unknown> {
	const runs: Array<Record<string, unknown>> = [];
	for (const runId of listContainedRunIds(rootDir)) {
		try {
			const context = openContext({ rootDir, runId, governor: null });
			try {
				const state = context.store.getRun(runId);
				runs.push({
					runId,
					state: state.state,
					runtimeRevision: state.runtimeRevision,
					updatedAt: state.updatedAt,
				});
			} finally {
				context.store.close();
			}
		} catch (error: unknown) {
			runs.push({ runId, state: 'FAILED', error: asSdlcError(error).toJSON() });
		}
	}
	return { schemaVersion: RUNTIME_SCHEMA_VERSION, state: null, runs };
}

export async function answerRun(
	parsed: ParsedArguments,
	{
		rootDir,
		streams,
		governor: injectedGovernor,
		continueAfterAnswerRecord,
		onBoundary,
		gitCli,
		execCli,
		ghCli,
	}: {
		rootDir: string;
		streams: CliStreams;
		governor?: OpenContextOptions['governor'];
		continueAfterAnswerRecord?: boolean;
		onBoundary?: OpenContextOptions['onBoundary'];
		gitCli?: OpenContextOptions['gitCli'];
		execCli?: OpenContextOptions['execCli'];
		ghCli?: OpenContextOptions['ghCli'];
	},
): Promise<Record<string, unknown>> {
	const runId = requiredValue(parsed, '--run');
	const interruptId = requiredValue(parsed, '--interrupt');
	const hasFile = parsed.values.has('--response-file');
	const hasStdin = parsed.booleans.has('--stdin');
	if (hasFile === hasStdin) {
		throw new SdlcError(
			'INVALID_INPUT',
			'answer requires exactly one of --response-file or --stdin',
		);
	}
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
		const loaded = context.registry.load();
		const rawStdin: unknown = streams.stdin;
		const raw = hasFile
			? readBoundedFile(
					path.resolve(rootDir, parsed.values.get('--response-file') ?? ''),
					loaded.workflow.limits.maxAnswerBytes,
				)
			: await readStdin(
					rawStdin as AsyncIterable<string | Buffer>,
					loaded.workflow.limits.maxAnswerBytes,
				);
		let response: unknown;
		try {
			response = JSON.parse(raw);
		} catch (error: unknown) {
			throw new SdlcError('INVALID_INPUT', 'Answer document is not valid JSON', {}, { cause: error });
		}
		let state = context.store.getRun(runId);
		state = await context.runtime.synchronizeCheckpoint(state);
		const pending = context.store.getPendingInterrupt(runId);
		if (
			!pending ||
			pending.interruptId !== interruptId ||
			state.pendingInterruptId !== interruptId
		) {
			throw new SdlcError('STALE_RESPONSE', 'Interrupt is not current for this run');
		}
		const request = context.artifacts.readJson(pending.requestArtifact);
		const draft = context.artifacts.readJson(state.draftArtifact);
		const validated = validatePendingResponse({
			state,
			interrupt: pending,
			request,
			response,
			draft,
		});
		const responseArtifact = context.artifacts.writeJson('human-response', validated.response);
		context.store.recordInterruptResponse(interruptId, responseArtifact);
		await (onBoundary?.('answer-response-recorded', {
			runId,
			runtimeRevision: state.runtimeRevision,
			interruptId,
		}) ?? Promise.resolve());
		if (!continueAfterAnswerRecord) {
			return {
				...context.projection.readStatusResult(),
				state: state.state,
				responseRecorded: true,
			};
		}
		const next = await context.runtime.resume(state, validated.response);
		await context.projection.reconcile();
		return { ...context.projection.readStatusResult(), state: next.state };
	} finally {
		context.store.close();
	}
}

export async function cancelRun(
	parsed: ParsedArguments,
	{
		rootDir,
		governor: injectedGovernor,
		onBoundary,
		gitCli,
		execCli,
	}: {
		rootDir: string;
		governor?: OpenContextOptions['governor'];
		onBoundary?: OpenContextOptions['onBoundary'];
		gitCli?: OpenContextOptions['gitCli'];
		execCli?: OpenContextOptions['execCli'];
	},
): Promise<Record<string, unknown>> {
	const runId = requiredValue(parsed, '--run');
	const context = openContext({
		rootDir,
		runId,
		governor: injectedGovernor ?? new RepositoryModelGovernor({ rootDir }),
		onBoundary,
		gitCli,
		execCli,
	});
	try {
		await context.projection.reconcile();
		const state = context.store.getRun(runId);
		if (state.state === 'CANCELLED') {
			return { ...context.projection.readStatusResult(), state: state.state };
		}
		if (['SPEC_REJECTED', 'READY_FOR_GIT_APPROVAL', 'DONE', 'FAILED'].includes(state.state)) {
			throw new SdlcError('INVALID_TRANSITION', `Cannot cancel terminal state ${state.state}`);
		}
		const next = context.runtime.transition(state, {
			to: 'CANCELLED',
			eventType: 'RUN_CANCELLED',
			causalId: `cancel-${state.runtimeRevision}`,
			updates: {
				pendingInterruptId: null,
				blockedReason: 'RUN_CANCELLED',
			},
			payload: { reason: 'RUN_CANCELLED' },
			effects: state.pendingInterruptId
				? { cancelInterruptId: state.pendingInterruptId }
				: undefined,
		});
		await (onBoundary?.('cancel-transition-recorded', {
			runId,
			runtimeRevision: next.runtimeRevision,
		}) ?? Promise.resolve());
		await context.projection.reconcile();
		return { ...context.projection.readStatusResult(), state: next.state };
	} finally {
		context.store.close();
	}
}

export async function exportRun(
	parsed: ParsedArguments,
	{
		rootDir,
		governor: injectedGovernor,
		onBoundary,
		gitCli,
		execCli,
	}: {
		rootDir: string;
		governor?: OpenContextOptions['governor'];
		onBoundary?: OpenContextOptions['onBoundary'];
		gitCli?: OpenContextOptions['gitCli'];
		execCli?: OpenContextOptions['execCli'];
	},
): Promise<Record<string, unknown>> {
	const runId = requiredValue(parsed, '--run');
	const context = openContext({
		rootDir,
		runId,
		governor: injectedGovernor ?? new RepositoryModelGovernor({ rootDir }),
		onBoundary,
		gitCli,
		execCli,
	});
	try {
		await context.projection.reconcile();
		const loaded = context.registry.load();
		const destination = resolveExportPath(parsed.values.get('--dest'), runId, rootDir);
		const exported = context.projection.exportSnapshot(destination, {
			overwrite: parsed.booleans.has('--overwrite'),
			maxBytes: loaded.workflow.limits.maxExportBytes,
		});
		return { ...exported, state: context.store.getRun(runId).state };
	} finally {
		context.store.close();
	}
}
