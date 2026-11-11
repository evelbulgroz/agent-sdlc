// One static import walk. Relative import, export-from, and import('literal') only.

import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = Object.freeze([
	'.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx',
]);
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.git']);
const PACKAGE_SPECIFIER = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;

export interface ResolvedStaticImport {
	readonly importer: string;
	readonly specifier: string;
	readonly resolved: string;
}

export interface UnresolvedStaticImport {
	readonly file: string;
	readonly specifier: string | null;
	readonly reason: 'non_literal' | 'non_relative' | 'unresolved_relative';
}

export interface StaticImportGraph {
	readonly files: readonly string[];
	readonly imports: readonly ResolvedStaticImport[];
	readonly unresolved: readonly UnresolvedStaticImport[];
}

let scans = 0;

export function staticImportScanCount(): number {
	return scans;
}

export function readStaticImportGraph({
	rootDir,
	roots,
}: {
	rootDir: string;
	roots: readonly string[];
}): StaticImportGraph {
	scans += 1;
	const files = listSourceFiles(rootDir, Array.isArray(roots) ? roots : []);
	const imports: ResolvedStaticImport[] = [];
	const unresolved: UnresolvedStaticImport[] = [];
	for (const file of files) {
		let source = '';
		try {
			source = fs.readFileSync(path.join(rootDir, file), 'utf8');
		} catch {
			unresolved.push({ file, specifier: null, reason: 'unresolved_relative' });
			continue;
		}
		for (const hit of extractImportSpecifiers(source)) {
			if (hit.nonLiteral) {
				unresolved.push({ file, specifier: null, reason: 'non_literal' });
				continue;
			}
			const specifier = hit.specifier ?? '';
			if (specifier.startsWith('.')) {
				const resolved = resolveRelative(rootDir, file, specifier);
				if (!resolved) {
					unresolved.push({ file, specifier, reason: 'unresolved_relative' });
				} else {
					imports.push({ importer: file, specifier, resolved });
				}
				continue;
			}
			if (PACKAGE_SPECIFIER.test(specifier)) continue;
			unresolved.push({ file, specifier, reason: 'non_relative' });
		}
	}
	return Object.freeze({
		files: Object.freeze(files),
		imports: Object.freeze(imports),
		unresolved: Object.freeze(unresolved),
	});
}

export function resolvedImporters(graph: StaticImportGraph, target: string): readonly string[] {
	const norm = normalizeRel(target);
	return Object.freeze(
		[...new Set(graph.imports.filter((edge) => edge.resolved === norm).map((edge) => edge.importer))].sort(),
	);
}

function listSourceFiles(rootDir: string, roots: readonly string[]): string[] {
	const found: string[] = [];
	for (const root of roots) {
		const relRoot = normalizeRel(root);
		if (!relRoot || relRoot.startsWith('..')) continue;
		walk(path.join(rootDir, relRoot), relRoot, found);
	}
	return [...new Set(found)].sort();
}

function walk(absDir: string, relDir: string, found: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(absDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (SKIP_DIRECTORIES.has(entry.name)) continue;
		const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
		const abs = path.join(absDir, entry.name);
		if (entry.isDirectory()) {
			walk(abs, rel, found);
			continue;
		}
		if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.posix.extname(entry.name))) {
			found.push(rel);
		}
	}
}

function resolveRelative(rootDir: string, importer: string, specifier: string): string | null {
	const bare = specifier.split('?')[0]?.split('#')[0] ?? specifier;
	if (!bare.startsWith('.')) return null;
	const joined = path.posix.normalize(path.posix.join(path.posix.dirname(importer), bare));
	if (joined.startsWith('..') || joined === '') return null;
	for (const candidate of candidateFiles(joined)) {
		try {
			if (fs.statSync(path.join(rootDir, candidate)).isFile()) return candidate;
		} catch {
			// try the next candidate
		}
	}
	return null;
}

function candidateFiles(spec: string): string[] {
	const extension = path.posix.extname(spec);
	if (extension) {
		const swapped = extension === '.js' || extension === '.jsx' || extension === '.mjs' || extension === '.cjs'
			? `${spec.slice(0, -extension.length)}.ts`
			: spec;
		return swapped === spec ? [spec] : [spec, swapped];
	}
	const suffixed = SOURCE_EXTENSIONS.flatMap((ext) => [spec + ext, `${spec}/index${ext}`]);
	return suffixed;
}

interface SpecifierHit {
	specifier: string | null;
	nonLiteral: boolean;
}

function extractImportSpecifiers(source: string): SpecifierHit[] {
	const hits: SpecifierHit[] = [];
	const length = source.length;
	let index = 0;
	while (index < length) {
		const ch = source[index] ?? '';
		const next = source[index + 1] ?? '';
		if (ch === '/' && next === '/') {
			index = source.indexOf('\n', index);
			if (index < 0) break;
			continue;
		}
		if (ch === '/' && next === '*') {
			const end = source.indexOf('*/', index + 2);
			index = end < 0 ? length : end + 2;
			continue;
		}
		if (ch === '\'' || ch === '"' || ch === '`') {
			index = skipString(source, index);
			continue;
		}
		if (keywordAt(source, index, 'export')) {
			const ahead = source.slice(index, statementEnd(source, index + 'export'.length));
			if (!/\bfrom\s*['"]/.test(ahead)) {
				index += 'export'.length;
				continue;
			}
			index = readModuleStatement(source, index + 'export'.length, false, hits);
			continue;
		}
		if (keywordAt(source, index, 'import')) {
			index = readModuleStatement(source, index + 'import'.length, true, hits);
			continue;
		}
		index += 1;
	}
	return hits;
}

function readModuleStatement(
	source: string,
	index: number,
	isImport: boolean,
	hits: SpecifierHit[],
): number {
	let cursor = skipSpace(source, index);
	if (isImport && source[cursor] === '(') {
		return readDynamicImport(source, cursor, hits);
	}
	const end = statementEnd(source, cursor);
	const statement = source.slice(cursor, end);
	const from = /(?:^|\s)from\s*(['"])([^'"]+)\1/.exec(statement);
	if (from?.[2]) {
		hits.push({ specifier: from[2], nonLiteral: false });
	} else if (isImport) {
		const bare = /^\s*(['"])([^'"]+)\1/.exec(statement);
		if (bare?.[2]) hits.push({ specifier: bare[2], nonLiteral: false });
	}
	return end;
}

function readDynamicImport(source: string, open: number, hits: SpecifierHit[]): number {
	let cursor = skipSpace(source, open + 1);
	const quote = source[cursor] ?? '';
	if (quote === '\'' || quote === '"') {
		const end = skipString(source, cursor);
		hits.push({ specifier: source.slice(cursor + 1, end - 1), nonLiteral: false });
		return end;
	}
	if (quote === '`') {
		const end = skipString(source, cursor);
		const body = source.slice(cursor + 1, end - 1);
		hits.push(body.includes('${')
			? { specifier: null, nonLiteral: true }
			: { specifier: body, nonLiteral: false });
		return end;
	}
	hits.push({ specifier: null, nonLiteral: true });
	const close = source.indexOf(')', cursor);
	return close < 0 ? source.length : close + 1;
}

function statementEnd(source: string, start: number): number {
	let depth = 0;
	for (let index = start; index < source.length; index += 1) {
		const ch = source[index];
		if (ch === '\'' || ch === '"' || ch === '`') {
			index = skipString(source, index) - 1;
			continue;
		}
		if (ch === '(' || ch === '{' || ch === '[') depth += 1;
		else if (ch === ')' || ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
		else if (ch === ';' && depth === 0) return index + 1;
		else if (ch === '\n' && depth === 0 && statementComplete(source.slice(start, index))) return index;
	}
	return source.length;
}

function statementComplete(statement: string): boolean {
	return /(?:^|\s)from\s*['"][^'"]+['"]/.test(statement) || /^\s*['"][^'"]+['"]/.test(statement);
}

function skipString(source: string, start: number): number {
	const quote = source[start] ?? '';
	for (let index = start + 1; index < source.length; index += 1) {
		if (source[index] === '\\') {
			index += 1;
			continue;
		}
		if (source[index] === quote) return index + 1;
	}
	return source.length;
}

function skipSpace(source: string, index: number): number {
	let cursor = index;
	while (cursor < source.length && /\s/.test(source[cursor] ?? '')) cursor += 1;
	return cursor;
}

function keywordAt(source: string, index: number, word: string): boolean {
	if (!source.startsWith(word, index)) return false;
	const before = index === 0 ? '' : (source[index - 1] ?? '');
	const after = source[index + word.length] ?? '';
	return !/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after);
}

function normalizeRel(value: string): string {
	return value.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}
