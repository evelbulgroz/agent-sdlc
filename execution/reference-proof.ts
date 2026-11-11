// Token-free proof that a deletion or private-method removal has no static references.
import fs from 'node:fs';
import path from 'node:path';
import { SdlcError } from '../policy/errors.ts';
import {
	readStaticImportGraph,
	resolvedImporters,
	specifierNamesSource,
	type StaticImportGraph,
} from '../policy/static-import-graph.ts';

export interface MethodRemoval {
	readonly file: string;
	readonly name: string;
}

export interface ReferenceProofResult {
	readonly schemaVersion: '1';
	readonly pass: boolean;
	readonly reasons: readonly string[];
}

export function proveReferences({
	rootDir,
	roots = [],
	deletedPaths = [],
	methodRemovals = [],
}: {
	rootDir?: string | null;
	roots?: readonly string[] | null;
	deletedPaths?: readonly string[] | null;
	methodRemovals?: readonly MethodRemoval[] | null;
} = {}): ReferenceProofResult {
	const deleted = normalizePaths(deletedPaths);
	const methods = Array.isArray(methodRemovals) ? methodRemovals : [];
	if (!rootDir || !fs.existsSync(rootDir)) return proof(false, ['unreadable root']);
	if ((deleted.length > 0 || methods.length > 0) && (!Array.isArray(roots) || roots.length === 0)) {
		return proof(false, ['missing roots']);
	}
	const graph = readStaticImportGraph({
		rootDir,
		roots: roots ?? [],
		extraNamedFiles: deleted,
	});
	const reasons: string[] = [];
	const sources = readSources(rootDir, graph);
	for (const deletedPath of deleted) {
		for (const importer of resolvedImporters(graph, deletedPath)) {
			reasons.push(`importer ${importer} ${deletedPath}`);
		}
		for (const hit of graph.unresolved) {
			if (hit.file === deletedPath) continue;
			if (hit.reason === 'non_literal') reasons.push(`non_literal ${hit.file}`);
			else if (hit.reason === 'non_relative' && hit.specifier && specifierNamesSource(hit.specifier, deletedPath)) {
				reasons.push(`${hit.reason} ${hit.file}`);
			} else if (namesDeleted(hit.specifier, deletedPath)) reasons.push(`${hit.reason} ${hit.file}`);
		}
		const decorator = decoratorName(deletedPath);
		for (const file of graph.files) {
			if (file === deletedPath) continue;
			const source = sources.get(file);
			if (source === undefined) {
				reasons.push(`unreadable ${file}`);
				continue;
			}
			if (quotedMentions(source, deletedPath)) reasons.push(`string token ${file}`);
			if (decorator && new RegExp(`@${decorator}\\b`).test(source)) reasons.push(`decorator ${file}`);
		}
	}
	for (const method of methods) {
		if (!method || typeof method.file !== 'string' || typeof method.name !== 'string' || !method.name) {
			reasons.push('invalid method removal');
			continue;
		}
		if (!graph.files.includes(method.file)) {
			reasons.push(`method file missing ${method.file}`);
			continue;
		}
		const own = sources.get(method.file) ?? '';
		if (isExported(own, method.name)) reasons.push(`exported ${method.name}`);
		for (const [file, source] of sources) {
			if (identifierCount(source, method.name) > 0) reasons.push(`reference ${file} ${method.name}`);
		}
	}
	return proof(reasons.length === 0, reasons);
}

export function requireDeletionProof(input: {
	rootDir?: string | null;
	roots?: readonly string[] | null;
	deletedPaths?: readonly string[] | null;
	methodRemovals?: readonly MethodRemoval[] | null;
}): ReferenceProofResult {
	const result = proveReferences(input);
	if (!result.pass) {
		throw new SdlcError('POLICY_VIOLATION', `Reference proof failed: ${result.reasons[0] ?? 'references remain'}`);
	}
	return result;
}

export function requireStoredProof(artifact: unknown): void {
	if (typeof artifact !== 'string' || artifact.length === 0) {
		throw new SdlcError('INVALID_CONTRACT', 'Reference proof artifact is required');
	}
}

export function deletedPathsBetween(
	gitCli: (command: string, args: readonly string[], options?: Record<string, unknown>) => unknown,
	rootDir: string,
	before: string | null | undefined,
	after: string | null | undefined,
): string[] {
	if (!before || !after || before === after) return [];
	let text = '';
	try {
		text = String(gitCli('git', ['diff-tree', '--diff-filter=D', '--name-only', '-r', before, after], {
			cwd: rootDir,
			encoding: 'utf8',
		}) ?? '');
	} catch {
		return [];
	}
	return text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0 && !line.includes(' '));
}

export function removePrivateMethod(source: string, name: string): string {
	if (!/^[A-Za-z_$][\w$]*$/.test(name) || isExported(source, name)) return source;
	const start = source.search(new RegExp(`\\bprivate\\s+${name}\\s*\\(`));
	if (start < 0) return source;
	const brace = source.indexOf('{', start);
	if (brace < 0) return source;
	let depth = 0;
	for (let index = brace; index < source.length; index += 1) {
		if (source[index] === '{') depth += 1;
		else if (source[index] === '}') {
			depth -= 1;
			if (depth === 0) {
				const lineStart = source.lastIndexOf('\n', start) + 1;
				return `${source.slice(0, lineStart)}${source.slice(index + 1)}`;
			}
		}
	}
	return source;
}

function proof(pass: boolean, reasons: readonly string[]): ReferenceProofResult {
	return Object.freeze({
		schemaVersion: '1',
		pass,
		reasons: Object.freeze([...reasons]),
	});
}

function normalizePaths(paths: readonly string[] | null | undefined): string[] {
	if (!Array.isArray(paths)) return [];
	return paths.filter((item): item is string => typeof item === 'string' && item.length > 0)
		.map((item) => item.replaceAll('\\', '/').replace(/^\.\//, ''));
}

function readSources(rootDir: string, graph: StaticImportGraph): Map<string, string> {
	const sources = new Map<string, string>();
	for (const file of graph.files) {
		try {
			sources.set(file, fs.readFileSync(path.join(rootDir, file), 'utf8'));
		} catch {
			sources.delete(file);
		}
	}
	return sources;
}

function namesDeleted(specifier: string | null, deleted: string): boolean {
	if (!specifier) return false;
	const norm = specifier.replaceAll('\\', '/');
	const base = path.posix.basename(deleted);
	return norm === deleted || norm.endsWith(`/${base}`) || norm === `./${base}` || norm === base;
}

function decoratorName(filePath: string): string {
	const base = path.posix.basename(filePath).replace(/\.[^.]+$/, '');
	return base.split(/[^A-Za-z0-9]+/).filter(Boolean)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join('');
}

function quotedMentions(source: string, deleted: string): boolean {
	const base = path.posix.basename(deleted);
	const pattern = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
	for (const match of source.matchAll(pattern)) {
		const value = match[2]?.replaceAll('\\', '/') ?? '';
		if (value === deleted || value.endsWith(`/${base}`) || value === `./${base}` || value === base) return true;
	}
	return false;
}

function isExported(source: string, name: string): boolean {
	if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false;
	const pattern = new RegExp(
		`(?:export\\s+(?:async\\s+)?(?:function|class|const|let|var|type|interface|enum)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b)`,
	);
	return pattern.test(source);
}

function identifierCount(source: string, name: string): number {
	if (!/^[A-Za-z_$][\w$]*$/.test(name)) return 1;
	return source.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0;
}
