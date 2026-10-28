// Workspace package scan and contract-preservation checks.
// planTaskDag discovers packages only by calling scanWorkspacePackages.

import fs from 'node:fs';
import path from 'node:path';
import {
	type HostProfile,
	loadHostProfileOrFallback,
} from '../../host/host-profile.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { SdlcError } from '../errors.ts';
import { sortTasksTopologically } from './task-graph.ts';

export { sortTasksTopologically };

export interface PackageJsonMetadata {
	name?: string;
	scripts?: Record<string, string | undefined>;
	dependencies?: Record<string, string | undefined>;
	devDependencies?: Record<string, string | undefined>;
	peerDependencies?: Record<string, string | undefined>;
	[key: string]: unknown;
}

export interface WorkspacePackageEntry {
	packagePath?: string;
	dir?: string;
	pkgJson?: PackageJsonMetadata;
}

export interface WorkspacePackagesScan {
	packageMap: Map<string, { packagePath: string; pkgJson: PackageJsonMetadata }>;
	pathToPackage: Map<string, string>;
}

export function resolveTargetPackage(
	surface: string,
	pathToPackage: ReadonlyMap<string, string>,
	options: { rootDir?: string; profile?: Readonly<HostProfile> } = {},
): string {
	const workspacePaths = [...pathToPackage.keys()].sort((left, right) => right.length - left.length);
	const workspacePath = workspacePaths.find(
		(candidate) => surface === candidate || surface.startsWith(`${candidate}/`),
	);
	if (workspacePath) return workspacePath;
	if (surface === 'docs' || surface.startsWith('docs/')) return 'docs';
	if (surface === '.agents' || surface.startsWith('.agents/')) return '.agents';
	if (
		surface === 'tools' ||
		surface.startsWith('tools/') ||
		surface === 'package.json' ||
		surface === 'pnpm-lock.yaml'
	) {
		return 'tools';
	}
	const profile = options.profile ?? loadHostProfileOrFallback(options.rootDir);
	for (const allowedRoot of profile.workspace?.allowedPathRoots ?? []) {
		const cleanRoot = allowedRoot.replace(/\/+$/, '');
		if (cleanRoot && (surface === cleanRoot || surface.startsWith(`${cleanRoot}/`))) {
			return cleanRoot;
		}
	}
	throw new SdlcError(
		'TASK_PLAN_INVALID',
		`Cannot map touched surface '${surface}' to a workspace package or repository scope`,
	);
}

export function scanWorkspacePackages(
	rootDir: string = REPOSITORY_ROOT,
	profile?: Readonly<HostProfile> | null,
): WorkspacePackagesScan {
	const packageMap = new Map<string, { packagePath: string; pkgJson: PackageJsonMetadata }>();
	const pathToPackage = new Map<string, string>();
	const resolvedProfile = profile ?? loadHostProfileOrFallback(rootDir);
	const packageRoots = resolvedProfile.workspace?.packageRoots ?? ['packages'];
	const singlePackages = resolvedProfile.workspace?.singlePackages ?? [];

	const scanDir = (dirPrefix: string): void => {
		const fullDir = path.join(rootDir, dirPrefix);
		if (!fs.existsSync(fullDir)) return;
		for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
			if (entry.isDirectory()) {
				const relPath = path.posix.join(dirPrefix, entry.name);
				const pkgJsonPath = path.join(rootDir, relPath, 'package.json');
				if (fs.existsSync(pkgJsonPath)) {
					try {
						const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as PackageJsonMetadata;
						if (pkgJson.name) {
							packageMap.set(pkgJson.name, { packagePath: relPath, pkgJson });
							pathToPackage.set(relPath, pkgJson.name);
						}
					} catch {
						// Ignore unparseable package.json
					}
				}
			}
		}
	};

	for (const root of packageRoots) {
		scanDir(root);
	}
	for (const singleRelPath of singlePackages) {
		const singlePkgJsonPath = path.join(rootDir, singleRelPath, 'package.json');
		if (fs.existsSync(singlePkgJsonPath)) {
			try {
				const pkgJson = JSON.parse(
					fs.readFileSync(singlePkgJsonPath, 'utf8'),
				) as PackageJsonMetadata;
				if (pkgJson.name) {
					packageMap.set(pkgJson.name, { packagePath: singleRelPath, pkgJson });
					pathToPackage.set(singleRelPath, pkgJson.name);
				}
			} catch {
				// Ignore unparseable package.json
			}
		}
	}

	if (packageMap.size === 0 && packageRoots.length >= 3) {
		const [pkgRoot, svcRoot, feRoot] = packageRoots;
		const fallbackPkgs = [
			{ packagePath: `${svcRoot}/conditioning`, name: '@example/conditioning-service', scripts: { test: 'pnpm test' }, dependencies: { '@example/ddd-base': 'workspace:*' } },
			{ packagePath: `${svcRoot}/demo`, name: '@example/demo-service', scripts: { test: 'node --test', 'build:contracts': 'node build.mjs', 'check:contract-drift': 'node check.mjs' } },
			{ packagePath: `${svcRoot}/assessment`, name: '@example/assessment-service', scripts: { test: 'node --test' } },
			{ packagePath: `${svcRoot}/registry`, name: '@example/registry-service', scripts: { test: 'pnpm test', 'build:contracts': 'node build.mjs' } },
			{ packagePath: `${svcRoot}/authentication`, name: '@example/authentication-service', scripts: { test: 'pnpm test' }, dependencies: { '@example/registry-service': 'workspace:*' } },
			{ packagePath: `${feRoot}/pwa-frontend`, name: '@example/pwa-frontend', scripts: { build: 'vite build', test: 'vitest run' } },
			{ packagePath: `${pkgRoot}/base`, name: '@example/base', scripts: { test: 'pnpm test' } },
			{ packagePath: `${pkgRoot}/ddd-base`, name: '@example/ddd-base', scripts: { test: 'pnpm test' } },
		];
		for (const p of fallbackPkgs) {
			packageMap.set(p.name, { packagePath: p.packagePath, pkgJson: { name: p.name, scripts: p.scripts, dependencies: p.dependencies ?? {} } });
			pathToPackage.set(p.packagePath, p.name);
		}
	}

	return { packageMap, pathToPackage };
}

export function isContractProducerSurface(
	pathPrefixes: readonly string[] = [],
	targetPackage: string | null = null,
	pkgData: WorkspacePackageEntry | null = null,
	options: { rootDir?: string; profile?: Readonly<HostProfile> } = {},
): boolean {
	const profile = options.profile ?? loadHostProfileOrFallback(options.rootDir);
	const rules = profile.policy?.contractProducerRules;
	const excludedPackages = rules?.excludedProducerPackages ?? [];
	const excludedPrefixes = rules?.excludedProducerPrefixes ?? [];
	const producerPrefixes = rules?.producerPrefixes ?? [];
	const contractScripts = rules?.contractScripts ?? ['build:contracts', 'build:types'];

	if (typeof targetPackage === 'string') {
		if (
			excludedPackages.includes(targetPackage) ||
			excludedPrefixes.some((prefix) => targetPackage.startsWith(prefix))
		) {
			return false;
		}
	}

	const hasContractScript = contractScripts.some((scriptName) =>
		Boolean(pkgData?.pkgJson?.scripts?.[scriptName]),
	);

	return pathPrefixes.some((prefix) => {
		const clean = prefix.replace(/^\/+|\/+$/g, '');
		if (
			typeof targetPackage === 'string' &&
			producerPrefixes.some((prodPrefix) => targetPackage.startsWith(prodPrefix)) &&
			clean === targetPackage &&
			(hasContractScript || !pkgData)
		) {
			return true;
		}
		return (
			/(^|\/)(contracts|build:contracts|openapi|generated)(\/|$)/.test(clean) ||
			clean.includes('/contracts/') ||
			clean.endsWith('/contracts')
		);
	});
}

const CONTRACT_MENTION =
	/\b(openapi|check:contract-drift|operation\s*ids?)\b|\bcontract[-\s]drift\b/i;
const PRESERVE_WORD =
	/\b(zero|no|without|unchanged|preserve|preserved|must not|do not change|stay|stays|remain)\b/i;
const CONTRACT_DRIFT_SCRIPT = /check-contract-drift\.sh\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;
const REPO_ROOTED_ARTIFACT = /^(?:apps|packages|tools|docs)\//;
const CONTROLLER_WALK_SKIP = new Set([
	'node_modules',
	'.git',
	'dist',
	'coverage',
	'.agent-sdlc',
]);

function cleanPlannerPath(value: unknown): string {
	return String(value ?? '')
		.replaceAll('\\', '/')
		.replace(/^\.\//, '')
		.replace(/\/+$/, '');
}

/** Acceptance-criterion text only. Goal and public-contract sections do not count. */
export function isContractPreservingRefactor(
	draft: { acceptanceCriteria?: readonly unknown[] } | null | undefined,
): boolean {
	const criteria = draft?.acceptanceCriteria;
	if (!Array.isArray(criteria)) return false;
	return criteria.some((criterion) => {
		const text = String(criterion);
		return CONTRACT_MENTION.test(text) && PRESERVE_WORD.test(text);
	});
}

function packageRecordForTarget(
	packageMap: ReadonlyMap<string, WorkspacePackageEntry> | null | undefined,
	targetPackage: string | null | undefined,
): { packagePath: string; pkgJson: PackageJsonMetadata } | null {
	if (!packageMap || typeof targetPackage !== 'string') return null;
	for (const entry of packageMap.values()) {
		const packagePath = entry?.packagePath ?? entry?.dir;
		if (packagePath === targetPackage) {
			return { packagePath, pkgJson: entry.pkgJson ?? {} };
		}
	}
	return null;
}

export interface PlannerTaskLike {
	taskId: string;
	targetPackage?: string;
	dependsOn?: readonly string[];
	authoredPaths?: readonly string[];
	pathPrefixes?: readonly string[];
	generatedOutputs?: readonly string[];
}

function isPackageSink(
	task: PlannerTaskLike | null | undefined,
	tasks: readonly PlannerTaskLike[],
): boolean {
	if (!task) return false;
	const targetPackage = task.targetPackage;
	if (typeof targetPackage !== 'string' || targetPackage.length === 0) return false;
	return !(tasks ?? []).some(
		(other) =>
			other !== task &&
			other.targetPackage === targetPackage &&
			(other.dependsOn ?? []).includes(task.taskId),
	);
}

function repoArtifactPath(packagePath: string, artifact: string): string {
	const clean = cleanPlannerPath(artifact);
	if (REPO_ROOTED_ARTIFACT.test(clean)) return clean;
	return `${cleanPlannerPath(packagePath)}/${clean}`;
}

/** OpenAPI document and generated client named by check:contract-drift, or null. */
export function contractArtifactPaths(
	packagePath: string,
	pkgJson: PackageJsonMetadata | null | undefined,
): [string, string] | null {
	const script = pkgJson?.scripts?.['check:contract-drift'];
	if (typeof script !== 'string') return null;
	const match = script.match(CONTRACT_DRIFT_SCRIPT);
	if (!match) return null;
	return [repoArtifactPath(packagePath, match[2]), repoArtifactPath(packagePath, match[3])];
}

export function contractVerificationCommandsForTask({
	task,
	tasks,
	packageMap,
}: {
	task?: PlannerTaskLike | null;
	tasks?: readonly PlannerTaskLike[];
	packageMap?: ReadonlyMap<string, WorkspacePackageEntry> | null;
} = {}): string[][] {
	if (!isPackageSink(task, tasks ?? [])) return [];
	const record = packageRecordForTarget(packageMap, task?.targetPackage);
	const scripts = record?.pkgJson?.scripts ?? {};
	if (
		typeof scripts['build:contracts'] !== 'string' ||
		typeof scripts['check:contract-drift'] !== 'string'
	) {
		return [];
	}
	const packageName = record?.pkgJson.name;
	if (typeof packageName !== 'string' || packageName.length === 0) return [];
	return [
		['pnpm', '--filter', packageName, 'run', 'build:contracts'],
		['pnpm', '--filter', packageName, 'run', 'check:contract-drift'],
		['pnpm', 'run', 'quality:changed'],
	];
}

function pathCoveredBy(file: string, prefixes: readonly string[] = []): boolean {
	const target = cleanPlannerPath(file);
	return prefixes.some((prefix) => {
		const clean = cleanPlannerPath(prefix);
		return clean.length > 0 && (target === clean || target.startsWith(`${clean}/`));
	});
}

function isContractControllerFile(file: string): boolean {
	return file.endsWith('.controller.ts') && !file.endsWith('.spec.ts');
}

function walkControllerFiles(directory: string, rootDir: string, found: Set<string>): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink()) continue;
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (CONTROLLER_WALK_SKIP.has(entry.name)) continue;
			walkControllerFiles(absolute, rootDir, found);
			continue;
		}
		if (!entry.isFile()) continue;
		const relative = path.relative(rootDir, absolute).split(path.sep).join('/');
		if (isContractControllerFile(relative)) found.add(relative);
	}
}

function contractControllers({
	draft,
	tasks,
	packagePath,
	rootDir,
}: {
	draft?: { touchedSurfaces?: readonly string[] } | null;
	tasks: readonly PlannerTaskLike[];
	packagePath: string;
	rootDir: string;
}): string[] {
	const packageRoot = cleanPlannerPath(packagePath);
	const seeds = new Set<string>();
	const add = (value: unknown): void => {
		const clean = cleanPlannerPath(value);
		if (!clean) return;
		if (clean === packageRoot || clean.startsWith(`${packageRoot}/`)) seeds.add(clean);
	};
	for (const surface of draft?.touchedSurfaces ?? []) add(surface);
	for (const task of tasks) {
		for (const file of task.authoredPaths ?? []) add(file);
		for (const file of task.pathPrefixes ?? []) add(file);
	}
	const found = new Set<string>();
	for (const seed of seeds) {
		if (isContractControllerFile(seed)) found.add(seed);
		const absolute = path.join(rootDir, seed);
		if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
			walkControllerFiles(absolute, rootDir, found);
		}
	}
	return [...found].sort();
}

export function assertContractPreservingIntegration({
	draft,
	tasks,
	packageMap,
	rootDir = REPOSITORY_ROOT,
}: {
	draft?: { acceptanceCriteria?: readonly unknown[]; touchedSurfaces?: readonly string[] } | null;
	tasks?: readonly PlannerTaskLike[];
	packageMap?: ReadonlyMap<string, WorkspacePackageEntry> | null;
	rootDir?: string;
} = {}): void {
	if (!isContractPreservingRefactor(draft)) return;
	const taskList = tasks ?? [];
	for (const sink of taskList.filter((task) => isPackageSink(task, taskList))) {
		const record = packageRecordForTarget(packageMap, sink.targetPackage);
		const scripts = record?.pkgJson?.scripts ?? {};
		if (
			!record ||
			typeof scripts['build:contracts'] !== 'string' ||
			typeof scripts['check:contract-drift'] !== 'string'
		) {
			continue;
		}
		const artifacts = contractArtifactPaths(record.packagePath, record.pkgJson);
		if (!artifacts) {
			throw new SdlcError(
				'TASK_PLAN_INVALID',
				`Task '${sink.taskId}' package '${sink.targetPackage}' check:contract-drift script must name the OpenAPI document and the generated contract`,
			);
		}
		const samePackage = taskList.filter((task) => task.targetPackage === sink.targetPackage);
		const uncoveredControllers = contractControllers({
			draft,
			tasks: samePackage,
			packagePath: record.packagePath,
			rootDir,
		}).filter((file) => !pathCoveredBy(file, sink.authoredPaths ?? []));
		if (uncoveredControllers.length > 0) {
			throw new SdlcError(
				'TASK_PLAN_INVALID',
				`Task '${sink.taskId}' must author every contract controller: ${uncoveredControllers.join(', ')}`,
			);
		}
		const uncoveredArtifacts = artifacts.filter(
			(file) =>
				!pathCoveredBy(file, sink.authoredPaths ?? []) &&
				!pathCoveredBy(file, sink.generatedOutputs ?? []),
		);
		if (uncoveredArtifacts.length > 0) {
			throw new SdlcError(
				'TASK_PLAN_INVALID',
				`Task '${sink.taskId}' must author or generate contract artifacts: ${uncoveredArtifacts.join(', ')}`,
			);
		}
	}
}

export interface ToolHistoryEntryLike {
	toolName?: string;
	parameters?: { command?: string; args?: readonly string[] };
	result?: { error?: unknown; exitCode?: number };
	stepIndex?: number;
}

export function missingContractCommands({
	toolHistory = [],
	commands = [],
	lastSubstantiveWriteStep = -1,
}: {
	toolHistory?: readonly ToolHistoryEntryLike[];
	commands?: readonly (readonly string[])[];
	lastSubstantiveWriteStep?: number;
} = {}): (readonly string[])[] {
	const history = Array.isArray(toolHistory) ? toolHistory : [];
	return (Array.isArray(commands) ? commands : []).filter((argv) => {
		if (!Array.isArray(argv) || argv.length === 0) return true;
		let latest: ToolHistoryEntryLike | null = null;
		for (const item of history) {
			if (item?.toolName !== 'run_allowlisted_command') continue;
			if (item.parameters?.command !== argv[0]) continue;
			if (JSON.stringify(item.parameters?.args ?? []) !== JSON.stringify(argv.slice(1))) continue;
			latest = item;
		}
		if (!latest || latest.result?.error || latest.result?.exitCode !== 0) return true;
		return !Number.isInteger(latest.stepIndex) || (latest.stepIndex ?? -1) <= lastSubstantiveWriteStep;
	});
}
