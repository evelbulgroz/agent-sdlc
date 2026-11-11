// Status record for an integration or committed-tree preflight halt.

import {
	INTEGRATION_CATEGORIES,
	classifyIntegrationDiagnostics,
	type IntegrationCategory,
} from '../review/integration-diagnostics.ts';

export const INTEGRATION_HALT_PATHS = Object.freeze([
	'AUTONOMOUS_REPAIR_RETIRED',
	'QUALITY_CHECKPOINT_PREFLIGHT',
	'VERIFICATION_OUTSIDE_AUTHORIZED_SCOPE',
] as const);

export type IntegrationHaltPath = (typeof INTEGRATION_HALT_PATHS)[number];

export interface IntegrationFailureRecord {
	readonly haltPath: IntegrationHaltPath;
	readonly classification: string;
	readonly category: IntegrationCategory;
	readonly targetPaths: readonly string[];
	readonly continuation: 'stop' | 'approve-correction';
}

function packetFields(packet: unknown): { classification: string; targetPaths: readonly string[] } {
	if (!packet || typeof packet !== 'object') {
		return { classification: 'unknown', targetPaths: [] };
	}
	const record = packet as Record<string, unknown>;
	const classification = typeof record.classification === 'string' ? record.classification : 'unknown';
	const targetPaths = Array.isArray(record.targetPaths)
		? record.targetPaths.filter((path): path is string => typeof path === 'string' && path.length > 0)
		: [];
	return { classification, targetPaths: Object.freeze(targetPaths) };
}

export function buildIntegrationFailure({
	haltPath,
	failurePacket = null,
	diagnostics = null,
}: {
	haltPath: IntegrationHaltPath;
	failurePacket?: unknown;
	diagnostics?: unknown;
}): IntegrationFailureRecord {
	const packet = packetFields(failurePacket);
	const classified = haltPath === 'VERIFICATION_OUTSIDE_AUTHORIZED_SCOPE'
		? { category: 'unclassified' as const, targetPaths: [] as readonly string[] }
		: classifyIntegrationDiagnostics(diagnostics);
	const targetPaths = classified.targetPaths.length > 0 ? classified.targetPaths : packet.targetPaths;
	return Object.freeze({
		haltPath,
		classification: packet.classification,
		category: classified.category,
		targetPaths: Object.freeze([...targetPaths]),
		continuation: haltPath === 'QUALITY_CHECKPOINT_PREFLIGHT' ? 'approve-correction' : 'stop',
	});
}

export function integrationFailureFromState(state: {
	lastError?: { metadata?: unknown } | null;
}): IntegrationFailureRecord | null {
	const metadata = state.lastError?.metadata;
	if (!metadata || typeof metadata !== 'object') return null;
	const record = (metadata as Record<string, unknown>).integrationFailure;
	if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
	const fields = record as Record<string, unknown>;
	const haltPath = fields.haltPath;
	const category = fields.category;
	if (typeof haltPath !== 'string' || !(INTEGRATION_HALT_PATHS as readonly string[]).includes(haltPath)) return null;
	if (typeof fields.classification !== 'string') return null;
	if (typeof category !== 'string' || !(INTEGRATION_CATEGORIES as readonly string[]).includes(category)) return null;
	if (!Array.isArray(fields.targetPaths) || !fields.targetPaths.every((path) => typeof path === 'string')) return null;
	if (fields.continuation !== 'stop' && fields.continuation !== 'approve-correction') return null;
	return Object.freeze({
		haltPath: haltPath as IntegrationHaltPath,
		classification: fields.classification,
		category: category as IntegrationCategory,
		targetPaths: Object.freeze([...fields.targetPaths]),
		continuation: fields.continuation,
	});
}
