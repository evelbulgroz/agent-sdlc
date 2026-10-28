import fs from 'node:fs';
import path from 'node:path';

const SELF_PARENT = path.resolve(import.meta.dirname, '..');
export const AGENT_SDLC_PACKAGE_ROOT =
	path.basename(SELF_PARENT) === 'dist'
		? path.resolve(SELF_PARENT, '..')
		: SELF_PARENT;

const FIXED_PLANNING_FILES = [
	'packages/agent-sdlc/policy/task-planner.ts',
	'packages/agent-sdlc/policy/policy-gate.ts',
	'packages/agent-sdlc/execution/task-executor.ts',
	'packages/agent-sdlc/policy/contracts.ts',
];

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
	if (!fs.existsSync(path.join(rootDir, 'packages/agent-sdlc'))) {
		return listPackageBoundedPlanningFiles();
	}
	const found = new Set<string>(FIXED_PLANNING_FILES);
	rememberProduction(rootDir, 'packages/agent-sdlc/policy/contracts', '', found);
	rememberProduction(rootDir, 'packages/agent-sdlc/policy/task-planner', '', found);
	const executionDir = path.join(rootDir, 'packages/agent-sdlc/execution');
	if (fs.existsSync(executionDir)) {
		for (const entry of fs.readdirSync(executionDir, { withFileTypes: true })) {
			if (entry.isSymbolicLink() || !entry.isFile()) continue;
			if (!/^task-.*\.ts$/.test(entry.name)) continue;
			if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.d.ts')) continue;
			found.add(`packages/agent-sdlc/execution/${entry.name}`);
		}
	}
	return [...found].sort();
}

export function listPackageBoundedPlanningFiles(): string[] {
	const found = new Set<string>(FIXED_PLANNING_FILES);
	const baseDir = fs.existsSync(path.join(AGENT_SDLC_PACKAGE_ROOT, 'policy'))
		? AGENT_SDLC_PACKAGE_ROOT
		: path.join(AGENT_SDLC_PACKAGE_ROOT, 'dist');
	rememberProduction(baseDir, 'policy/contracts', 'packages/agent-sdlc', found);
	rememberProduction(baseDir, 'policy/task-planner', 'packages/agent-sdlc', found);
	const executionDir = path.join(baseDir, 'execution');
	if (fs.existsSync(executionDir)) {
		for (const entry of fs.readdirSync(executionDir, { withFileTypes: true })) {
			if (entry.isSymbolicLink() || !entry.isFile()) continue;
			if (!/^task-.*\.(?:ts|js)$/.test(entry.name)) continue;
			if (entry.name.endsWith('.spec.ts') || entry.name.endsWith('.d.ts')) continue;
			const tsName = entry.name.endsWith('.js')
				? `${entry.name.slice(0, -3)}.ts`
				: entry.name;
			found.add(`packages/agent-sdlc/execution/${tsName}`);
		}
	}
	return [...found].sort();
}

export function resolveBoundedPlanningFilePath(
	rootDir: string,
	logicalPath: string,
): string {
	if (fs.existsSync(path.join(rootDir, 'packages/agent-sdlc'))) {
		return path.join(rootDir, logicalPath);
	}
	const innerRel = logicalPath.replace(/^packages\/agent-sdlc\//, '');
	const tsCandidate = path.join(AGENT_SDLC_PACKAGE_ROOT, innerRel);
	if (fs.existsSync(tsCandidate)) return tsCandidate;
	const jsRel = innerRel.endsWith('.ts') ? `${innerRel.slice(0, -3)}.js` : innerRel;
	const distCandidate = path.join(AGENT_SDLC_PACKAGE_ROOT, 'dist', jsRel);
	if (fs.existsSync(distCandidate)) return distCandidate;
	return tsCandidate;
}
