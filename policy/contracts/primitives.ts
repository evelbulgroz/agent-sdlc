import crypto from 'node:crypto';
import { SdlcError } from '../errors.ts';

export const RUNTIME_SCHEMA_VERSION = '1.0.0';

export const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,191}$/;

export const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-(?!_example$)[a-z0-9][a-z0-9-]{0,95}$/;

export const HASH_PATTERN = /^[a-f0-9]{64}$/;

export const GIT_SHA = /^[a-f0-9]{40}$/;

export function normalizeText(value: string): string;
export function normalizeText<T>(value: T): T;
export function normalizeText(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	return value.replace(/\r\n?/g, '\n').normalize('NFC');
}

export function normalizedValue(value: unknown): unknown {
	if (value === undefined) return undefined;
	if (typeof value === 'string') return normalizeText(value);
	if (Array.isArray(value)) return value.map((item) => normalizedValue(item));
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const output: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			const child = normalizedValue(record[key]);
			if (child !== undefined) output[key] = child;
		}
		return output;
	}
	return value;
}

export function canonicalJson(value: unknown): string {
	const normalized = normalizedValue(value);
	if (normalized === undefined) return 'null';
	if (normalized === null || typeof normalized !== 'object') return JSON.stringify(normalized);
	if (Array.isArray(normalized)) {
		return `[${normalized.map((item) => canonicalJson(item)).join(',')}]`;
	}
	const record = normalized as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(',')}}`;
}

export function sha256(value: unknown): string {
	const input = typeof value === 'string' ? normalizeText(value) : canonicalJson(value);
	return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export function failContract(message: string, metadata: Record<string, unknown> = {}): never {
	throw new SdlcError('INVALID_CONTRACT', message, metadata);
}

export function assertContractObject(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		failContract(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

export function assertClosedContract(
	value: unknown,
	keys: readonly string[],
	name: string,
): asserts value is Record<string, unknown> {
	const record = assertContractObject(value, name);
	for (const key of Object.keys(record)) {
		if (!keys.includes(key)) failContract(`${name} contains unknown field '${key}'`);
	}
}

export function contractNonEmptyString(value: unknown, name: string, maxBytes = 65_536): string {
	if (typeof value !== 'string' || normalizeText(value).trim().length === 0) {
		failContract(`${name} must be a non-empty string`);
	}
	if (Buffer.byteLength(value, 'utf8') > maxBytes) failContract(`${name} exceeds ${maxBytes} bytes`);
	return normalizeText(value).trim();
}

export function contractOptionalHash(value: unknown, name: string): string | null {
	if (value !== null && (typeof value !== 'string' || !HASH_PATTERN.test(value))) {
		failContract(`${name} must be null or a SHA-256 hash`);
	}
	return value;
}

export function contractStringArray(
	value: unknown,
	name: string,
	{ allowEmpty = true, maxItems = 64 }: { allowEmpty?: boolean; maxItems?: number } = {},
): string[] {
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maxItems) {
		failContract(`${name} must be an array with at most ${maxItems} items`);
	}
	const output = value.map((item, index) => contractNonEmptyString(item, `${name}[${index}]`, 16_384));
	if (new Set(output).size !== output.length) failContract(`${name} contains duplicate values`);
	return output;
}

export function validateRunId(value: unknown): string {
	if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value) || value === '_example') {
		failContract('runId must use YYYY-MM-DD-kebab-case format');
	}
	return value;
}

export function validateOpaqueId(value: unknown, name = 'id'): string {
	if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) failContract(`${name} is invalid`);
	return value;
}
