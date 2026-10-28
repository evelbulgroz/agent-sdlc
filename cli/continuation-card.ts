// Republish a continuation card without a runtime transition.
import fs from 'node:fs';
import { validateStatus } from '../agent-status-validate.ts';
import { assertProjectionSafe } from '../persistence/artifacts.ts';
import {
	type ContinuationRecord,
	type HostInvocationRecord,
	canonicalJson,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { computeContinuation } from './continuation.ts';
import { projectHostInvocation } from './host-invocation.ts';
import { atomicWrite } from './projection-artifacts.ts';
import { projectionHash } from './status-document.ts';
import type { StatusProjectionLike } from './status-result.ts';

export interface StoredStatusDocument extends Record<string, unknown> {
	revision?: number;
	continuation?: Readonly<ContinuationRecord> | null;
	hostInvocation?: Readonly<HostInvocationRecord> | null;
	orchestration: {
		runtimeRevision: number;
		projectionHash: string | null;
		[key: string]: unknown;
	};
}

/**
 * A continuation attempt is not a runtime transition. When the attempt
 * changes the card, append a later status revision at the same
 * orchestration.runtimeRevision and leave the outbox payload untouched.
 */
export async function publishChangedContinuationCard(
	projection: StatusProjectionLike,
): Promise<StoredStatusDocument> {
	const state = projection.runtimeStore.getRun(projection.paths.runId);
	if (!fs.existsSync(projection.paths.statusPath)) {
		throw new SdlcError('PROJECTION_DRIFT', 'status.json is missing');
	}
	const previousText = fs.readFileSync(projection.paths.statusPath, 'utf8');
	assertProjectionSafe(previousText);
	const previous = JSON.parse(previousText) as StoredStatusDocument;
	if (!previous.orchestration) {
		throw new SdlcError('PROJECTION_DRIFT', 'status.json has no orchestration envelope');
	}
	if (previous.orchestration.runtimeRevision !== state.runtimeRevision) {
		throw new SdlcError(
			'PROJECTION_DRIFT',
			'Continuation card publish saw a stale status.json runtime revision',
		);
	}
	const inputs = projection.continuationInputs(state);
	const continuation = computeContinuation(state, inputs);
	const hostInvocation = projectHostInvocation(state, inputs);
	const previousCard = {
		continuation: previous.continuation ?? null,
		hostInvocation: previous.hostInvocation ?? null,
	};
	if (canonicalJson(previousCard) === canonicalJson({ continuation, hostInvocation })) {
		return previous;
	}
	const outboxBefore = projection.runtimeStore.getProjectionRecord(
		state.runId,
		state.runtimeRevision,
	);
	const outboxBytes = outboxBefore?.status ? canonicalJson(outboxBefore.status) : null;
	const status = structuredClone(previous);
	status.continuation = continuation;
	status.hostInvocation = hostInvocation;
	status.revision = Math.max(
		projection.runtimeStore.getProjectionRevision(state.runId) + 1,
		(typeof previous.revision === 'number' ? previous.revision : 0) + 1,
	);
	status.orchestration.runtimeRevision = state.runtimeRevision;
	status.orchestration.projectionHash = null;
	status.orchestration.projectionHash = projectionHash(status);
	const validation = validateStatus(status, { previous });
	if (!validation.ok) {
		throw new SdlcError(
			'INVALID_CONTRACT',
			`Continuation status projection is invalid: ${validation.errors.join('; ')}`,
		);
	}
	assertProjectionSafe(JSON.stringify(status));
	const stored = projection.runtimeStore.appendContinuationProjection(
		state.runId,
		status,
	) as StoredStatusDocument;
	atomicWrite(projection.paths.statusPath, `${JSON.stringify(stored, null, 2)}\n`);
	const outboxAfter = projection.runtimeStore.getProjectionRecord(
		state.runId,
		state.runtimeRevision,
	);
	if (outboxBytes !== null && canonicalJson(outboxAfter?.status) !== outboxBytes) {
		throw new SdlcError(
			'STORE_RECONCILIATION_FAILED',
			'Continuation publish rewrote the outbox payload',
		);
	}
	return stored;
}
