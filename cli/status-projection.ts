import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { validateStatus } from '../agent-status-validate.ts';
import { loadHostProfileOrFallback } from '../host/host-profile.ts';
import { addLearningEntry, resolveLearningStorePath } from '../host/learnings.ts';
import { type ArtifactStore, assertProjectionSafe } from '../persistence/artifacts.ts';
import type { ProjectionRecord } from '../persistence/projection-records.ts';
import type { RunPaths } from '../persistence/run-paths.ts';
import type { RuntimeStore } from '../persistence/runtime-store.ts';
import type { ReconcileResult } from '../persistence/store-integrity.ts';
import {
	type RuntimeState,
	canonicalJson,
	createEvent,
	sha256,
	validateRuntimeState,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { effectiveContinuationAttempts } from '../policy/local-policy-fingerprint.ts';
import {
	type AutoDecision,
	formatDecisionsMarkdown,
	projectDecisionsFile,
} from '../policy/reversible-decisions.ts';
import type { GitCliFn } from '../workflow/git-manager.ts';
import { approvedInputHash, renderSpecification } from '../workflow/specification.ts';
import { type ContinuationInputs, computeContinuation } from './continuation.ts';
import {
	type StoredStatusDocument,
	publishChangedContinuationCard as publishContinuationCard,
} from './continuation-card.ts';
import { projectHostInvocation } from './host-invocation.ts';
import {
	atomicWrite,
	readCandidateLearnings,
	writeCandidateLearningsProjection,
} from './projection-artifacts.ts';
import {
	type GitMetadataRecord, buildStatusDocument, gitMetadata, projectionHash,
} from './status-document.ts';
import { type AssembledStatusResult, assembleStatusResult } from './status-result.ts';

export { computeContinuation, isInfrastructureContinuation } from './continuation.ts';

export interface CheckpointerLike {
	getTuple(config: { configurable: { thread_id: string } }): Promise<{
		checkpoint?: { channel_values?: { snapshot?: unknown } };
	} | null | undefined>;
}

export interface StatusProjectionOptions {
	readonly rootDir: string;
	readonly paths: RunPaths;
	readonly runtimeStore: RuntimeStore;
	readonly artifactStore: ArtifactStore;
	readonly checkpointer?: CheckpointerLike | null;
	readonly onBoundary?: ((name: string, payload: Record<string, unknown>) => Promise<void> | void) | null;
	readonly gitCli?: GitCliFn | null;
	readonly localPolicyPath?: string | null;
}

export class StatusProjection {
	readonly rootDir: string; readonly paths: RunPaths;
	readonly runtimeStore: RuntimeStore; readonly artifactStore: ArtifactStore;
	readonly checkpointer: CheckpointerLike | null;
	readonly onBoundary: (name: string, payload: Record<string, unknown>) => Promise<void> | void;
	readonly gitCli: GitCliFn; readonly localPolicyPath: string | null;

	constructor({
		rootDir, paths, runtimeStore, artifactStore,
		checkpointer = null, onBoundary, gitCli, localPolicyPath = null,
	}: StatusProjectionOptions) {
		this.rootDir = rootDir;
		this.paths = paths;
		this.runtimeStore = runtimeStore;
		this.artifactStore = artifactStore;
		this.checkpointer = checkpointer ?? null;
		this.onBoundary = onBoundary ?? (async () => {});
		this.gitCli = gitCli ?? (execFileSync as GitCliFn);
		this.localPolicyPath = localPolicyPath;
	}

	async reconcile(): Promise<AssembledStatusResult> {
		const reconciliation = this.runtimeStore.reconcile(this.paths.runId);
		const state = reconciliation.state;
		await this.verifyCanonicalReferences(reconciliation);
		const pendingMaterialized = reconciliation.pendingProjections
			.map(({ runtimeRevision }) =>
				this.runtimeStore.getProjectionRecord(this.paths.runId, runtimeRevision),
			)
			.filter(
				(record): record is ProjectionRecord & { status: Record<string, unknown>; intent: string } =>
					Boolean(record?.status && record.intent !== null),
			)
			.at(-1);
		const projectedRuntimeRevision = readProjectedRuntimeRevision(this.paths.statusPath);
		if (
			pendingMaterialized &&
			projectedRuntimeRevision !== null &&
			projectedRuntimeRevision < pendingMaterialized.runtimeRevision
		) {
			await this.publishMaterialized(pendingMaterialized);
		}
		if (fs.existsSync(this.paths.statusPath)) {
			let status: StoredStatusDocument;
			try {
				const statusText = fs.readFileSync(this.paths.statusPath, 'utf8');
				assertProjectionSafe(statusText);
				status = JSON.parse(statusText) as StoredStatusDocument;
			} catch (error: unknown) {
				if (error instanceof SdlcError) throw error;
				throw new SdlcError('PROJECTION_DRIFT', 'status.json is unreadable', {}, { cause: error });
			}
			const validation = validateStatus(status);
			if (!validation.ok) {
				throw new SdlcError(
					'PROJECTION_DRIFT',
					`status.json is invalid: ${validation.errors.join('; ')}`,
				);
			}
			if (status.orchestration) {
				if (status.orchestration.runtimeRevision > state.runtimeRevision) {
					throw new SdlcError(
						'PROJECTION_DRIFT',
						'Projection is newer than canonical runtime state',
					);
				}
				if (projectionHash(status) !== status.orchestration.projectionHash) {
					throw new SdlcError('PROJECTION_DRIFT', 'Generated status.json was modified');
				}
				const record = this.runtimeStore.getProjectionRecord(
					state.runId,
					status.orchestration.runtimeRevision,
				);
				const matchesOutbox =
					Boolean(record?.status) && canonicalJson(record?.status) === canonicalJson(status);
				const matchesContinuation =
					!matchesOutbox &&
					this.runtimeStore.findContinuationProjection(state.runId, status) !== null;
				if (!record?.status || record.intent === null || (!matchesOutbox && !matchesContinuation)) {
					throw new SdlcError(
						'PROJECTION_DRIFT',
						'Generated status.json has no matching durable projection payload',
					);
				}
				if (
					!fs.existsSync(this.paths.intentPath) ||
					fs.readFileSync(this.paths.intentPath, 'utf8') !== record.intent
				) {
					throw new SdlcError('PROJECTION_DRIFT', 'Generated intent.md was modified');
				}
			} else if (reconciliation.currentProjection?.publishedAt) {
				throw new SdlcError(
					'PROJECTION_DRIFT',
					'Generated status.json lost its orchestration envelope',
				);
			}
		} else {
			const latest = this.runtimeStore.latestDurableProjection(this.paths.runId);
			if (latest?.status && latest.intent !== null) {
				await this.publishMaterialized(latest);
			} else if (reconciliation.currentProjection?.publishedAt) {
				throw new SdlcError(
					'PROJECTION_DRIFT',
					'Published status.json is missing and cannot be regenerated',
				);
			}
		}
		const pending = this.runtimeStore.listPendingProjections(this.paths.runId);
		if (pending.some((item) => item.runtimeRevision <= state.runtimeRevision)) {
			await this.writeCurrent();
		}
		writeCandidateLearningsProjection(this.paths.runDir, this.paths.runId, this.runtimeStore);
		await this.drainLearningOutbox();
		return this.readStatusResult();
	}

	async verifyCanonicalReferences(reconciliation: ReconcileResult): Promise<void> {
		const state = reconciliation.state;
		for (const hash of reconciliation.artifactHashes) this.artifactStore.read(hash);
		const draft = this.artifactStore.readJson(state.draftArtifact);
		if (approvedInputHash(draft, state.taskManifestHash) !== state.draftHash) {
			throw new SdlcError(
				'STORE_RECONCILIATION_FAILED',
				'Draft artifact and canonical draft hash diverged',
			);
		}
		if (!this.checkpointer) {
			throw new SdlcError(
				'STORE_RECONCILIATION_FAILED',
				'LangGraph checkpointer is unavailable for reconciliation',
			);
		}
		const checkpoint = await this.checkpointer.getTuple({
			configurable: { thread_id: state.threadId },
		});
		const checkpointState = checkpoint?.checkpoint?.channel_values?.snapshot;
		if (!checkpointState) {
			throw new SdlcError(
				'STORE_RECONCILIATION_FAILED',
				'Latest LangGraph checkpoint is missing canonical state',
			);
		}
		const snapshot = validateRuntimeState(checkpointState);
		if (
			snapshot.runId !== state.runId ||
			snapshot.threadId !== state.threadId ||
			snapshot.runtimeRevision > state.runtimeRevision ||
			reconciliation.transitions[snapshot.runtimeRevision]?.stateHash !== sha256(snapshot) ||
			(snapshot.runtimeRevision === state.runtimeRevision && sha256(snapshot) !== sha256(state))
		) {
			throw new SdlcError(
				'STORE_RECONCILIATION_FAILED',
				'Latest LangGraph checkpoint diverged from canonical transitions',
			);
		}
		if (state.pendingInterruptId) {
			const pending = this.runtimeStore.getInterrupt(state.pendingInterruptId);
			if (!pending) {
				throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Pending interrupt record is missing');
			}
			const request = this.artifactStore.readJson(pending.requestArtifact) as {
				stateHash?: string;
				expectedResponse?: { interruptId?: string };
				kind?: string;
			};
			if (
				pending.runId !== state.runId ||
				request.stateHash !== pending.stateHash ||
				request.expectedResponse?.interruptId !== pending.interruptId ||
				request.kind !== pending.kind
			) {
				throw new SdlcError(
					'STORE_RECONCILIATION_FAILED',
					'Pending interrupt payload diverged from canonical state',
				);
			}
		}
		for (const pending of reconciliation.pendingProjections) {
			if (pending.runtimeRevision > state.runtimeRevision) {
				throw new SdlcError(
					'STORE_RECONCILIATION_FAILED',
					'Projection outbox references a future runtime revision',
				);
			}
		}
	}

	async writeCurrent(): Promise<Record<string, unknown>> {
		const state = this.runtimeStore.getRun(this.paths.runId);
		const draft = this.artifactStore.readJson(state.draftArtifact) as {
			assumptions?: readonly string[];
		} & Record<string, unknown>;
		const intent = `${assertProjectionSafe(renderSpecification(draft)).trimEnd()}\n`;
		const reservation = this.runtimeStore.reserveProjection(state.runId, state.runtimeRevision, {
			stateHash: sha256(state),
			updatedAt: state.updatedAt,
			git: gitMetadata(this.rootDir, state.integrationWorktreePath || state.worktreePath, this.gitCli),
			intent,
		}) as { projectionRevision: number; runtimeRevision: number; stateHash: string; updatedAt: string; git: GitMetadataRecord };
		if (reservation.stateHash !== sha256(state)) {
			throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Projection reservation targets a different canonical state');
		}
		await this.onBoundary('projection-reserved', { runId: state.runId, runtimeRevision: state.runtimeRevision });
		const auth = this.runtimeStore.getAuthorization(state.runId);
		const continuationInputs = this.continuationInputs(state);
		const taskPlan = this.runtimeStore.getTaskPlan(state.runId);
		const continuation = computeContinuation(state, continuationInputs);
		const hostInvocation = projectHostInvocation(state, continuationInputs);
		const falseEconomyDiagnostics = this.runtimeStore.listDiagnostics(state.runId, 'FALSE_ECONOMY_DETECTED').map((d) => d.payload);
		const candidateLearnings = readCandidateLearnings({
			mode: 'strict', runtimeStore: this.runtimeStore, runId: state.runId,
			legacyPath: path.join(this.paths.runtimeDir, 'candidate-learnings.json'),
		});
		const intentHash = sha256(intent);
		const projectionPayloadHash = sha256({
			runId: state.runId, runtimeRevision: state.runtimeRevision,
			projectionRevision: reservation.projectionRevision, stateHash: reservation.stateHash, intentHash,
		});
		const projectionEvent = createEvent({
			eventType: 'PROJECTION_WRITTEN', runId: state.runId, runtimeRevision: state.runtimeRevision, state,
			input: { runtimeRevision: state.runtimeRevision }, output: { projectionPayloadHash },
			causalId: `projection-${reservation.projectionRevision}`,
			payload: { intentHash, projectionPayloadHash, projectionRevision: reservation.projectionRevision },
			now: new Date(state.updatedAt),
		});
		const eventLogHash = this.runtimeStore.appendProjectionEvent(state.runId, state.runtimeRevision, projectionEvent);
		await this.onBoundary('projection-event-recorded', { runId: state.runId, runtimeRevision: state.runtimeRevision });
		const baseStatus = buildStatusDocument({
			state, reservation, auth, taskPlan, continuation, hostInvocation,
			falseEconomyDiagnostics, candidateLearnings, rootDir: this.rootDir, runDir: this.paths.runDir,
			eventLogHash, gitCommitSha: this.runtimeStore.getGitCommit(state.runId)?.commitSha ?? null,
			verify: loadHostProfileOrFallback(this.rootDir).verify,
		});
		const validation = validateStatus(baseStatus);
		if (!validation.ok) {
			throw new SdlcError('INVALID_CONTRACT', `Generated status projection is invalid: ${validation.errors.join('; ')}`);
		}
		assertProjectionSafe(JSON.stringify(baseStatus));
		const materialized = this.runtimeStore.saveProjectionPayload(state.runId, state.runtimeRevision, { status: baseStatus, intent });
		atomicWrite(this.paths.intentPath, materialized.intent);
		await this.onBoundary('projection-intent-published', { runId: state.runId, runtimeRevision: state.runtimeRevision });
		writeDecisionsProjection(this.paths.runDir, state.runId, this.runtimeStore, draft);
		writeCandidateLearningsProjection(this.paths.runDir, state.runId, this.runtimeStore);
		atomicWrite(this.paths.statusPath, `${JSON.stringify(materialized.status, null, 2)}\n`);
		await this.onBoundary('projection-status-published', { runId: state.runId, runtimeRevision: state.runtimeRevision });
		this.runtimeStore.markProjectionPublished(state.runId, state.runtimeRevision);
		await this.onBoundary('projection-outbox-published', { runId: state.runId, runtimeRevision: state.runtimeRevision });
		return materialized.status;
	}

	async publishMaterialized(record: { runId: string; runtimeRevision: number; status: Record<string, unknown>; intent: string }): Promise<void> {
		assertProjectionSafe(record.intent);
		assertProjectionSafe(JSON.stringify(record.status));
		atomicWrite(this.paths.intentPath, record.intent);
		const state = this.runtimeStore.getRun(record.runId);
		const draft = this.artifactStore.readJson(state.draftArtifact) as {
			assumptions?: readonly string[];
		};
		writeDecisionsProjection(this.paths.runDir, record.runId, this.runtimeStore, draft);
		writeCandidateLearningsProjection(this.paths.runDir, record.runId, this.runtimeStore);
		atomicWrite(this.paths.statusPath, `${JSON.stringify(record.status, null, 2)}\n`);
		this.runtimeStore.markProjectionPublished(record.runId, record.runtimeRevision);
	}

	async drainLearningOutbox(): Promise<number> {
		if (!this.runtimeStore?.listPendingLearningOutbox) return 0;
		const pending = this.runtimeStore.listPendingLearningOutbox(this.paths.runId);
		if (!pending || pending.length === 0) return 0;
		const storePath = await resolveLearningStorePath({}, this.rootDir);
		const publishedIds: string[] = [];
		for (const item of pending) {
			try {
				const parsed: unknown = JSON.parse(item.learningJson);
				await addLearningEntry(storePath, parsed, {
					upsert: true,
					rootDir: this.rootDir,
				});
				publishedIds.push(item.outboxId);
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				throw new SdlcError(
					'INVALID_CONTRACT',
					`Learning outbox entry '${item.outboxId}' could not be projected: ${message}`,
					{ outboxId: item.outboxId },
					{ cause: error },
				);
			}
		}
		if (publishedIds.length > 0) {
			this.runtimeStore.markLearningOutboxPublished(publishedIds);
		}
		return publishedIds.length;
	}

	continuationInputs(state: Readonly<RuntimeState>): ContinuationInputs {
		const pending = state?.pendingInterruptId
			? this.runtimeStore.getInterrupt(state.pendingInterruptId)
			: null;
		const request = pending
			? (this.artifactStore.readJson(pending.requestArtifact) as Record<string, unknown>)
			: null;
		return {
			authorization: this.runtimeStore.getAuthorization(state.runId),
			pendingInterrupt: pending ? { ...pending, request: request ?? {} } : null,
			continuationAttempts: state.blockedReason
				? effectiveContinuationAttempts(
						this.runtimeStore.getContinuationAttempt(state.runId, state.blockedReason),
						this.rootDir,
						this.localPolicyPath,
					)
				: 0,
		};
	}

	async publishChangedContinuationCard(): Promise<StoredStatusDocument> {
		return publishContinuationCard(this);
	}

	readStatusResult(): AssembledStatusResult {
		return assembleStatusResult(this);
	}

	exportSnapshot(
		destination: string,
		{ overwrite = false, maxBytes = 524_288 }: { overwrite?: boolean; maxBytes?: number } = {},
	) {
		const state = this.runtimeStore.getRun(this.paths.runId);
		const status = this.readStatusResult();
		const intent = fs.readFileSync(this.paths.intentPath, 'utf8');
		const events = this.runtimeStore.listEvents(state.runId).map((event) => ({
			eventId: event.eventId,
			eventType: event.eventType,
			runtimeRevision: event.runtimeRevision,
			stateHash: event.stateHash,
			inputHash: event.inputHash,
			outputHash: event.outputHash,
			timestamp: event.timestamp,
			causalId: event.causalId,
			payload: event.payload,
		}));
		const snapshot = {
			schemaVersion: '1.0.0',
			exportedAt: new Date().toISOString(),
			status,
			intent,
			events,
		};
		const content = `${JSON.stringify(snapshot, null, 2)}\n`;
		assertProjectionSafe(content);
		if (Buffer.byteLength(content, 'utf8') > maxBytes) {
			throw new SdlcError('INVALID_CONTRACT', 'Export exceeds configured size limit');
		}
		atomicWrite(destination, content, { exclusive: !overwrite });
		return Object.freeze({
			schemaVersion: '1.0.0',
			runId: state.runId,
			destination,
			hash: sha256(content),
			byteLength: Buffer.byteLength(content, 'utf8'),
		});
	}
}

function collectAutoDecisions(
	runtimeStore: RuntimeStore,
	runId: string,
	draft: { assumptions?: readonly string[] } | null | undefined,
): AutoDecision[] {
	const structured: AutoDecision[] = [];
	const seen = new Set<string>();
	for (const event of runtimeStore.listEvents(runId)) {
		const payload = event.payload as { autoDecisions?: readonly AutoDecision[] } | undefined;
		if (!Array.isArray(payload?.autoDecisions)) continue;
		for (const decision of payload.autoDecisions) {
			const key = decision.assumption ?? decision.decision ?? canonicalJson(decision);
			if (seen.has(key)) continue;
			seen.add(key);
			structured.push(decision);
		}
	}
	for (const assumption of draft?.assumptions ?? []) {
		if (seen.has(assumption)) continue;
		seen.add(assumption);
		structured.push({
			ruleId: 'spec_assumption', questionId: null, category: 'assumption',
			name: 'Specification assumption', decision: assumption, assumption,
			rationale: 'Recorded during specification interview.', matchedPrompt: '',
		});
	}
	return structured;
}

function writeDecisionsProjection(
	runDir: string, runId: string, runtimeStore: RuntimeStore,
	draft: { assumptions?: readonly string[] } | null | undefined,
): void {
	const autoDecisions = collectAutoDecisions(runtimeStore, runId, draft);
	assertProjectionSafe(formatDecisionsMarkdown({ runId, autoDecisions }));
	projectDecisionsFile({ runDir, runId, autoDecisions });
}

function readProjectedRuntimeRevision(statusPath: string): number | null {
	if (!fs.existsSync(statusPath)) return -1;
	try {
		const status = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as {
			orchestration?: { runtimeRevision?: unknown };
		};
		if (status.orchestration === undefined) return -1;
		return Number.isSafeInteger(status.orchestration?.runtimeRevision)
			? (status.orchestration.runtimeRevision as number)
			: null;
	} catch {
		return null;
	}
}
