import fs from 'node:fs';
import path from 'node:path';
import { loadHostProfileOrFallback } from '../host/host-profile.ts';

const SELF_PARENT = path.resolve(import.meta.dirname, '..');
export const AGENT_SDLC_PACKAGE_ROOT =
	path.basename(SELF_PARENT) === 'dist'
		? path.resolve(SELF_PARENT, '..')
		: SELF_PARENT;

const FIXED_PLANNING_FILES = [
	'policy/task-planner.ts',
	'policy/policy-gate.ts',
	'execution/task-executor.ts',
	'policy/contracts.ts',
];

/** Directory of the engine inside the host repository, relative to the host root (`engine.selfRoot`, default `.`). */
export function engineSelfRoot(rootDir: string): string {
	const declared = loadHostProfileOrFallback(rootDir).engine?.selfRoot ?? '.';
	const clean = path.posix.normalize(declared.replaceAll('\\', '/')).replace(/\/+$/, '');
	return clean === '' ? '.' : clean;
}

function logicalPrefix(selfRoot: string): string {
	return selfRoot === '.' ? '' : selfRoot;
}

function logicalName(selfRoot: string, relative: string): string {
	const prefix = logicalPrefix(selfRoot);
	return prefix ? `${prefix}/${relative}` : relative;
}

function fixedPlanningFiles(selfRoot: string): string[] {
	return FIXED_PLANNING_FILES.map((relative) => logicalName(selfRoot, relative));
}

function rememberProduction(
	baseDir: string,
	relativeDir: string,
	logicalPrefix: string,
	found: Set<string>,
): void {
	const absolute = path.join(baseDir, relativeDir);
	if (!fs.existsSync(absolute)) return;
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.js')) continue;
			if (
				entry.name.endsWith('.spec.ts') ||
				entry.name.endsWith('.spec.js') ||
				entry.name.endsWith('.d.ts')
			) {
				continue;
			}
			const rel = path.relative(baseDir, full).split(path.sep).join('/');
			const normalizedRel = rel.endsWith('.js') ? `${rel.slice(0, -3)}.ts` : rel;
			found.add(
				logicalPrefix ? `${logicalPrefix}/${normalizedRel}` : normalizedRel,
			);
		}
	};
	walk(absolute);
}

export function listBoundedPlanningFiles(rootDir: string): string[] {
	const selfRoot = engineSelfRoot(rootDir);
	if (!hostEmbedsEngine(rootDir, selfRoot)) return listPackageBoundedPlanningFiles(selfRoot);
	return collectPlanningFiles(path.join(rootDir, selfRoot), logicalPrefix(selfRoot), /^task-.*\.ts$/, selfRoot);
}

function hostEmbedsEngine(rootDir: string, selfRoot: string): boolean {
	const engineDir = path.join(rootDir, selfRoot);
	return (
		fs.existsSync(path.join(engineDir, 'policy/task-planner.ts')) ||
		(selfRoot !== '.' && fs.existsSync(engineDir))
	);
}

function collectPlanningFiles(
	baseDir: string,
	prefix: string,
	executionPattern: RegExp,
	selfRoot: string,
): string[] {
	const found = new Set<string>(fixedPlanningFiles(selfRoot));
	rememberProduction(baseDir, 'policy/contracts', prefix, found);
	rememberProduction(baseDir, 'policy/task-planner', prefix, found);
	const executionDir = path.join(baseDir, 'execution');
	if (fs.existsSync(executionDir)) {
		for (const entry of fs.readdirSync(executionDir, { withFileTypes: true })) {
			if (entry.isSymbolicLink() || !entry.isFile()) continue;
			if (!executionPattern.test(entry.name)) continue;
			if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.d.ts')) continue;
			const tsName = entry.name.endsWith('.js') ? `${entry.name.slice(0, -3)}.ts` : entry.name;
			found.add(logicalName(selfRoot, `execution/${tsName}`));
		}
	}
	return [...found].sort();
}

export function listPackageBoundedPlanningFiles(selfRoot = '.'): string[] {
	const baseDir = fs.existsSync(path.join(AGENT_SDLC_PACKAGE_ROOT, 'policy'))
		? AGENT_SDLC_PACKAGE_ROOT
		: path.join(AGENT_SDLC_PACKAGE_ROOT, 'dist');
	return collectPlanningFiles(baseDir, logicalPrefix(selfRoot), /^task-.*\.(?:ts|js)$/, selfRoot);
}

export function resolveBoundedPlanningFilePath(
	rootDir: string,
	logicalPath: string,
): string {
	const selfRoot = engineSelfRoot(rootDir);
	const prefix = logicalPrefix(selfRoot);
	const innerRel = prefix && logicalPath.startsWith(`${prefix}/`) ? logicalPath.slice(prefix.length + 1) : logicalPath;
	const hostCandidate = path.join(rootDir, selfRoot, innerRel);
	if (hostEmbedsEngine(rootDir, selfRoot) || fs.existsSync(hostCandidate)) return hostCandidate;
	const tsCandidate = path.join(AGENT_SDLC_PACKAGE_ROOT, innerRel);
	if (fs.existsSync(tsCandidate)) return tsCandidate;
	const jsRel = innerRel.endsWith('.ts') ? `${innerRel.slice(0, -3)}.js` : innerRel;
	const distCandidate = path.join(AGENT_SDLC_PACKAGE_ROOT, 'dist', jsRel);
	if (fs.existsSync(distCandidate)) return distCandidate;
	return hostCandidate;
}
