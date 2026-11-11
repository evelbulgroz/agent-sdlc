// Closed host integrationDiagnostics object. Invalid shapes are dropped.

export const INTEGRATION_DIAGNOSTICS_VERSION = '1';

export const INTEGRATION_CATEGORIES = Object.freeze([
	'baseline_clone_line_shift',
	'coverage_floor_regression',
	'contract_drift',
	'quality_regression',
	'unclassified',
] as const);

export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

const DIAGNOSTIC_KEYS = new Set(['schemaVersion', 'coverageFloor', 'contractDrift', 'clones']);
const FLOOR_KEYS = new Set(['pass', 'paths']);
const CLONE_KEYS = new Set(['tool', 'baseline', 'observed', 'textUnchanged']);

export interface ClassifiedIntegrationDiagnostics {
	readonly category: IntegrationCategory;
	readonly targetPaths: readonly string[];
}

function plainObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function closed(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => keys.has(key));
}

function pathList(value: unknown): readonly string[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;
	if (!value.every((item) => typeof item === 'string' && item.length > 0)) return null;
	return Object.freeze([...value]);
}

function failingFloor(value: unknown): readonly string[] | null | 'skip' {
	if (value === undefined) return 'skip';
	const record = plainObject(value);
	if (!record || !closed(record, FLOOR_KEYS) || typeof record.pass !== 'boolean') return null;
	if (record.pass) return 'skip';
	return pathList(record.paths);
}

interface CloneSignal {
	readonly kind: 'shift' | 'regression';
	readonly path: string;
}

function cloneSignal(value: unknown): CloneSignal | null | 'skip' {
	if (value === undefined) return 'skip';
	if (!Array.isArray(value)) return null;
	let regression: CloneSignal | null = null;
	let shift: CloneSignal | null = null;
	for (const entry of value) {
		const record = plainObject(entry);
		if (!record || !closed(record, CLONE_KEYS)) return null;
		if (record.tool !== 'jscpd') return null;
		if (typeof record.baseline !== 'string' || typeof record.observed !== 'string') return null;
		if (typeof record.textUnchanged !== 'boolean') return null;
		const path = record.observed.split(':')[0] ?? '';
		if (!path) return null;
		if (!record.textUnchanged) regression = { kind: 'regression', path };
		else if (record.baseline !== record.observed) shift = { kind: 'shift', path };
	}
	return regression ?? shift ?? 'skip';
}

export function validIntegrationDiagnostics(result: unknown): Record<string, unknown> | null {
	const hostResult = plainObject(result);
	if (!hostResult || !Object.hasOwn(hostResult, 'integrationDiagnostics')) return null;
	const diagnostics = plainObject(hostResult.integrationDiagnostics);
	if (!diagnostics || !closed(diagnostics, DIAGNOSTIC_KEYS)) return null;
	if (diagnostics.schemaVersion !== INTEGRATION_DIAGNOSTICS_VERSION) return null;
	if (failingFloor(diagnostics.coverageFloor) === null) return null;
	if (failingFloor(diagnostics.contractDrift) === null) return null;
	if (cloneSignal(diagnostics.clones) === null) return null;
	return Object.freeze({ ...diagnostics });
}

export function classifyIntegrationDiagnostics(diagnostics: unknown): ClassifiedIntegrationDiagnostics {
	const hostResult = diagnostics ? { integrationDiagnostics: diagnostics } : null;
	const valid = validIntegrationDiagnostics(hostResult);
	if (!valid) return Object.freeze({ category: 'unclassified', targetPaths: Object.freeze([]) });
	const coverage = failingFloor(valid.coverageFloor);
	if (Array.isArray(coverage)) {
		return Object.freeze({ category: 'coverage_floor_regression', targetPaths: coverage });
	}
	const contract = failingFloor(valid.contractDrift);
	if (Array.isArray(contract)) {
		return Object.freeze({ category: 'contract_drift', targetPaths: contract });
	}
	const clone = cloneSignal(valid.clones);
	if (clone && typeof clone === 'object') {
		return Object.freeze({
			category: clone.kind === 'shift' ? 'baseline_clone_line_shift' : 'quality_regression',
			targetPaths: Object.freeze([clone.path]),
		});
	}
	return Object.freeze({ category: 'unclassified', targetPaths: Object.freeze([]) });
}
