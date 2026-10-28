// Task feasibility scoring before any run or model work begins.

import path from 'node:path';
import { type HostProfile, loadHostProfileOrFallback } from '../../host/host-profile.ts';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { anyHighRiskPaths } from '../../review/review-generation.ts';
import {
	type ChangeClass,
	type DeliveryLayer,
	type DependencyMutation,
	type ShadowPathDeclarations,
	type SliceKind,
	type TaskManifest,
	type TaskSlice,
	validateTaskManifestAcceptanceCriteria,
} from '../contracts.ts';
import { SdlcError } from '../errors.ts';
import { taskReaches } from './task-graph.ts';
import {
	type PackageJsonMetadata,
	type WorkspacePackagesScan,
	assertContractPreservingIntegration,
	isContractProducerSurface,
	resolveTargetPackage,
	scanWorkspacePackages,
} from './workspace-packages.ts';

export const TASK_FEASIBILITY_LIMITS = Object.freeze({
	acceptanceCriteria: 5,
	authoredPaths: 8,
	pathPrefixes: 5,
	deliveryLayers: 3,
	dependencyMutations: 1,
	complexityScore: 20,
});

export const DEFAULT_SHADOW_PATHS: ShadowPathDeclarations = Object.freeze({
	unhappy: 'non-zero command or rejected mutation',
	timeout: 'command or model deadline exceeded',
	empty: 'no substantive task delta',
	boundary: 'path, contract, or authorization containment breach',
});

export interface ExceededLimit {
	readonly dimension: string;
	readonly actual: number;
	readonly maximum: number;
}

export interface FeasibilityTaskInput {
	readonly taskId: string;
	readonly sliceId: string;
	readonly targetPackage: string;
	readonly authoredPaths: readonly string[];
	readonly pathPrefixes: readonly string[];
	readonly generatedOutputs: readonly string[];
	readonly dependsOn: readonly string[];
	readonly deliveryLayers: readonly DeliveryLayer[];
	readonly dependencyMutations: readonly DependencyMutation[];
	readonly shadowPaths: ShadowPathDeclarations;
	readonly verificationCommand: readonly string[];
	readonly generatorCommand?: readonly string[] | null;
	readonly acceptanceCriteria?: readonly string[];
}

export interface FeasibilityPacket extends FeasibilityTaskInput {
	readonly generatedOutputs: readonly string[];
	readonly acceptanceCriteria: readonly string[];
	readonly complexityInputs: {
		readonly acceptanceCriteria: number;
		readonly authoredPaths: number;
		readonly deliveryLayers: number;
		readonly dependencyMutations: number;
		readonly contractProducer: boolean;
		readonly highRisk: boolean;
	};
	readonly complexityScore: number;
	readonly contractProducer: boolean;
	readonly highRisk: boolean;
	readonly changeClass: ChangeClass;
	readonly maxAutonomousRepairs: number;
	readonly humanReviewEvidence: 'not_required' | 'required_pending' | 'verified';
	readonly exceededLimits: readonly ExceededLimit[];
}

export interface ReadinessDraftLike {
	goal: string;
	title?: string;
	acceptanceCriteria: readonly string[];
	touchedSurfaces: readonly string[];
}

export interface TaskReadinessReport {
	readonly schemaVersion: '1.0.0';
	readonly slices: readonly TaskSlice[];
	readonly tasks: readonly FeasibilityPacket[];
}

export function classifyTaskChange(
	paths: readonly string[],
	options: { rootDir?: string; profile?: Readonly<HostProfile> } = {},
): ChangeClass {
	const resolvedProfile = options.profile ?? loadHostProfileOrFallback(options.rootDir);
	const packageRoots = resolvedProfile.workspace?.packageRoots ?? ['packages'];
	const singlePackages = resolvedProfile.workspace?.singlePackages ?? [];
	let hasPackage = false;
	let hasToolsRoot = false;
	let hasGithub = false;
	for (const candidate of paths) {
		const file = candidate.replaceAll('\\', '/').replace(/^\.\/+/, '');
		if (
			['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'turbo.json'].includes(file) ||
			file.startsWith('tools/')
		) {
			hasToolsRoot = true;
		} else if (file.startsWith('.github/')) {
			hasGithub = true;
		} else if (
			packageRoots.some((root) => file === root || file.startsWith(`${root}/`)) ||
			singlePackages.some((pkg) => file === pkg || file.startsWith(`${pkg}/`))
		) {
			hasPackage = true;
		}
	}
	const classes: ChangeClass[] = [];
	if (hasPackage) classes.push('A');
	if (hasToolsRoot) classes.push('B');
	if (hasGithub) classes.push('C');
	return classes.length > 1 ? 'E' : (classes[0] ?? 'D');
}

export function evaluateTaskReadiness({
	draft,
	taskManifest = null,
	rootDir = REPOSITORY_ROOT,
	workspacePackages = null,
}: {
	draft: ReadinessDraftLike;
	taskManifest?: TaskManifest | null;
	rootDir?: string;
	workspacePackages?: WorkspacePackagesScan | null;
}): TaskReadinessReport {
	const { packageMap, pathToPackage } = workspacePackages ?? scanWorkspacePackages(rootDir);
	const criterionIds = acceptanceCriterionIds(draft);
	const slices: readonly TaskSlice[] = taskManifest
		? validateTaskManifestAcceptanceCriteria(taskManifest, criterionIds).slices
		: [
				Object.freeze({
					sliceId: 'implicit-vertical',
					kind: 'vertical' as SliceKind,
					goal: draft.goal,
					acceptanceCriteria: [...criterionIds],
					dependsOn: [],
				}),
			];
	const manifestTasks: readonly FeasibilityTaskInput[] = taskManifest
		? taskManifest.tasks
		: deriveManifestlessTasks({ draft, criterionIds, packageMap, pathToPackage, rootDir });
	const sliceById = new Map(slices.map((slice) => [slice.sliceId, slice]));
	const taskPackets = manifestTasks.map((task) =>
		buildFeasibilityPacket({ task, slice: sliceById.get(task.sliceId), draft, packageMap, pathToPackage, rootDir }),
	);
	if (taskManifest) validateExecutableSliceDag(slices, taskPackets);
	const exceeded = taskPackets.filter((task) => task.exceededLimits.length > 0);
	if (exceeded.length > 0) {
		const details = exceeded
			.map((task) => `${task.taskId}: ${task.exceededLimits.map((l) => `${l.dimension}=${l.actual} (max ${l.maximum})`).join(', ')}`)
			.join('; ');
		throw new SdlcError('TASK_DECOMPOSITION_REQUIRED', `Task decomposition required; exceeded limits: ${details}`, {
			exceededLimits: exceeded.map((task) => ({
				taskId: task.taskId,
				sliceId: task.sliceId,
				complexityScore: task.complexityScore,
				exceededLimits: task.exceededLimits,
			})),
		});
	}
	assertContractPreservingIntegration({ draft, tasks: taskPackets, packageMap, rootDir });
	return Object.freeze({ schemaVersion: '1.0.0', slices: Object.freeze([...slices]), tasks: Object.freeze(taskPackets) });
}

function validateExecutableSliceDag(
	slices: readonly TaskSlice[],
	tasks: readonly FeasibilityPacket[],
): void {
	const sliceById = new Map(slices.map((slice) => [slice.sliceId, slice]));
	const tasksBySlice = new Map<string, FeasibilityPacket[]>(
		slices.map((slice) => [slice.sliceId, []]),
	);
	for (const task of tasks) tasksBySlice.get(task.sliceId)?.push(task);
	const taskById = new Map(tasks.map((task) => [task.taskId, task]));
	for (const slice of slices) {
		for (const predecessorSliceId of slice.dependsOn) {
			const predecessorTaskIds = new Set(
				(tasksBySlice.get(predecessorSliceId) ?? []).map((task) => task.taskId),
			);
			for (const task of tasksBySlice.get(slice.sliceId) ?? []) {
				if (!taskReaches(taskById, task.taskId, predecessorTaskIds)) {
					throw new SdlcError(
						'TASK_PLAN_INVALID',
						`Task '${task.taskId}' in slice '${slice.sliceId}' has no task-DAG path to predecessor slice '${predecessorSliceId}'`,
					);
				}
			}
		}
	}
	for (const enabling of slices.filter((slice) => slice.kind === 'enabling')) {
		const hasBehavioralSuccessor = slices.some((candidate) => {
			if (candidate.kind === 'enabling') return false;
			const visit = (sliceId: string, visited: Set<string> = new Set()): boolean => {
				if (sliceId === enabling.sliceId) return true;
				if (visited.has(sliceId)) return false;
				visited.add(sliceId);
				const current = sliceById.get(sliceId);
				return (current?.dependsOn ?? []).some((dependencyId: string) => visit(dependencyId, visited));
			};
			return visit(candidate.sliceId);
		});
		if (!hasBehavioralSuccessor) {
			throw new SdlcError(
				'TASK_PLAN_INVALID',
				`Enabling slice '${enabling.sliceId}' has no vertical or activation successor`,
			);
		}
	}

	for (let i = 0; i < tasks.length; i++) {
		for (let j = i + 1; j < tasks.length; j++) {
			const t1 = tasks[i];
			const t2 = tasks[j];
			if (
				taskReaches(taskById, t1.taskId, new Set([t2.taskId])) ||
				taskReaches(taskById, t2.taskId, new Set([t1.taskId]))
			) {
				continue;
			}
			const paths1 = [...(t1.pathPrefixes ?? []), ...(t1.authoredPaths ?? []), ...(t1.generatedOutputs ?? [])];
			const paths2 = [...(t2.pathPrefixes ?? []), ...(t2.authoredPaths ?? []), ...(t2.generatedOutputs ?? [])];
			for (const p1 of paths1) {
				const norm1 = p1.replace(/\/+$/, '');
				for (const p2 of paths2) {
					const norm2 = p2.replace(/\/+$/, '');
					if (norm1 === norm2 || norm1.startsWith(`${norm2}/`) || norm2.startsWith(`${norm1}/`)) {
						throw new SdlcError(
							'TASK_PLAN_INVALID',
							`Concurrent tasks '${t1.taskId}' and '${t2.taskId}' have overlapping paths ('${p1}' and '${p2}'). Add an explicit dependency via dependsOn or make paths disjoint to prevent reconciliation merge conflicts.`,
						);
					}
				}
			}
		}
	}
}

function acceptanceCriterionIds(draft: { acceptanceCriteria?: readonly unknown[] } | null | undefined): string[] {
	if (!Array.isArray(draft?.acceptanceCriteria) || draft.acceptanceCriteria.length === 0) {
		throw new SdlcError('TASK_PLAN_INVALID', 'Task readiness requires frozen acceptance criteria');
	}
	return draft.acceptanceCriteria.map((criterion, index) => {
		const match = String(criterion).match(/^AC-(\d{2,}):/);
		if (!match) {
			throw new SdlcError('TASK_PLAN_INVALID', `acceptanceCriteria[${index}] does not have a frozen AC-NN id`);
		}
		return `AC-${match[1]}`;
	});
}

function deriveManifestlessTasks({
	draft,
	criterionIds,
	packageMap,
	pathToPackage,
	rootDir,
}: {
	draft: ReadinessDraftLike;
	criterionIds: readonly string[];
	packageMap: ReadonlyMap<string, { packagePath: string; pkgJson: PackageJsonMetadata }>;
	pathToPackage: ReadonlyMap<string, string>;
	rootDir: string;
}): FeasibilityTaskInput[] {
	const touched = Array.from(
		new Set(draft.touchedSurfaces.map((surface) => surface.replaceAll('\\', '/').replace(/\/+$/, ''))),
	);
	const grouped = new Map<string, string[]>();
	for (const surface of touched) {
		const targetPackage = resolveTargetPackage(surface, pathToPackage, { rootDir });
		const group = grouped.get(targetPackage) ?? [];
		group.push(surface);
		grouped.set(targetPackage, group);
	}
	return [...grouped.entries()].map(([targetPackage, paths], index) => {
		const packageName = pathToPackage.get(targetPackage);
		let verificationCommand: string[];
		if (['docs', '.agents', 'tools'].includes(targetPackage)) {
			verificationCommand = ['pnpm', 'run', 'agent:test-sdlc'];
		} else {
			const pkgData = packageName ? packageMap.get(packageName) : null;
			if (!pkgData?.pkgJson?.scripts?.test || !packageName) {
				throw new SdlcError('TASK_PLAN_INVALID', `Package '${targetPackage}' has no test script; supply --task-plan-file`);
			}
			verificationCommand = ['pnpm', '--filter', packageName, 'test'];
		}
		return Object.freeze({
			taskId: grouped.size === 1 ? 'task-0' : `task-${index}`,
			sliceId: 'implicit-vertical',
			targetPackage,
			authoredPaths: Object.freeze(paths),
			pathPrefixes: Object.freeze([
				...new Set(paths.map((surface) => {
					const dir = path.posix.dirname(surface);
					return dir === '.' ? surface : dir;
				})),
			]),
			generatedOutputs: Object.freeze([]),
			dependsOn: Object.freeze([]),
			deliveryLayers: Object.freeze([...new Set(paths.map((surface) => deriveDeliveryLayer(surface, pathToPackage)))]),
			dependencyMutations: Object.freeze([]),
			shadowPaths: DEFAULT_SHADOW_PATHS,
			verificationCommand: Object.freeze(verificationCommand),
			generatorCommand: null,
			acceptanceCriteria: Object.freeze([...criterionIds]),
		});
	});
}

function deriveDeliveryLayer(surface: string, pathToPackage: ReadonlyMap<string, string>): DeliveryLayer {
	if (surface === 'docs' || surface.startsWith('docs/')) return 'documentation';
	if (surface === '.agents' || surface.startsWith('.agents/')) return 'documentation';
	if (surface === 'tools' || surface.startsWith('tools/')) return 'tooling';
	const segments = surface.split('/');
	const ordered = [
		'domain', 'application', 'ports', 'adapters', 'contracts',
		'persistence', 'config', 'configuration', 'openapi', 'infrastructure',
	] as const;
	const matched = ordered.find((segment) => segments.includes(segment));
	if (matched === 'config') return 'configuration';
	if (matched === 'openapi') return 'contracts';
	if (matched === 'infrastructure') return 'adapters';
	if (matched) return matched;
	if (surface === 'package.json' || surface === 'pnpm-lock.yaml') return 'configuration';
	if (resolveTargetPackage(surface, pathToPackage)) return 'application';
	throw new SdlcError('TASK_PLAN_INVALID', `Cannot derive a delivery layer for '${surface}'`);
}

function buildFeasibilityPacket({
	task,
	slice,
	draft,
	packageMap,
	pathToPackage,
	rootDir,
}: {
	task: FeasibilityTaskInput;
	slice: TaskSlice | undefined;
	draft: ReadinessDraftLike;
	packageMap: ReadonlyMap<string, { packagePath: string; pkgJson: PackageJsonMetadata }>;
	pathToPackage: ReadonlyMap<string, string>;
	rootDir: string;
}): FeasibilityPacket {
	if (!slice) {
		throw new SdlcError('TASK_PLAN_INVALID', `Task '${task.taskId}' references unknown slice '${task.sliceId}'`);
	}
	validateTaskScope(task, draft, pathToPackage, rootDir);
	const packageName = pathToPackage.get(task.targetPackage);
	const pkgData = packageName ? (packageMap.get(packageName) ?? null) : null;
	const acceptanceCriteria = task.acceptanceCriteria ?? slice.acceptanceCriteria;
	const generatedOutputs = [
		...task.generatedOutputs,
		...(task.dependencyMutations.length > 0 && !task.generatedOutputs.includes('pnpm-lock.yaml')
			? ['pnpm-lock.yaml']
			: []),
	];
	const contractProducer = isContractProducerSurface(
		[...task.authoredPaths, ...generatedOutputs],
		task.targetPackage,
		pkgData,
		{ rootDir },
	);
	const highRisk = anyHighRiskPaths([...task.authoredPaths, ...generatedOutputs], { rootDir });
	const changeClass = classifyTaskChange([...task.authoredPaths, ...generatedOutputs], { rootDir });
	const complexityInputs = Object.freeze({
		acceptanceCriteria: acceptanceCriteria.length,
		authoredPaths: task.authoredPaths.length,
		deliveryLayers: task.deliveryLayers.length,
		dependencyMutations: task.dependencyMutations.length,
		contractProducer,
		highRisk,
	});
	const complexityScore =
		complexityInputs.acceptanceCriteria +
		complexityInputs.authoredPaths +
		2 * complexityInputs.deliveryLayers +
		2 * complexityInputs.dependencyMutations +
		(contractProducer ? 3 : 0) +
		(highRisk ? 3 : 0);
	const dimensions: Record<keyof typeof TASK_FEASIBILITY_LIMITS, number> = {
		acceptanceCriteria: acceptanceCriteria.length,
		authoredPaths: task.authoredPaths.length,
		pathPrefixes: task.pathPrefixes.length,
		deliveryLayers: task.deliveryLayers.length,
		dependencyMutations: task.dependencyMutations.length,
		complexityScore,
	};
	const exceededLimits = Object.freeze(
		(Object.entries(dimensions) as Array<[keyof typeof TASK_FEASIBILITY_LIMITS, number]>)
			.filter(([dimension, actual]) => actual > TASK_FEASIBILITY_LIMITS[dimension])
			.map(([dimension, actual]) =>
				Object.freeze({ dimension, actual, maximum: TASK_FEASIBILITY_LIMITS[dimension] }),
			),
	);
	return Object.freeze({
		...structuredClone(task),
		generatedOutputs: Object.freeze(generatedOutputs),
		acceptanceCriteria: Object.freeze([...acceptanceCriteria]),
		complexityInputs,
		complexityScore,
		contractProducer,
		highRisk,
		changeClass,
		maxAutonomousRepairs: highRisk ? 0 : 2,
		humanReviewEvidence: highRisk ? 'required_pending' : 'not_required',
		exceededLimits,
	});
}

function validateTaskScope(
	task: FeasibilityTaskInput,
	draft: ReadinessDraftLike,
	pathToPackage: ReadonlyMap<string, string>,
	rootDir: string,
): void {
	for (const authoredPath of task.authoredPaths) {
		if (resolveTargetPackage(authoredPath, pathToPackage, { rootDir }) !== task.targetPackage) {
			throw new SdlcError(
				'TASK_PLAN_INVALID',
				`Task '${task.taskId}' targetPackage '${task.targetPackage}' does not own '${authoredPath}'`,
			);
		}
	}
	if (task.generatedOutputs.includes('pnpm-lock.yaml') && task.dependencyMutations.length === 0) {
		throw new SdlcError(
			'TASK_PLAN_INVALID',
			`Task '${task.taskId}' may own pnpm-lock.yaml only with a declared dependency mutation`,
		);
	}
	for (const mutation of task.dependencyMutations) {
		const owned = task.authoredPaths.some(
			(authoredPath) =>
				mutation.manifestPath === authoredPath ||
				mutation.manifestPath.startsWith(`${authoredPath.replace(/\/+$/, '')}/`),
		);
		if (!owned) {
			throw new SdlcError(
				'TASK_PLAN_INVALID',
				`Task '${task.taskId}' dependency manifest '${mutation.manifestPath}' is outside its authored paths`,
			);
		}
	}
	const allowed = draft.touchedSurfaces.map((surface) => surface.replaceAll('\\', '/').replace(/\/+$/, ''));
	const paths = [
		...task.authoredPaths,
		...task.generatedOutputs.filter((output) => output !== 'pnpm-lock.yaml'),
		...task.dependencyMutations.map((mutation) => mutation.manifestPath),
	];
	for (const candidate of paths) {
		if (!allowed.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`))) {
			throw new SdlcError('TASK_PLAN_INVALID', `Task '${task.taskId}' path '${candidate}' is outside the goal scope`);
		}
	}
	for (const candidate of task.pathPrefixes) {
		const contained = allowed.some(
			(surface) =>
				candidate === surface ||
				candidate.startsWith(`${surface}/`) ||
				surface.startsWith(`${candidate}/`),
		);
		if (!contained) {
			throw new SdlcError('TASK_PLAN_INVALID', `Task '${task.taskId}' path '${candidate}' is outside the goal scope`);
		}
	}
}

export function deriveTaskId(packagePath: string): string {
	const base = path.basename(packagePath).toLowerCase().replace(/[^a-z0-9]+/g, '-');
	let candidate = base.endsWith('-task') ? base : `${base}-task`;
	if (candidate.startsWith('s' + 'k-')) {
		candidate = `pkg-${candidate}`;
	}
	return candidate.slice(0, 64);
}
