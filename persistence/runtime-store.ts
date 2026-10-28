import crypto from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
	type RuntimeState,
	assertTransition,
	sha256,
	validateEvent,
	validateRuntimeState,
} from '../policy/contracts.ts';
import { SdlcError, asSdlcError } from '../policy/errors.ts';
import { type CheckpointRecords, createCheckpointRecords } from './checkpoint-records.ts';
import { type DeliveryRecords, createDeliveryRecords } from './delivery-records.ts';
import { type FrictionRecords, createFrictionRecords } from './friction-records.ts';
import { type GenerationRecords, createGenerationRecords } from './generation-records.ts';
import { type InterruptInput, type InterruptRecords, createInterruptRecords } from './interrupt-records.ts';
import { type CandidateLearningInput, type LearningRecords, createLearningRecords } from './learning-records.ts';
import {
	type ModelOperationInput,
	type ModelOperationRecords,
	createModelOperationRecords,
} from './model-operation-records.ts';
import { type ProjectionRecords, createProjectionRecords } from './projection-records.ts';
import { type ReviewRecords, createReviewRecords } from './review-records.ts';
import { type RunLedger, createRunLedger } from './run-ledger.ts';
import { type StoreIntegrity, createStoreIntegrity } from './store-integrity.ts';
import { migrateRuntimeStore } from './store-migrations.ts';
import { type TaskPlanRecords, createTaskPlanRecords } from './task-plan-records.ts';

const BUSY_TIMEOUT_MS = 750;
type P<T extends (...args: never[]) => unknown> = Parameters<T>;

export interface TransitionEffects {
	createInterrupt?: InterruptInput | null;
	recordModelOperation?: ModelOperationInput | null;
	resolveInterruptId?: string | null;
	cancelInterruptId?: string | null;
}

function errorMessageOf(error: unknown): string {
	if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
		return error.message;
	}
	return '';
}

export class RuntimeStore {
	readonly databasePath: string;
	closed: boolean;
	readonly database: DatabaseSync;
	readonly ledger: RunLedger;
	readonly checkpoints: CheckpointRecords;
	readonly delivery: DeliveryRecords;
	readonly reviews: ReviewRecords;
	readonly generations: GenerationRecords;
	readonly taskPlans: TaskPlanRecords;
	readonly interrupts: InterruptRecords;
	readonly modelOps: ModelOperationRecords;
	readonly projections: ProjectionRecords;
	readonly learning: LearningRecords;
	readonly friction: FrictionRecords;
	readonly integrity: StoreIntegrity;
	private _transactionDepth = 0;

	constructor(databasePath: string, { busyTimeoutMs = BUSY_TIMEOUT_MS }: { busyTimeoutMs?: number } = {}) {
		this.databasePath = databasePath;
		this.closed = false;
		let db: DatabaseSync | undefined;
		try {
			db = new DatabaseSync(databasePath);
			this.database = db;
			this.database.exec('PRAGMA foreign_keys = ON');
			this.database.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`);
			this.database.exec('PRAGMA journal_mode = WAL');
			const context = Object.freeze({
				database: this.database,
				transaction: <T>(operation: () => T): T => this.transaction(operation),
				assertOpen: (): void => this.assertOpen(),
			});
			this.ledger = createRunLedger(context);
			this.checkpoints = createCheckpointRecords(context);
			this.delivery = createDeliveryRecords(context);
			this.reviews = createReviewRecords(context);
			this.generations = createGenerationRecords(context);
			this.taskPlans = createTaskPlanRecords(context);
			this.interrupts = createInterruptRecords(context);
			this.modelOps = createModelOperationRecords(context, this.ledger);
			this.projections = createProjectionRecords(context, this.ledger);
			this.learning = createLearningRecords(context, this.ledger);
			this.friction = createFrictionRecords(context, this.ledger);
			this.integrity = createStoreIntegrity(context, {
				ledger: this.ledger,
				projections: this.projections,
				taskPlans: this.taskPlans,
				generations: this.generations,
			});
			this.migrate();
			fs.chmodSync(databasePath, 0o600);
		} catch (error: unknown) {
			try {
				db?.close();
			} catch {
				// Preserve the startup error.
			}
			const msg = errorMessageOf(error);
			if (/\b(?:locked|busy)\b/i.test(msg)) {
				throw new SdlcError('STORE_BUSY', 'Runtime database is busy', {}, { cause: error });
			}
			if (/malformed|not a database|disk image/i.test(msg)) {
				throw new SdlcError('STORE_CORRUPT', 'Runtime database is corrupt', {}, { cause: error });
			}
			throw asSdlcError(error, 'INTERNAL_ERROR', 'Runtime database initialization failed');
		}
	}

	migrate(): void {
		migrateRuntimeStore(this.database, <T>(operation: () => T): T => this.transaction(operation));
	}

	transaction<T>(operation: () => T): T {
		this.assertOpen();
		if (this._transactionDepth > 0) return operation();
		this._transactionDepth = 1;
		try {
			this.database.exec('BEGIN IMMEDIATE');
			const result = operation();
			this.database.exec('COMMIT');
			return result;
		} catch (error: unknown) {
			try {
				if (this.database.isTransaction) this.database.exec('ROLLBACK');
			} catch {
				// Preserve the original transaction error.
			}
			if (/\b(?:locked|busy)\b/i.test(errorMessageOf(error))) {
				throw new SdlcError('STORE_BUSY', 'Runtime database write timed out', {}, { cause: error });
			}
			throw error;
		} finally {
			this._transactionDepth = 0;
		}
	}

	initializeRun(stateInput: unknown, eventInput: unknown): Readonly<RuntimeState> {
		const state = validateRuntimeState(stateInput);
		const event = validateEvent(eventInput);
		if (state.runtimeRevision !== 0 || event.runtimeRevision !== 0) {
			throw new SdlcError('INVALID_TRANSITION', 'Initial runtime revision must be zero');
		}
		this.transaction(() => {
			this.ledger.insertRun(state);
			this.insertEvent(event);
			this.queueProjection(state.runId, state.runtimeRevision);
		});
		return state;
	}

	getRun(...a: P<RunLedger['getRun']>) { return this.ledger.getRun(...a); }
	hasRun(...a: P<RunLedger['hasRun']>) { return this.ledger.hasRun(...a); }

	saveTransition(
		expectedRevision: number,
		nextStateInput: unknown,
		eventInput: unknown,
		effects: TransitionEffects = {},
	): Readonly<RuntimeState> {
		const nextState = validateRuntimeState(nextStateInput);
		const event = validateEvent(eventInput);
		return this.transaction(() => {
			const current = this.getRun(nextState.runId);
			const nextHash = sha256(nextState);
			if (current.runtimeRevision === nextState.runtimeRevision) {
				if (sha256(current) !== nextHash || !this.getEvent(event.eventId)) {
					throw new SdlcError(
						'STORE_RECONCILIATION_FAILED',
						'Duplicate transition does not match persisted state',
					);
				}
				return current;
			}
			if (
				current.runtimeRevision !== expectedRevision ||
				nextState.runtimeRevision !== expectedRevision + 1
			) {
				throw new SdlcError('INVALID_TRANSITION', 'Runtime revision is stale', {
					expectedRevision,
					actualRevision: current.runtimeRevision,
				});
			}
			assertTransition(current.state, nextState.state);
			const updated = this.ledger.updateRunRow(
				nextState,
				nextHash,
				nextState.semanticRepairsCount ?? current.semanticRepairsCount ?? 0,
				expectedRevision,
			);
			if (updated.changes !== 1) {
				throw new SdlcError('INVALID_TRANSITION', 'Concurrent runtime update rejected');
			}
			this.insertEvent(event);
			if (effects.createInterrupt) this.insertInterrupt(effects.createInterrupt);
			if (effects.recordModelOperation) this.recordModelOperation(effects.recordModelOperation);
			if (effects.resolveInterruptId) {
				this.interrupts.resolveRecordedForTransition(effects.resolveInterruptId, nextState.updatedAt);
			}
			if (effects.cancelInterruptId) {
				this.interrupts.cancelOpenForTransition(effects.cancelInterruptId, nextState.updatedAt);
			}
			this.queueProjection(nextState.runId, nextState.runtimeRevision);
			return nextState;
		});
	}

	insertEvent(...a: P<RunLedger['insertEvent']>) { return this.ledger.insertEvent(...a); }
	getEvent(...a: P<RunLedger['getEvent']>) { return this.ledger.getEvent(...a); }
	listEvents(...a: P<RunLedger['listEvents']>) { return this.ledger.listEvents(...a); }
	appendEvent(...a: P<RunLedger['appendEvent']>) { return this.ledger.appendEvent(...a); }
	recordEvent(...a: P<RunLedger['recordEvent']>) { return this.ledger.recordEvent(...a); }
	eventLogHash(...a: P<RunLedger['eventLogHash']>) { return this.ledger.eventLogHash(...a); }
	registerArtifact(...a: P<RunLedger['registerArtifact']>) { return this.ledger.registerArtifact(...a); }
	getArtifact(...a: P<RunLedger['getArtifact']>) { return this.ledger.getArtifact(...a); }
	createInterrupt(...a: P<InterruptRecords['createInterrupt']>) { return this.interrupts.createInterrupt(...a); }
	insertInterrupt(...a: P<InterruptRecords['insertInterrupt']>) { return this.interrupts.insertInterrupt(...a); }
	getInterrupt(...a: P<InterruptRecords['getInterrupt']>) { return this.interrupts.getInterrupt(...a); }
	getPendingInterrupt(...a: P<InterruptRecords['getPendingInterrupt']>) { return this.interrupts.getPendingInterrupt(...a); }
	recordInterruptResponse(...a: P<InterruptRecords['recordInterruptResponse']>) { return this.interrupts.recordInterruptResponse(...a); }
	resolveInterrupt(...a: P<InterruptRecords['resolveInterrupt']>) { return this.interrupts.resolveInterrupt(...a); }
	cancelInterrupt(...a: P<InterruptRecords['cancelInterrupt']>) { return this.interrupts.cancelInterrupt(...a); }
	recordModelOperation(...a: P<ModelOperationRecords['recordModelOperation']>) { return this.modelOps.recordModelOperation(...a); }
	getModelOperation(...a: P<ModelOperationRecords['getModelOperation']>) { return this.modelOps.getModelOperation(...a); }
	countModelOperations(...a: P<ModelOperationRecords['countModelOperations']>) { return this.modelOps.countModelOperations(...a); }
	recordDiagnostic(...a: P<ModelOperationRecords['recordDiagnostic']>) { return this.modelOps.recordDiagnostic(...a); }
	listDiagnostics(...a: P<ModelOperationRecords['listDiagnostics']>) { return this.modelOps.listDiagnostics(...a); }
	queueProjection(...a: P<ProjectionRecords['queueProjection']>) { return this.projections.queueProjection(...a); }
	reserveProjection(...a: P<ProjectionRecords['reserveProjection']>) { return this.projections.reserveProjection(...a); }
	appendProjectionEvent(...a: P<ProjectionRecords['appendProjectionEvent']>) { return this.projections.appendProjectionEvent(...a); }
	saveProjectionPayload(...a: P<ProjectionRecords['saveProjectionPayload']>) { return this.projections.saveProjectionPayload(...a); }
	getProjectionRecord(...a: P<ProjectionRecords['getProjectionRecord']>) { return this.projections.getProjectionRecord(...a); }
	markProjectionPublished(...a: P<ProjectionRecords['markProjectionPublished']>) { return this.projections.markProjectionPublished(...a); }
	listPendingProjections(...a: P<ProjectionRecords['listPendingProjections']>) { return this.projections.listPendingProjections(...a); }
	getProjectionRevision(...a: P<ProjectionRecords['getProjectionRevision']>) { return this.projections.getProjectionRevision(...a); }
	appendContinuationProjection(...a: P<ProjectionRecords['appendContinuationProjection']>) { return this.projections.appendContinuationProjection(...a); }
	findContinuationProjection(...a: P<ProjectionRecords['findContinuationProjection']>) { return this.projections.findContinuationProjection(...a); }
	latestDurableProjection(...a: P<ProjectionRecords['latestDurableProjection']>) { return this.projections.latestDurableProjection(...a); }
	reconcile(...a: P<StoreIntegrity['reconcile']>) { return this.integrity.reconcile(...a); }
	getCheckpointRow(...a: P<CheckpointRecords['getCheckpointRow']>) { return this.checkpoints.getCheckpointRow(...a); }
	listCheckpointRows(...a: P<CheckpointRecords['listCheckpointRows']>) { return this.checkpoints.listCheckpointRows(...a); }
	putCheckpointRow(...a: P<CheckpointRecords['putCheckpointRow']>) { return this.checkpoints.putCheckpointRow(...a); }
	putCheckpointWrite(...a: P<CheckpointRecords['putCheckpointWrite']>) { return this.checkpoints.putCheckpointWrite(...a); }
	listCheckpointWrites(...a: P<CheckpointRecords['listCheckpointWrites']>) { return this.checkpoints.listCheckpointWrites(...a); }
	saveAuthorization(...a: P<GenerationRecords['saveAuthorization']>) { return this.generations.saveAuthorization(...a); }
	getAuthorization(...a: P<GenerationRecords['getAuthorization']>) { return this.generations.getAuthorization(...a); }
	hasAuthorization(...a: P<GenerationRecords['hasAuthorization']>) { return this.generations.hasAuthorization(...a); }
	saveGeneration(...a: P<GenerationRecords['saveGeneration']>) { return this.generations.saveGeneration(...a); }
	recordReviewOutcome(...a: P<GenerationRecords['recordReviewOutcome']>) { return this.generations.recordReviewOutcome(...a); }
	getGeneration(...a: P<GenerationRecords['getGeneration']>) { return this.generations.getGeneration(...a); }
	getLatestGeneration(...a: P<GenerationRecords['getLatestGeneration']>) { return this.generations.getLatestGeneration(...a); }
	getMaxRecordedGeneration(...a: P<GenerationRecords['getMaxRecordedGeneration']>) { return this.generations.getMaxRecordedGeneration(...a); }
	listGenerations(...a: P<GenerationRecords['listGenerations']>) { return this.generations.listGenerations(...a); }
	recordToolExecution(...a: P<GenerationRecords['recordToolExecution']>) { return this.generations.recordToolExecution(...a); }
	getToolExecution(...a: P<GenerationRecords['getToolExecution']>) { return this.generations.getToolExecution(...a); }
	listToolExecutions(...a: P<GenerationRecords['listToolExecutions']>) { return this.generations.listToolExecutions(...a); }
	incrementSemanticRepairs(...a: P<RunLedger['incrementSemanticRepairs']>) { return this.ledger.incrementSemanticRepairs(...a); }
	getSemanticRepairsCount(...a: P<RunLedger['getSemanticRepairsCount']>) { return this.ledger.getSemanticRepairsCount(...a); }
	saveGitCommit(...a: P<DeliveryRecords['saveGitCommit']>) { return this.delivery.saveGitCommit(...a); }
	getGitCommit(...a: P<DeliveryRecords['getGitCommit']>) { return this.delivery.getGitCommit(...a); }
	savePullRequest(...a: P<DeliveryRecords['savePullRequest']>) { return this.delivery.savePullRequest(...a); }
	getPullRequest(...a: P<DeliveryRecords['getPullRequest']>) { return this.delivery.getPullRequest(...a); }
	saveCriticReview(...a: P<ReviewRecords['saveCriticReview']>) { return this.reviews.saveCriticReview(...a); }
	listCriticReviews(...a: P<ReviewRecords['listCriticReviews']>) { return this.reviews.listCriticReviews(...a); }
	saveOptionalRoleExecution(...a: P<ReviewRecords['saveOptionalRoleExecution']>) { return this.reviews.saveOptionalRoleExecution(...a); }
	listOptionalRoleExecutions(...a: P<ReviewRecords['listOptionalRoleExecutions']>) { return this.reviews.listOptionalRoleExecutions(...a); }
	saveTaskPlan(...a: P<TaskPlanRecords['saveTaskPlan']>) { return this.taskPlans.saveTaskPlan(...a); }
	getTaskPlan(...a: P<TaskPlanRecords['getTaskPlan']>) { return this.taskPlans.getTaskPlan(...a); }
	getTask(...a: P<TaskPlanRecords['getTask']>) { return this.taskPlans.getTask(...a); }
	updateTaskStatus(...a: P<TaskPlanRecords['updateTaskStatus']>) { return this.taskPlans.updateTaskStatus(...a); }
	listTasks(...a: P<TaskPlanRecords['listTasks']>) { return this.taskPlans.listTasks(...a); }
	saveReconciliation(...a: P<TaskPlanRecords['saveReconciliation']>) { return this.taskPlans.saveReconciliation(...a); }
	getReconciliation(...a: P<TaskPlanRecords['getReconciliation']>) { return this.taskPlans.getReconciliation(...a); }
	getLatestReconciliation(...a: P<TaskPlanRecords['getLatestReconciliation']>) { return this.taskPlans.getLatestReconciliation(...a); }
	recordCandidateLearning(...a: P<LearningRecords['recordCandidateLearning']>) { return this.learning.recordCandidateLearning(...a); }
	listCandidateLearnings(...a: P<LearningRecords['listCandidateLearnings']>) { return this.learning.listCandidateLearnings(...a); }
	enqueueLearningOutbox(...a: P<LearningRecords['enqueueLearningOutbox']>) { return this.learning.enqueueLearningOutbox(...a); }
	listPendingLearningOutbox(...a: P<LearningRecords['listPendingLearningOutbox']>) { return this.learning.listPendingLearningOutbox(...a); }
	markLearningOutboxPublished(...a: P<LearningRecords['markLearningOutboxPublished']>) { return this.learning.markLearningOutboxPublished(...a); }

	saveResumeFromEscalation({
		expectedRevision,
		nextState,
		event,
		candidateLearning = null,
		now = new Date().toISOString(),
	}: {
		expectedRevision: number;
		nextState: RuntimeState;
		event: unknown;
		candidateLearning?: CandidateLearningInput | null;
		now?: string;
	}): Readonly<RuntimeState> {
		return this.transaction(() => {
			const savedState = this.saveTransition(expectedRevision, nextState, event);
			if (candidateLearning) {
				const candidate = this.upsertCandidateLearningRow({
					...candidateLearning,
					runId: candidateLearning.runId,
					sourcePhase: 'post-mortem',
					source: 'user-stated',
					stagedAt: candidateLearning.stagedAt || now,
				});
				if (candidate.inserted) {
					const outboxId = crypto.randomUUID();
					const learningJson = JSON.stringify({
						type: candidateLearning.type,
						key: candidateLearning.key,
						scope: candidateLearning.scope,
						query: candidateLearning.query,
						insight: candidateLearning.insight,
						confidence: candidateLearning.confidence ?? 9,
						source: candidateLearning.source || 'user-stated',
						ts: candidateLearning.stagedAt || now,
					});
					this.insertLearningOutboxRow({
						outboxId,
						runId: candidateLearning.runId,
						runtimeRevision: nextState.runtimeRevision,
						learningKey: candidateLearning.key,
						payloadJson: learningJson,
						now,
					});
				}
			}
			return savedState;
		});
	}

	recordPostMortem(...a: P<LearningRecords['recordPostMortem']>) { return this.learning.recordPostMortem(...a); }
	upsertCandidateLearningRow(...a: P<LearningRecords['upsertCandidateLearningRow']>) { return this.learning.upsertCandidateLearningRow(...a); }
	insertLearningOutboxRow(...a: P<LearningRecords['insertLearningOutboxRow']>) { return this.learning.insertLearningOutboxRow(...a); }
	insertPromptFrictionFinding(...a: P<FrictionRecords['insertPromptFrictionFinding']>) { return this.friction.insertPromptFrictionFinding(...a); }
	getPromptFrictionFinding(...a: P<FrictionRecords['getPromptFrictionFinding']>) { return this.friction.getPromptFrictionFinding(...a); }
	listPromptFrictionFindings(...a: P<FrictionRecords['listPromptFrictionFindings']>) { return this.friction.listPromptFrictionFindings(...a); }
	hasUnreviewedFriction(...a: P<FrictionRecords['hasUnreviewedFriction']>) { return this.friction.hasUnreviewedFriction(...a); }
	recordFrictionAnalyzed(...a: P<FrictionRecords['recordFrictionAnalyzed']>) { return this.friction.recordFrictionAnalyzed(...a); }
	recordContinuationAttempt(...a: P<InterruptRecords['recordContinuationAttempt']>) { return this.interrupts.recordContinuationAttempt(...a); }
	getContinuationAttempt(...a: P<InterruptRecords['getContinuationAttempt']>) { return this.interrupts.getContinuationAttempt(...a); }
	getContinuationAttempts(...a: P<InterruptRecords['getContinuationAttempts']>) { return this.interrupts.getContinuationAttempts(...a); }
	deleteContinuationAttempt(...a: P<InterruptRecords['deleteContinuationAttempt']>) { return this.interrupts.deleteContinuationAttempt(...a); }
	clearContinuationAttempts(...a: P<InterruptRecords['clearContinuationAttempts']>) { return this.interrupts.clearContinuationAttempts(...a); }

	assertOpen(): void {
		if (this.closed) throw new SdlcError('INTERNAL_ERROR', 'Runtime store is closed');
	}

	close(): void {
		if (this.closed) return;
		this.database.close();
		this.closed = true;
	}
}
