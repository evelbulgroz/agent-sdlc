// Rejects secret-like evidence and closed-object shape errors without echoing the value.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SdlcError } from '../errors.ts';

const SENSITIVE_KEY =
	/^(?:rawPrompt|rawProviderResponse|prompt|response|secret|credential|apiKey)$/i;
const SECRET_LIKE =
	/(?:\bsk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export function assertSanitizedValue(value: unknown, key = ''): void {
	if (SENSITIVE_KEY.test(key))
		throw invalidContract(`Sensitive corpus key is forbidden: ${key}`);
	if (typeof value === 'string') {
		if (SECRET_LIKE.test(value)) {
			throw invalidContract(
				`Secret-like corpus value is forbidden at ${key || 'root'}`,
			);
		}
		if (value.length > 4096)
			throw invalidContract('Corpus string exceeds the bounded evidence limit');
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) assertSanitizedValue(item, key);
		return;
	}
	if (value && typeof value === 'object') {
		for (const [childKey, child] of Object.entries(value)) {
			assertSanitizedValue(child, childKey);
		}
	}
}

export function assertContainedFixturePath(candidate: unknown): void {
	if (typeof candidate !== 'string' || candidate.length === 0) {
		throw invalidContract('Corpus path must be a non-empty relative path');
	}
	if (path.isAbsolute(candidate))
		throw invalidContract('Corpus path must be relative');
	const normalized = path.posix.normalize(candidate.replaceAll('\\', '/'));
	if (normalized === '..' || normalized.startsWith('../')) {
		throw invalidContract('Corpus path traversal is forbidden');
	}
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), 'agent-sdlc-replay-check-'),
	);
	try {
		const resolved = path.resolve(root, normalized);
		if (!resolved.startsWith(`${root}${path.sep}`)) {
			throw invalidContract('Corpus path escapes the isolated replay root');
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

export function assertClosedObject(
	value: unknown,
	keys: readonly string[],
	name: string,
): asserts value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw invalidContract(`${name} must be an object`);
	}
	const allowed = new Set(keys);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key))
			throw invalidContract(`${name} contains unsupported key '${key}'`);
	}
	for (const key of keys) {
		if (!(key in value)) throw invalidContract(`${name}.${key} is required`);
	}
}

export function invalidContract(message: string, cause?: unknown): SdlcError {
	return new SdlcError('INVALID_CONTRACT', message, {}, cause ? { cause } : {});
}

export function redactEvidence(value: unknown): string {
	return String(value)
		.replace(SECRET_LIKE, '[REDACTED]')
		.replace(/(?:\/[^/\s]+){3,}/g, '[PATH]')
		.slice(0, 512);
}
