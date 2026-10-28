import fs from 'node:fs';
import path from 'node:path';
import {
	HOST_PROFILE_RELATIVE_PATH,
	HOST_PROFILE_SCHEMA_VERSION,
	loadHostProfile,
} from '../host/host-profile.ts';
import { validateRunId } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';

export function resolveRepositoryRoot(
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): string {
	const explicitRoot = env.AGENT_SDLC_REPO_ROOT?.trim();
	if (explicitRoot) return path.resolve(explicitRoot);

	const resolvedCwd = path.resolve(cwd);
	const nodeModulesSegment = `${path.sep}node_modules`;
	const nmIndex = resolvedCwd.indexOf(nodeModulesSegment);
	const startDir =
		nmIndex >= 0 ? path.resolve(resolvedCwd.slice(0, nmIndex) || path.sep) : resolvedCwd;

	let current = startDir;
	while (true) {
		if (!current.split(path.sep).includes('node_modules')) {
			if (
				fs.existsSync(path.join(current, '.agents/sdlc-host.json')) ||
				fs.existsSync(path.join(current, '.git'))
			) {
				return current;
			}
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return startDir;
}

export const REPOSITORY_ROOT = resolveRepositoryRoot();

export interface RunDatabaseEntry {
	runId: string;
	runDir: string;
	databasePath: string;
	archived: boolean;
}

export type RunPaths = ResolvedRunPaths;

export interface ResolvedRunPaths {
	rootDir: string;
	runId: string;
	runsRoot: string;
	runtimeRoot: string;
	runDir: string;
	runtimeDir: string;
	databasePath: string;
	artifactsDir: string;
	statusPath: string;
	intentPath: string;
	decisionsPath: string;
}

function errnoCode(error: unknown): string | undefined {
	if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
		return error.code;
	}
	return undefined;
}

export function liveRunRoot(rootDir = REPOSITORY_ROOT): string {
	const profilePath = path.join(path.resolve(rootDir), HOST_PROFILE_RELATIVE_PATH);
	if (fs.existsSync(profilePath)) {
		const profile = loadHostProfile(rootDir);
		return path.join(rootDir, profile.stateDir);
	}
	return path.join(rootDir, 'tools/.agent-sdlc');
}

export function runsRootDir(rootDir = REPOSITORY_ROOT): string {
	const profilePath = path.join(path.resolve(rootDir), HOST_PROFILE_RELATIVE_PATH);
	if (fs.existsSync(profilePath)) {
		const profile = loadHostProfile(rootDir);
		if (profile.runsDir) {
			return path.join(rootDir, profile.runsDir);
		}
		if (profile.schemaVersion === HOST_PROFILE_SCHEMA_VERSION) {
			return path.join(rootDir, profile.stateDir);
		}
	}
	return path.join(rootDir, 'docs/specs/runs');
}

export function archiveRoot(rootDir = REPOSITORY_ROOT): string {
	return path.join(liveRunRoot(rootDir), '.archive');
}

export function archivedRunRelativePath(runId: string): string {
	return path.posix.join('tools/.agent-sdlc', '.archive', runId);
}

export function listRunDatabases(rootDir = REPOSITORY_ROOT): Readonly<RunDatabaseEntry>[] {
	const results: Readonly<RunDatabaseEntry>[] = [];
	const seen = new Set<string>();
	const roots = [
		{ dir: liveRunRoot(rootDir), archived: false },
		{ dir: archiveRoot(rootDir), archived: true },
	];
	for (const { dir, archived } of roots) {
		if (!fs.existsSync(dir)) continue;
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(dir);
		} catch {
			continue;
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
		const entries = fs
			.readdirSync(dir, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() &&
					!entry.isSymbolicLink() &&
					!entry.name.startsWith('.') &&
					entry.name !== 'test-fixtures' &&
					!entry.name.endsWith('.partial'),
			)
			.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (seen.has(entry.name)) continue;
			const runDir = path.join(dir, entry.name);
			const databasePath = path.join(runDir, 'runtime.sqlite');
			try {
				const dbStat = fs.lstatSync(databasePath);
				if (!dbStat.isFile() || dbStat.isSymbolicLink()) continue;
			} catch {
				continue;
			}
			seen.add(entry.name);
			results.push(
				Object.freeze({
					runId: entry.name,
					runDir,
					databasePath,
					archived,
				}),
			);
		}
	}
	return results;
}

export function assertDirectChild(
	basePath: string,
	candidatePath: string,
	{ mustExist = true }: { mustExist?: boolean } = {},
): string {
	const base = fs.realpathSync(basePath);
	const resolved = path.resolve(candidatePath);
	let candidate: string;
	if (mustExist) {
		try {
			candidate = fs.realpathSync(resolved);
		} catch (error: unknown) {
			throw new SdlcError(
				'RUN_NOT_FOUND',
				`Path does not exist: ${resolved}`,
				{},
				{ cause: error },
			);
		}
	} else {
		const parent = fs.realpathSync(path.dirname(resolved));
		candidate = path.join(parent, path.basename(resolved));
	}
	if (path.dirname(candidate) !== base) {
		throw new SdlcError('PATH_OUTSIDE_ROOT', `Path must be a direct child of ${base}`);
	}
	return candidate;
}

export function resolveRunPaths(
	runId: string,
	rootDir = REPOSITORY_ROOT,
	{ mustExist = true }: { mustExist?: boolean } = {},
): Readonly<ResolvedRunPaths> {
	validateRunId(runId);
	const runsRoot = runsRootDir(rootDir);
	const runtimeRoot = liveRunRoot(rootDir);
	if (!fs.existsSync(runsRoot)) {
		throw new SdlcError('RUN_NOT_FOUND', `Run root is missing: ${runsRoot}`);
	}
	if (!fs.existsSync(runtimeRoot)) fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
	const runDir = assertDirectChild(runsRoot, path.join(runsRoot, runId), {
		mustExist,
	});
	const runtimeDir = assertDirectChild(runtimeRoot, path.join(runtimeRoot, runId), { mustExist });
	if (path.basename(runDir) !== path.basename(runtimeDir)) {
		throw new SdlcError('STORE_RECONCILIATION_FAILED', 'Run and runtime directory IDs differ');
	}
	return Object.freeze({
		rootDir,
		runId,
		runsRoot: fs.realpathSync(runsRoot),
		runtimeRoot: fs.realpathSync(runtimeRoot),
		runDir,
		runtimeDir,
		databasePath: path.join(runtimeDir, 'runtime.sqlite'),
		artifactsDir: path.join(runtimeDir, 'artifacts'),
		statusPath: path.join(runDir, 'status.json'),
		intentPath: path.join(runDir, 'intent.md'),
		decisionsPath: path.join(runDir, 'decisions.md'),
	});
}

export function createRuntimeDirectory(runId: string, rootDir = REPOSITORY_ROOT): string {
	validateRunId(runId);
	const runtimeRoot = liveRunRoot(rootDir);
	fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
	const runtimeDir = assertDirectChild(runtimeRoot, path.join(runtimeRoot, runId), {
		mustExist: false,
	});
	try {
		fs.mkdirSync(runtimeDir, { mode: 0o700 });
	} catch (error: unknown) {
		if (errnoCode(error) === 'EEXIST') {
			throw new SdlcError('RUN_ALREADY_EXISTS', `Runtime already exists for ${runId}`);
		}
		throw new SdlcError(
			'INTERNAL_ERROR',
			`Cannot create runtime for ${runId}`,
			{},
			{ cause: error },
		);
	}
	return runtimeDir;
}

export function listContainedRunIds(rootDir = REPOSITORY_ROOT): string[] {
	const runsRoot = runsRootDir(rootDir);
	const runtimeRoot = liveRunRoot(rootDir);
	if (!fs.existsSync(runsRoot) || !fs.existsSync(runtimeRoot)) return [];
	const runtimeIds = new Set(
		fs
			.readdirSync(runtimeRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
			.map((entry) => entry.name),
	);
	return fs
		.readdirSync(runsRoot, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isDirectory() &&
				!entry.isSymbolicLink() &&
				entry.name !== '_example' &&
				runtimeIds.has(entry.name),
		)
		.map((entry) => entry.name)
		.filter((runId) => {
			try {
				validateRunId(runId);
				resolveRunPaths(runId, rootDir);
				return true;
			} catch {
				return false;
			}
		})
		.sort();
}

export function resolveExportPath(
	destination: string | undefined,
	runId: string,
	rootDir = REPOSITORY_ROOT,
): string {
	const runtimeRootPath = path.resolve(liveRunRoot(rootDir));
	const defaultDir = path.join(runtimeRootPath, runId, 'exports');
	const raw = destination ?? path.join(defaultDir, 'snapshot.json');
	const resolved = path.resolve(rootDir, raw);
	const parent = path.dirname(resolved);
	const runsRootPath = path.resolve(runsRootDir(rootDir));
	const externalAbsolute = destination !== undefined && path.isAbsolute(destination);
	const lexicallyWithin = (base: string): boolean => resolved.startsWith(`${base}${path.sep}`);
	if (!externalAbsolute && !lexicallyWithin(runsRootPath) && !lexicallyWithin(runtimeRootPath)) {
		throw new SdlcError(
			'PATH_OUTSIDE_ROOT',
			'Relative export destinations must stay under docs/specs/runs or tools/.agent-sdlc',
		);
	}
	const existingAncestor = nearestExistingAncestorWithoutSymlinks(parent);
	const runsRoot = fs.realpathSync(runsRootPath);
	const runtimeRoot = fs.realpathSync(runtimeRootPath);
	const isWithin = (base: string, candidate: string): boolean =>
		candidate === base || candidate.startsWith(`${base}${path.sep}`);
	if (
		!externalAbsolute &&
		!isWithin(runsRoot, existingAncestor) &&
		!isWithin(runtimeRoot, existingAncestor)
	) {
		throw new SdlcError(
			'PATH_OUTSIDE_ROOT',
			'Relative export destination ancestor escapes allowed roots',
		);
	}
	fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
	nearestExistingAncestorWithoutSymlinks(parent);
	const realParent = fs.realpathSync(parent);
	if (!externalAbsolute && !isWithin(runsRoot, realParent) && !isWithin(runtimeRoot, realParent)) {
		throw new SdlcError(
			'PATH_OUTSIDE_ROOT',
			'Relative export destinations must stay under docs/specs/runs or tools/.agent-sdlc',
		);
	}
	if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
		throw new SdlcError('PATH_OUTSIDE_ROOT', 'Export destination cannot be a symbolic link');
	}
	return path.join(realParent, path.basename(resolved));
}

function nearestExistingAncestorWithoutSymlinks(candidatePath: string): string {
	const absolute = path.resolve(candidatePath);
	const parsed = path.parse(absolute);
	let current = parsed.root;
	for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		const next = path.join(current, segment);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(next);
		} catch (error: unknown) {
			if (errnoCode(error) === 'ENOENT') break;
			throw new SdlcError(
				'INTERNAL_ERROR',
				`Cannot inspect export path: ${next}`,
				{},
				{
					cause: error,
				},
			);
		}
		if (stat.isSymbolicLink()) {
			throw new SdlcError(
				'PATH_OUTSIDE_ROOT',
				`Export path contains symbolic link component: ${next}`,
			);
		}
		if (!stat.isDirectory()) {
			throw new SdlcError('INVALID_INPUT', `Export parent component is not a directory: ${next}`);
		}
		current = next;
	}
	return fs.realpathSync(current);
}
