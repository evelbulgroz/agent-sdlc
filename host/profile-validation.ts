import fs from 'node:fs';
import path from 'node:path';
import { SdlcError } from '../policy/errors.ts';

export function invalidHostProfile(detail: string, metadata: Record<string, unknown> = {}, cause?: unknown): never {
	throw new SdlcError('INVALID_INPUT', `HOST_PROFILE_INVALID: ${detail}`, metadata, cause !== undefined ? { cause } : {});
}

export function validateContainedRelativePath(
	rootDir: string,
	candidate: string,
	fieldName: string,
	{ allowDot = false }: { allowDot?: boolean } = {},
): string {
	if (typeof candidate !== 'string' || candidate.length === 0) {
		invalidHostProfile(`${fieldName} must be a non-empty relative path`, { fieldName });
	}
	if (
		candidate.startsWith('/') ||
		candidate.startsWith('\\') ||
		candidate.includes('\\') ||
		path.posix.isAbsolute(candidate) ||
		path.isAbsolute(candidate)
	) {
		invalidHostProfile(`${fieldName} '${candidate}' must be a relative path`, { fieldName, candidate });
	}
	if (candidate === '.') {
		if (!allowDot) invalidHostProfile(`${fieldName} cannot be '.'`, { fieldName, candidate });
	} else if (candidate.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
		invalidHostProfile(`${fieldName} '${candidate}' contains an invalid path segment`, { fieldName, candidate });
	}

	const resolvedRoot = path.resolve(rootDir);
	const resolvedCandidate = path.resolve(resolvedRoot, candidate);
	const lexicallyInside = allowDot
		? resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
		: resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
	if (!lexicallyInside) {
		invalidHostProfile(`${fieldName} '${candidate}' resolves outside rootDir`, { fieldName, candidate });
	}

	if (fs.existsSync(resolvedRoot)) {
		const realRoot = fs.realpathSync(resolvedRoot);
		let current = resolvedRoot;
		for (const segment of candidate === '.' ? [] : candidate.split('/')) {
			const next = path.join(current, segment);
			if (!fs.existsSync(next)) break;
			const realNext = fs.realpathSync(next);
			if (realNext !== realRoot && !realNext.startsWith(`${realRoot}${path.sep}`)) {
				invalidHostProfile(`${fieldName} '${candidate}' escapes rootDir via symlink`, { fieldName, candidate });
			}
			current = next;
		}
	}
	return candidate;
}

export function validateRegexPattern(pattern: string, fieldName: string): void {
	try {
		new RegExp(pattern);
	} catch (error: unknown) {
		invalidHostProfile(`${fieldName} '${pattern}' is not a valid regular expression`, { fieldName, pattern }, error);
	}
}
