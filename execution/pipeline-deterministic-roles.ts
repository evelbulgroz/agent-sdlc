import fs from 'node:fs';
import path from 'node:path';
import { type HostProfile, loadHostProfileOrFallback } from '../host/host-profile.ts';
import { RUNTIME_SCHEMA_VERSION, createEvent, sha256 } from '../policy/contracts.ts';
import { resolveTargetScope } from '../roles/upstream-recall.ts';

export interface ArchitecturalBoundaryViolation {
	readonly boundary: string;
	readonly file: string;
	readonly description: string;
	readonly severity: 'P1' | 'P2' | 'P3';
}

export interface ArchitecturalBoundaryAnalysis {
	readonly status: 'PASS' | 'VIOLATIONS_DETECTED';
	readonly violations: ArchitecturalBoundaryViolation[];
}

export interface HardenerCoverageAnalysis {
	readonly status: 'PASS' | 'HARDENED';
	readonly testsAdded: string[];
	readonly shadowPathsCovered: string[];
}

export interface ExecutedRoleSummary {
	readonly roleId: string;
	readonly insertionPoint: string;
	readonly generation: number;
	readonly status: string;
	readonly summary: string;
	readonly replayed: boolean;
}

export interface PipelineHaltResult {
	readonly status: 'FAIL';
	readonly failedRole: string;
	readonly summary: string;
	readonly executedRoles: readonly ExecutedRoleSummary[];
	readonly findings: readonly ArchitecturalBoundaryViolation[];
}

export interface PipelineRuntimeStoreLike {
	saveOptionalRoleExecution?: (record: {
		schemaVersion: string;
		runId: string;
		taskId: string | null;
		roleId: string;
		insertionPoint: string;
		generation: number;
		status: string;
		summary: string;
		executedAt: string;
		outputArtifact?: unknown;
		structuredFindingsJson?: string;
	}) => void;
	recordCandidateLearning?: (record: {
		runId: string;
		taskId: string;
		generation: number;
		stage: string;
		sourceRole: string;
		type: string;
		key: string;
		scope: string;
		query: string;
		insight: string;
		confidence: number;
	}) => void;
	appendEvent(event: unknown): void;
}

export interface PipelineRuntimeLike {
	readonly runtimeStore: PipelineRuntimeStoreLike;
	readonly artifactStore?: { readonly writeJson?: (kind: string, payload: unknown) => unknown } | null;
	now(): Date;
	onBoundary(name: string, payload: { runId: string; taskId: string | null; roleId: string; generation: number }): Promise<void> | void;
}

export interface PipelineSnapshotLike {
	readonly runId: string;
	readonly runtimeRevision: number;
	readonly worktreePath?: string | null;
	readonly [key: string]: unknown;
}

export interface RoleEvaluatorLike {
	evaluate(value: unknown): Record<string, unknown>;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function packageOwner(filePath: string, profile: Readonly<HostProfile>): string | null {
	const normalized = filePath.replaceAll('\\', '/').replace(/^\.?\//, '');
	const packageRoots = profile.workspace?.packageRoots ?? ['packages'];
	for (const singlePkg of profile.workspace?.singlePackages ?? []) {
		const cleanSingle = singlePkg.replace(/\/+$/, '');
		if (cleanSingle && (normalized === cleanSingle || normalized.startsWith(`${cleanSingle}/`))) {
			return cleanSingle;
		}
	}
	const alternation = packageRoots.map((r) => escapeRegex(r.replace(/\/+$/, ''))).filter(Boolean).join('|');
	if (!alternation) return null;
	const match = normalized.match(new RegExp(`(?:^|/)(${alternation})/([^/]+)`));
	return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : null;
}

function discoverWorktreeSourceFiles(rootDir: string): string[] {
	const found: string[] = [];
	const skipDirs = new Set(['node_modules', '.git', 'dist', 'coverage', '.agent-sdlc', '.agents']);
	const walk = (dir: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (skipDirs.has(entry.name)) continue;
				walk(full);
			} else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
				found.push(path.relative(rootDir, full).split(path.sep).join('/'));
			}
		}
	};
	walk(rootDir);
	return found.sort();
}

function readTouchedSources(
	worktreePath: string | null | undefined,
	touchedFiles: readonly string[],
): Array<{ file: string; content: string }> {
	if (!worktreePath) return [];
	const root = path.resolve(worktreePath);
	const filesToRead =
		touchedFiles.length > 0 ? touchedFiles : discoverWorktreeSourceFiles(root);
	const sources: Array<{ file: string; content: string }> = [];
	for (const file of filesToRead) {
		if (!/\.(?:[cm]?[jt]sx?)$/.test(file)) continue;
		const absolutePath = path.resolve(root, file);
		if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) continue;
		if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) continue;
		sources.push({ file, content: fs.readFileSync(absolutePath, 'utf8') });
	}
	return sources;
}

function importSpecifiers(content: string): string[] {
	const specifiers: string[] = [];
	const pattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\(\s*)['"]([^'"]+)['"]/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(content)) !== null) {
		if (match[1]) specifiers.push(match[1]);
	}
	return specifiers;
}

export interface AnalyzeArchitecturalBoundariesOptions {
	readonly diff?: unknown;
	readonly content?: unknown;
	readonly touchedFiles?: readonly string[] | null;
	readonly changedFiles?: readonly string[] | null;
	readonly files?: readonly string[] | null;
	readonly worktreePath?: string | null;
	readonly worktreeDir?: string | null;
	readonly rootDir?: string | null;
	readonly profile?: Readonly<HostProfile>;
}

export function analyzeArchitecturalBoundaries(
	first: unknown,
	touchedFilesArg?: readonly string[] | null,
	worktreePathArg: string | null = null,
	profileArg?: Readonly<HostProfile>,
): ArchitecturalBoundaryAnalysis {
	let diff: unknown = first;
	let touchedFiles: readonly string[] | null | undefined = touchedFilesArg;
	let worktreePath: string | null = worktreePathArg;
	let explicitProfile: Readonly<HostProfile> | undefined = profileArg;

	if (first && typeof first === 'object' && !Array.isArray(first)) {
		const opts = first as AnalyzeArchitecturalBoundariesOptions;
		diff = opts.diff ?? opts.content ?? '';
		touchedFiles = opts.touchedFiles ?? opts.changedFiles ?? opts.files ?? null;
		worktreePath = opts.worktreePath ?? opts.worktreeDir ?? opts.rootDir ?? null;
		explicitProfile = opts.profile;
	}

	const resolvedProfile =
		explicitProfile ?? loadHostProfileOrFallback(worktreePath ?? undefined);
	const importRules = resolvedProfile.architecture?.importRules ?? [];
	const packageRoots = resolvedProfile.workspace?.packageRoots ?? ['packages'];
	const rootAlternation = packageRoots
		.map((r) => escapeRegex(r.split('/')[0] ?? ''))
		.filter(Boolean)
		.join('|');
	const explicitCrossingRe = rootAlternation
		? new RegExp(`^\\.\\.\\/(?:\\.\\.\\/)*(?:${rootAlternation}|services)\\/`)
		: /^\.\.\/(?:\.\.\/)*packages\//;

	const violations: ArchitecturalBoundaryViolation[] = [];
	const diffFiles = [...String(diff ?? '').matchAll(/^\+\+\+ b\/(.+)$/gm)]
		.map((match) => match[1])
		.filter((f): f is string => typeof f === 'string' && f.length > 0);
	const sourceFiles = [...new Set([...(touchedFiles ?? []), ...diffFiles])];
	const sources = readTouchedSources(worktreePath, sourceFiles);
	if (sources.length === 0) {
		sources.push({ file: touchedFiles?.[0] || 'unknown', content: String(diff || '') });
	}

	for (const { file, content } of sources) {
		const normalizedFile = file.replaceAll('\\', '/').replace(/^\.?\//, '');
		const sourceOwner = packageOwner(normalizedFile, resolvedProfile);
		for (const specifier of importSpecifiers(content)) {
			if (specifier.includes('/dist/')) {
				violations.push({
					boundary: 'deep-dist-import',
					file,
					description: `Forbidden deep dist import: "${specifier}". Import from the package root or public export.`,
					severity: 'P1',
				});
			}
			for (const rule of importRules) {
				if (rule.sourcePathPattern !== undefined) {
					const sourceRe = new RegExp(rule.sourcePathPattern);
					if (!sourceRe.test(normalizedFile) && (!sourceOwner || !sourceRe.test(sourceOwner))) {
						continue;
					}
				}
				if (rule.sourcePathPrefixes !== undefined && rule.sourcePathPrefixes.length > 0) {
					const matchesPrefix = rule.sourcePathPrefixes.some((rawPrefix) => {
						const cleanPrefix = rawPrefix.replace(/\/+$/, '');
						return (
							normalizedFile === cleanPrefix ||
							normalizedFile.startsWith(`${cleanPrefix}/`) ||
							(sourceOwner !== null &&
								(sourceOwner === cleanPrefix || sourceOwner.startsWith(`${cleanPrefix}/`)))
						);
					});
					if (!matchesPrefix) {
						continue;
					}
				}
				const forbiddenRe = new RegExp(rule.forbiddenSpecifierPattern);
				if (!forbiddenRe.test(specifier)) {
					continue;
				}
				if (rule.allowedSpecifierPattern !== undefined) {
					const allowedRe = new RegExp(rule.allowedSpecifierPattern);
					if (allowedRe.test(specifier)) {
						continue;
					}
				}
				const boundary = rule.boundary ?? rule.id ?? 'import-boundary';
				const severity = rule.severity ?? 'P1';
				const description = (
					rule.description ?? `Forbidden import matching ${rule.forbiddenSpecifierPattern}: "{specifier}".`
				).replaceAll('{specifier}', specifier);
				violations.push({
					boundary,
					file,
					description,
					severity,
				});
			}
			if (specifier.startsWith('.')) {
				const explicitCrossing = explicitCrossingRe.test(specifier);
				const targetOwner = packageOwner(
					path.posix.normalize(path.posix.join(path.posix.dirname(normalizedFile), specifier)),
					resolvedProfile,
				);
				if (explicitCrossing || (sourceOwner && targetOwner && sourceOwner !== targetOwner)) {
					violations.push({
						boundary: 'cross-package-relative-traversal',
						file,
						description: `Forbidden cross-package relative traversal: "${specifier}". Use a workspace package specifier instead.`,
						severity: 'P1',
					});
				} else if (
					/\.(?:[cm]?[jt]sx?)$/.test(file) &&
					!/\.(?:js|json|node|css|scss|sass|less|svg|png|jpg|jpeg|gif|webp)$/.test(specifier)
				) {
					violations.push({
						boundary: 'missing-esm-js-extension',
						file,
						description: `Relative ESM import "${specifier}" must use a .js extension.`,
						severity: 'P2',
					});
				}
			}
		}
	}

	if (violations.length > 0) {
		return { status: 'VIOLATIONS_DETECTED', violations };
	}
	return { status: 'PASS', violations: [] };
}

export const runDeterministicArchitect = analyzeArchitecturalBoundaries;

function analyzeHardenerCoverage(
	diff: unknown,
	touchedFiles: readonly string[] | null | undefined,
): HardenerCoverageAnalysis {
	const testFiles = (touchedFiles || []).filter((f) => /\.(spec|test)\.(ts|js|mjs|tsx|jsx)$/.test(f));

	const content = String(diff || '');
	const shadowPaths: string[] = [];
	if (/(null|undefined|\bnil\b)/i.test(content)) shadowPaths.push('nil-inputs');
	if (/(empty|length\s*[=!]==?\s*0|\[\]|new (?:Map|Set)\(\))/i.test(content)) {
		shadowPaths.push('empty-collections');
	}
	if (/(mockRejected|reject|upstream.{0,30}(?:fail|error))/i.test(content)) {
		shadowPaths.push('upstream-rejection');
	}
	if (/(timeout|abort|AbortController|AbortSignal)/i.test(content)) {
		shadowPaths.push('timeout-abort');
	}

	if (testFiles.length > 0 && shadowPaths.length > 0) {
		return { status: 'HARDENED', testsAdded: testFiles, shadowPathsCovered: shadowPaths };
	}

	return { status: 'PASS', testsAdded: [], shadowPathsCovered: [] };
}

export async function runDeterministicAnalysisRole({
	roleId, evaluator, diff, touchedFiles, snapshot, runtime, taskId, insertionPoint, generation, startTime, executedRoles,
}: {
	roleId: string; evaluator: RoleEvaluatorLike; diff: string; touchedFiles: readonly string[];
	snapshot: PipelineSnapshotLike; runtime: PipelineRuntimeLike; taskId: string | null;
	insertionPoint: string; generation: number; startTime: number; executedRoles: ExecutedRoleSummary[];
}): Promise<{ handled: true; halt?: Readonly<PipelineHaltResult> } | null> {
	if (roleId === 'hardener') {
		const rawOutput = analyzeHardenerCoverage(diff, touchedFiles);
		let evaluated: { status?: string; testsAdded?: readonly string[]; shadowPathsCovered?: readonly string[] };
		try {
			evaluated = evaluator.evaluate(rawOutput);
		} catch (evalError) {
			const msg = evalError instanceof Error ? evalError.message : String(evalError);
			runtime.runtimeStore.saveOptionalRoleExecution?.({
				schemaVersion: RUNTIME_SCHEMA_VERSION, runId: snapshot.runId, taskId: taskId ?? null,
				roleId, insertionPoint, generation, status: 'failed',
				summary: `Hardener evaluation failed: ${msg}`, executedAt: new Date().toISOString(),
			});
			throw evalError;
		}

		const roleStatus = evaluated.status === 'HARDENED' ? 'modified' : 'passed';
		const summary = `Hardener executed with status ${String(evaluated.status)} (0 tokens, deterministic)`;
		const structuredFindingsJson = JSON.stringify(evaluated);
		const outputArtifact = runtime.artifactStore?.writeJson ? runtime.artifactStore.writeJson('optional-role-output', evaluated) : null;
		runtime.runtimeStore.saveOptionalRoleExecution?.({
			schemaVersion: RUNTIME_SCHEMA_VERSION, runId: snapshot.runId, taskId: taskId ?? null,
			roleId, insertionPoint, generation, status: roleStatus, summary,
			executedAt: new Date().toISOString(), outputArtifact, structuredFindingsJson,
		});

		if (evaluated.status === 'HARDENED' && runtime.runtimeStore?.recordCandidateLearning) {
			const scope = resolveTargetScope([...touchedFiles]);
			const covered = evaluated.shadowPathsCovered ?? [];
			const testsAdded = evaluated.testsAdded ?? [];
			const key = `hardener-${scope}-coverage-${sha256(JSON.stringify(covered)).slice(0, 6)}`;
			runtime.runtimeStore.recordCandidateLearning({
				runId: snapshot.runId, taskId: taskId ?? 'task-0', generation, stage: `pipeline.${insertionPoint}`,
				sourceRole: 'hardener', type: 'pattern', key, scope,
				query: `shadow paths coverage test ${scope}`,
				insight: `Hardened ${testsAdded.length} test files covering shadow paths: ${covered.join(', ')}.`,
				confidence: 8,
			});
		}

		const durationMs = Date.now() - startTime;
		const event = createEvent({
			eventType: 'OPTIONAL_ROLE_COMPLETED', runId: snapshot.runId, runtimeRevision: snapshot.runtimeRevision,
			causalId: `${snapshot.runId}${taskId ? `:${taskId}` : ''}:${roleId}:g${generation}`,
			payload: { taskId: taskId ?? null, roleId, insertionPoint, status: roleStatus, durationMs },
			now: runtime.now(),
		});
		runtime.runtimeStore.appendEvent(event);
		await runtime.onBoundary('optional-role-recorded', { runId: snapshot.runId, taskId: taskId ?? null, roleId, generation });
		executedRoles.push({ roleId, insertionPoint, generation, status: roleStatus, summary, replayed: false });
		return { handled: true };
	}
	if (roleId === 'architect') {
		const rawOutput = analyzeArchitecturalBoundaries(diff, touchedFiles, snapshot.worktreePath);
		let evaluated: { status?: string; violations?: readonly ArchitecturalBoundaryViolation[]; hasViolations?: boolean; hasP1?: boolean };
		try {
			evaluated = evaluator.evaluate(rawOutput);
		} catch (evalError) {
			const msg = evalError instanceof Error ? evalError.message : String(evalError);
			runtime.runtimeStore.saveOptionalRoleExecution?.({
				schemaVersion: RUNTIME_SCHEMA_VERSION, runId: snapshot.runId, taskId: taskId ?? null,
				roleId, insertionPoint, generation, status: 'failed',
				summary: `Architect evaluation failed: ${msg}`, executedAt: new Date().toISOString(),
			});
			throw evalError;
		}

		const hasP1 = evaluated.hasP1 === true;
		const evalViolations = evaluated.violations ?? [];
		const roleStatus = hasP1 ? 'failed' : 'passed';
		const summary = hasP1
			? `Architect detected ${evalViolations.length} violations (including P1)`
			: evalViolations.length > 0
				? `Architect passed with ${evalViolations.length} non-blocking violations`
				: 'Architect passed with 0 violations';
		const structuredFindingsJson = JSON.stringify(evaluated);
		const outputArtifact = runtime.artifactStore?.writeJson ? runtime.artifactStore.writeJson('optional-role-output', evaluated) : null;

		runtime.runtimeStore.saveOptionalRoleExecution?.({
			schemaVersion: RUNTIME_SCHEMA_VERSION, runId: snapshot.runId, taskId: taskId ?? null,
			roleId, insertionPoint, generation, status: roleStatus, summary,
			executedAt: new Date().toISOString(), outputArtifact, structuredFindingsJson,
		});

		if (evaluated.hasViolations && runtime.runtimeStore?.recordCandidateLearning) {
			const scope = resolveTargetScope([...touchedFiles]);
			for (const v of evalViolations) {
				const slugKey = `arch-${v.boundary}-${sha256(v.file + v.description).slice(0, 6)}`;
				runtime.runtimeStore.recordCandidateLearning({
					runId: snapshot.runId, taskId: taskId ?? 'task-0', generation, stage: `pipeline.${insertionPoint}`,
					sourceRole: 'architect', type: 'architecture', key: slugKey, scope,
					query: `architectural boundary violation ${v.boundary}`,
					insight: v.description.slice(0, 300), confidence: 9,
				});
			}
		}

		const durationMs = Date.now() - startTime;
		const event = createEvent({
			eventType: 'OPTIONAL_ROLE_COMPLETED', runId: snapshot.runId, runtimeRevision: snapshot.runtimeRevision,
			causalId: `${snapshot.runId}${taskId ? `:${taskId}` : ''}:${roleId}:g${generation}`,
			payload: { taskId: taskId ?? null, roleId, insertionPoint, status: roleStatus, durationMs },
			now: runtime.now(),
		});
		runtime.runtimeStore.appendEvent(event);
		await runtime.onBoundary('optional-role-recorded', { runId: snapshot.runId, taskId: taskId ?? null, roleId, generation });
		executedRoles.push({ roleId, insertionPoint, generation, status: roleStatus, summary, replayed: false });

		if (hasP1) {
			return {
				handled: true,
				halt: Object.freeze({
					status: 'FAIL', failedRole: roleId, summary,
					executedRoles: Object.freeze([...executedRoles]),
					findings: Object.freeze([...evalViolations]),
				}),
			};
		}
		return { handled: true };
	}
	return null;
}
