import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './contracts.ts';

export interface ContinuationPolicyRecord {
	attempts?: number;
	policyFingerprint?: string | null;
	updatedAt?: string | null;
}

/**
 * Canonical fingerprint of the lower-only local policy file.
 * A missing file is a stable fingerprint. Key order does not change the hash.
 * Invalid JSON is hashed as raw text so a later correction still counts as a change.
 */
export function resolveLocalPolicyPath(
	rootDir: string,
	localPolicyPath: string | null = null,
): string {
	if (typeof localPolicyPath === 'string' && localPolicyPath.length > 0) {
		return path.resolve(localPolicyPath);
	}
	const sdlcDirCandidate = path.join(rootDir, '.agent-sdlc', 'local-policy.json');
	const toolsDirCandidate = path.join(rootDir, 'tools', '.model-usage', 'local-policy.json');
	if (fs.existsSync(sdlcDirCandidate) && !fs.existsSync(toolsDirCandidate)) {
		return sdlcDirCandidate;
	}
	return toolsDirCandidate;
}

export function localPolicyFingerprint(
	rootDir: string,
	localPolicyPath: string | null = null,
): string {
	const file = resolveLocalPolicyPath(rootDir, localPolicyPath);
	if (!fs.existsSync(file)) return sha256('absent');
	const raw = fs.readFileSync(file, 'utf8');
	try {
		return sha256(JSON.parse(raw));
	} catch {
		return sha256(`raw:${raw}`);
	}
}

function localPolicyMtimeMs(file: string): number | null {
	try {
		const stat = fs.statSync(file);
		return stat.isFile() ? stat.mtimeMs : null;
	} catch {
		return null;
	}
}

/**
 * Stored fingerprints compare canonical content.
 * A legacy row with no fingerprint treats a file written after the attempt
 * as a new condition. A missing file does not.
 */
export function localPolicyChanged(
	record: ContinuationPolicyRecord | null | undefined,
	rootDir: string,
	localPolicyPath: string | null = null,
): boolean {
	if (!record || !((record.attempts ?? 0) > 0)) return false;
	const current = localPolicyFingerprint(rootDir, localPolicyPath);
	if (typeof record.policyFingerprint === 'string' && record.policyFingerprint.length > 0) {
		return record.policyFingerprint !== current;
	}
	const mtime = localPolicyMtimeMs(resolveLocalPolicyPath(rootDir, localPolicyPath));
	const updated = Date.parse(record.updatedAt ?? '');
	return mtime !== null && Number.isFinite(updated) && mtime > updated;
}

export function effectiveContinuationAttempts(
	record: ContinuationPolicyRecord | null | undefined,
	rootDir: string,
	localPolicyPath: string | null = null,
): number {
	if (!record) return 0;
	if (localPolicyChanged(record, rootDir, localPolicyPath)) return 0;
	return record.attempts ?? 0;
}
