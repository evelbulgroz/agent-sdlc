import fs from 'node:fs';
import path from 'node:path';
import { SdlcError } from '../policy/errors.ts';

export const FORBIDDEN_COMPONENTS: ReadonlySet<string> = new Set(['.git', '.agent-sdlc']);

function pathMatchesPrefix(candidate: string, prefix: string): boolean {
	const cleanCandidate = normalizeRelPath(candidate).replace(/\/+$/, '');
	const cleanPrefix = normalizeRelPath(prefix).replace(/\/+$/, '');
	return cleanCandidate === cleanPrefix || cleanCandidate.startsWith(`${cleanPrefix}/`);
}

export function assertModelMutationNotGenerated(
	targetPath: unknown,
	generatedPathPrefixes: readonly string[] = [],
): true {
	const targetStr = typeof targetPath === 'string' ? targetPath : String(targetPath ?? '');
	const generatedPrefix = generatedPathPrefixes.find((prefix) =>
		pathMatchesPrefix(targetStr, prefix),
	);
	if (generatedPrefix) {
		throw new SdlcError(
			'INVALID_INPUT',
			`Model mutation of generated output '${targetStr}' is forbidden; run the declared generator instead`,
			{ targetPath: targetStr, generatedPrefix },
		);
	}
	return true;
}

export function normalizeRelPath(rawPath: unknown): string {
	if (typeof rawPath !== 'string' || rawPath.length === 0) {
		throw new SdlcError('INVALID_INPUT', 'Path must be a non-empty string');
	}
	if (rawPath.includes('\0')) {
		throw new SdlcError('PATH_CONTAINMENT_VIOLATION', 'Path contains null bytes');
	}
	const trimmedPath = rawPath.trim();
	if (trimmedPath.length === 0) {
		throw new SdlcError('INVALID_INPUT', 'Path must contain non-whitespace characters');
	}
	const normalized = path.normalize(trimmedPath).split(path.sep).join('/');
	if (normalized.startsWith('../') || normalized === '..') {
		throw new SdlcError('PATH_CONTAINMENT_VIOLATION', `Path '${rawPath}' escapes worktree root`);
	}
	return normalized.replace(/^\.\//, '');
}

export function assertToolPathContained(
	worktreeDir: unknown,
	targetPath: unknown,
	allowedPathPrefixes: readonly string[] | null = null,
): string {
	if (!worktreeDir || typeof worktreeDir !== 'string') {
		throw new SdlcError('INVALID_INPUT', 'worktreeDir must be a non-empty string');
	}
	const resolvedBase = path.resolve(worktreeDir);
	const normalizedRel = normalizeRelPath(targetPath);

	const parts = normalizedRel.split('/');
	for (const part of parts) {
		if (FORBIDDEN_COMPONENTS.has(part)) {
			throw new SdlcError(
				'PATH_CONTAINMENT_VIOLATION',
				`Access to internal or VCS directory '${part}' is strictly forbidden`,
				{ worktreeDir, targetPath: String(targetPath), forbiddenComponent: part },
			);
		}
	}

	const resolvedTarget = path.resolve(resolvedBase, normalizedRel);
	if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
		throw new SdlcError(
			'PATH_CONTAINMENT_VIOLATION',
			`Path '${String(targetPath)}' escapes worktree root '${worktreeDir}'`,
			{ worktreeDir, targetPath: String(targetPath), resolvedTarget },
		);
	}

	// Verify realpath of existing ancestor to prevent symlink escapes
	let checkDir = resolvedTarget;
	while (!fs.existsSync(checkDir)) {
		const parent = path.dirname(checkDir);
		if (parent === checkDir) break;
		checkDir = parent;
	}

	if (fs.existsSync(checkDir)) {
		const realBase = fs.realpathSync(resolvedBase);
		const realAncestor = fs.realpathSync(checkDir);
		if (realAncestor !== realBase && !realAncestor.startsWith(realBase + path.sep)) {
			throw new SdlcError(
				'PATH_CONTAINMENT_VIOLATION',
				`Real path '${realAncestor}' escapes real worktree root '${realBase}'`,
				{ realBase, realAncestor },
			);
		}
	}

	// Check against allowed prefixes if provided
	if (Array.isArray(allowedPathPrefixes)) {
		const matchesPrefix = allowedPathPrefixes.some((prefix) => {
			const cleanPrefix = normalizeRelPath(prefix).replace(/\/+$/, '');
			return normalizedRel === cleanPrefix || normalizedRel.startsWith(cleanPrefix + '/');
		});

		if (!matchesPrefix) {
			throw new SdlcError(
				'PATH_CONTAINMENT_VIOLATION',
				`Path '${normalizedRel}' is not within authorized path prefixes: ${allowedPathPrefixes.join(', ')}`,
				{ normalizedRel, allowedPathPrefixes: [...allowedPathPrefixes] },
			);
		}
	}

	return resolvedTarget;
}

export function safeCanonicalPath(rawPath: unknown): string {
	try {
		return normalizeRelPath(rawPath);
	} catch {
		return typeof rawPath === 'string' ? rawPath.trim() : '';
	}
}
