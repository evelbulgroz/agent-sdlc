// Operator correction card: eligibility, owner choice, and reply payload check.
import { taskAuthoredWritePaths, type TaskScopeTaskLike } from '../execution/task-scope.ts';
import { SdlcError } from '../policy/errors.ts';
import { anyHighRiskPaths, isOraclePath } from '../review/review-generation.ts';
import { integrationFailureFromState } from './status-integration-failure.ts';
import { resolvedImporters, type StaticImportGraph } from '../policy/static-import-graph.ts';

export interface CorrectionOffer {
	readonly paths: readonly string[];
	readonly taskId: string | null;
	readonly taskIdRequired: boolean;
}

export interface CorrectionOwnerTask extends TaskScopeTaskLike {
	readonly taskId: string;
	readonly targetPackage: string;
	readonly integrationOrder?: number;
	readonly targetTreeSha?: string | null;
	readonly parentTreeSha?: string | null;
	readonly baseCommitSha?: string | null;
}

export interface AcceptedCorrection {
	readonly action: 'approve-correction' | 'stop';
	readonly taskId: string | null;
	readonly paths: readonly string[];
	readonly methods: readonly { file: string; name: string }[];
}

interface ContinuationOfferState {
	state?: string | null;
	blockedReason?: string | null;
	lastError?: { metadata?: unknown } | null;
}

export function readCorrectionOffer(
	state: ContinuationOfferState | null | undefined,
	authorization: { allowedPathPrefixes?: readonly string[] | null } | null | undefined,
	highRiskPaths?: readonly string[] | null,
): CorrectionOffer | null {
	if (!state || state.state !== 'ESCALATED' || state.blockedReason !== 'AUTONOMOUS_REPAIR_RETIRED') return null;
	const metadata = state.lastError?.metadata;
	if (!metadata || typeof metadata !== 'object' || (metadata as { integrationCorrectionConsumed?: unknown }).integrationCorrectionConsumed === true) {
		return null;
	}
	const failure = integrationFailureFromState(state);
	if (!failure || failure.category !== 'coverage_floor_regression' || failure.haltPath !== 'AUTONOMOUS_REPAIR_RETIRED') {
		return null;
	}
	const raw = (metadata as { correctionOffer?: unknown }).correctionOffer;
	const offer = parseOffer(raw);
	if (!offer || !samePaths(offer.paths, failure.targetPaths)) return null;
	if (!pathsAllowed(offer.paths, authorization?.allowedPathPrefixes ?? [])) return null;
	if (offer.paths.some((item) => isOraclePath(item))) return null;
	if (highRisk(offer.paths, highRiskPaths)) return null;
	return offer;
}

export function selectCorrectionOwner({
	tasks,
	paths,
	baseGraph,
	targetGraphs,
}: {
	tasks: readonly CorrectionOwnerTask[];
	paths: readonly string[];
	baseGraph: StaticImportGraph;
	targetGraphs: Readonly<Record<string, StaticImportGraph>>;
}): { kind: 'write-set' | 'removed-import' | 'unresolved'; taskId: string | null } {
	const writeSetOwners = tasks.filter((task) => paths.every((item) => writeSetContains(taskAuthoredWritePaths(task), item)));
	if (writeSetOwners.length === 1) return { kind: 'write-set', taskId: writeSetOwners[0]?.taskId ?? null };
	const removed = tasks.filter((task) => paths.every((item) => removedImport(task, item, baseGraph, targetGraphs[task.taskId])));
	if (removed.length === 1) return { kind: 'removed-import', taskId: removed[0]?.taskId ?? null };
	return { kind: 'unresolved', taskId: null };
}

export function offerFromOwner(
	paths: readonly string[],
	owner: { kind: 'write-set' | 'removed-import' | 'unresolved'; taskId: string | null },
): CorrectionOffer {
	return Object.freeze({
		paths: Object.freeze([...paths]),
		taskId: owner.taskId,
		taskIdRequired: owner.kind !== 'write-set',
	});
}

export function acceptCorrectionResponse(offer: CorrectionOffer, payload: unknown): AcceptedCorrection {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new SdlcError('INVALID_INPUT', 'Correction reply must be an object');
	}
	const record = payload as Record<string, unknown>;
	if (record.action === 'stop') {
		return { action: 'stop', taskId: null, paths: [...offer.paths], methods: [] };
	}
	if (record.action !== 'approve-correction') {
		throw new SdlcError('INVALID_INPUT', "Reply is missing required response slot 'action'");
	}
	const paths = normalizePaths(record.paths);
	if (!paths || !samePaths(paths, offer.paths)) {
		throw new SdlcError('INVALID_INPUT', 'Reply paths do not match the correction card');
	}
	const methods = parseMethods(record.methods, paths);
	if (offer.taskIdRequired) {
		if (typeof record.taskId !== 'string' || record.taskId.length === 0) {
			throw new SdlcError('INVALID_INPUT', 'Reply is missing required response slot taskId');
		}
		if (offer.taskId && record.taskId !== offer.taskId) {
			throw new SdlcError('INVALID_INPUT', 'Reply taskId does not match the correction owner');
		}
		return { action: 'approve-correction', taskId: record.taskId, paths, methods };
	}
	if (record.taskId !== undefined && record.taskId !== null && record.taskId !== offer.taskId) {
		throw new SdlcError('INVALID_INPUT', 'Reply taskId does not match the correction owner');
	}
	return { action: 'approve-correction', taskId: offer.taskId, paths, methods };
}

export function assertUnresolvedTask({
	tasks,
	taskId,
	paths,
	allowedPathPrefixes,
}: {
	tasks: readonly CorrectionOwnerTask[];
	taskId: string | null;
	paths: readonly string[];
	allowedPathPrefixes: readonly string[];
}): CorrectionOwnerTask {
	const task = tasks.find((item) => item.taskId === taskId);
	if (!task) throw new SdlcError('INVALID_INPUT', 'Correction task is not in the frozen plan');
	for (const item of paths) {
		if (!under(item, task.targetPackage)) {
			throw new SdlcError('INVALID_INPUT', 'Correction path is outside the task package');
		}
		if (!underPrefixes(item, allowedPathPrefixes)) {
			throw new SdlcError('INVALID_INPUT', 'Correction path is outside the approved prefixes');
		}
	}
	return task;
}

export function mergeCorrectionReply(
	card: { responseSlots?: unknown; responseDocument?: unknown } | null | undefined,
	payload: Record<string, unknown>,
	filled: Record<string, unknown>,
): Record<string, unknown> {
	const slots = card?.responseSlots;
	const choices = slots && typeof slots === 'object' && !Array.isArray(slots)
		? (slots as { choices?: unknown }).choices
		: null;
	if (!Array.isArray(choices) || !choices.includes('approve-correction')) return filled;
	const offer = parseOffer(card?.responseDocument);
	if (!offer) throw new SdlcError('INVALID_INPUT', 'Correction card is missing its paths');
	const accepted = acceptCorrectionResponse(offer, payload);
	return {
		...filled,
		paths: [...accepted.paths],
		...(accepted.taskId ? { taskId: accepted.taskId } : {}),
		...(accepted.methods.length > 0 ? { methods: accepted.methods.map((item) => ({ ...item })) } : {}),
	};
}

export function pathsAllowed(paths: readonly string[], prefixes: readonly string[]): boolean {
	return paths.length > 0 && paths.every((item) => underPrefixes(item, prefixes));
}

export function highRisk(paths: readonly string[], highRiskPaths?: readonly string[] | null): boolean {
	if (highRiskPaths) {
		return paths.some((item) => highRiskPaths.some((prefix) => under(item, prefix)));
	}
	return anyHighRiskPaths(paths);
}

function removedImport(
	task: CorrectionOwnerTask,
	target: string,
	baseGraph: StaticImportGraph,
	targetGraph: StaticImportGraph | undefined,
): boolean {
	const writeSet = new Set(taskAuthoredWritePaths(task).map(normalize));
	const baseImporters = resolvedImporters(baseGraph, target).filter((file) => writeSet.has(file));
	if (baseImporters.length === 0) return false;
	const still = new Set(targetGraph ? resolvedImporters(targetGraph, target) : []);
	return baseImporters.some((file) => !still.has(file));
}

function parseOffer(raw: unknown): CorrectionOffer | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	const paths = normalizePaths(record.paths);
	if (!paths) return null;
	if (record.taskId !== null && typeof record.taskId !== 'string') return null;
	if (typeof record.taskIdRequired !== 'boolean') return null;
	return Object.freeze({
		paths: Object.freeze(paths),
		taskId: typeof record.taskId === 'string' ? record.taskId : null,
		taskIdRequired: record.taskIdRequired,
	});
}

function parseMethods(raw: unknown, paths: readonly string[]): { file: string; name: string }[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new SdlcError('INVALID_INPUT', 'Correction methods must be a list');
	return raw.map((item) => {
		if (!item || typeof item !== 'object') throw new SdlcError('INVALID_INPUT', 'Correction method is invalid');
		const file = (item as { file?: unknown }).file;
		const name = (item as { name?: unknown }).name;
		if (typeof file !== 'string' || typeof name !== 'string' || !paths.includes(file)) {
			throw new SdlcError('INVALID_INPUT', 'Correction method file must already be on the card');
		}
		return { file, name };
	});
}

function normalizePaths(raw: unknown): string[] | null {
	if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => typeof item !== 'string' || item.length === 0)) {
		return null;
	}
	return raw.map((item) => normalize(item as string));
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((item, index) => normalize(item) === normalize(right[index] ?? ''));
}

function writeSetContains(writePaths: readonly string[], target: string): boolean {
	return writePaths.some((prefix) => under(target, prefix) || normalize(target) === normalize(prefix));
}

function underPrefixes(target: string, prefixes: readonly string[]): boolean {
	return prefixes.some((prefix) => under(target, prefix));
}

function under(target: string, prefix: string): boolean {
	const clean = normalize(prefix).replace(/\/+$/, '');
	const path = normalize(target);
	return path === clean || path.startsWith(`${clean}/`);
}

function normalize(value: string): string {
	return value.replaceAll('\\', '/').replace(/^\.\//, '');
}
