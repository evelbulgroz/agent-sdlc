import { z } from 'zod';
import {
	assertClosedContract,
	contractNonEmptyString,
	contractStringArray,
	failContract,
} from './primitives.ts';

const TASK_MANIFEST_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ACCEPTANCE_CRITERION_ID = /^AC-\d{2,}$/;

export const TASK_MANIFEST_SCHEMA_VERSION = '1.0.0';

export const TASK_MANIFEST_SLICE_KINDS = Object.freeze([
	'enabling',
	'vertical',
	'activation',
] as const);

export const TASK_MANIFEST_DELIVERY_LAYERS = Object.freeze([
	'domain',
	'application',
	'ports',
	'adapters',
	'contracts',
	'persistence',
	'configuration',
	'tooling',
	'documentation',
] as const);

export const TaskManifestSliceKindSchema = z.enum(TASK_MANIFEST_SLICE_KINDS);
export type TaskManifestSliceKind = z.infer<typeof TaskManifestSliceKindSchema>;
export type SliceKind = TaskManifestSliceKind;

export const TaskManifestDeliveryLayerSchema = z.enum(TASK_MANIFEST_DELIVERY_LAYERS);
export type TaskManifestDeliveryLayer = z.infer<typeof TaskManifestDeliveryLayerSchema>;
export type DeliveryLayer = TaskManifestDeliveryLayer;

export const ChangeClassSchema = z.enum(['A', 'B', 'C', 'D', 'E']);
export type ChangeClass = z.infer<typeof ChangeClassSchema>;

export const DependencyMutationSchema = z.object({
	manifestPath: z.string(),
	dependencyName: z.string(),
	fromRange: z.string(),
	toRange: z.string(),
});
export type DependencyMutation = z.infer<typeof DependencyMutationSchema>;

export const ShadowPathsSchema = z.object({
	unhappy: z.string(),
	timeout: z.string(),
	empty: z.string(),
	boundary: z.string(),
});
export type ShadowPaths = z.infer<typeof ShadowPathsSchema>;
export type ShadowPathDeclarations = ShadowPaths;

export const ManifestSliceSchema = z.object({
	sliceId: z.string(),
	kind: TaskManifestSliceKindSchema,
	goal: z.string(),
	acceptanceCriteria: z.array(z.string()).readonly(),
	dependsOn: z.array(z.string()).readonly(),
});
export type ManifestSlice = z.infer<typeof ManifestSliceSchema>;
export type TaskSlice = ManifestSlice;

export const ManifestTaskSchema = z.object({
	taskId: z.string(),
	sliceId: z.string(),
	targetPackage: z.string(),
	authoredPaths: z.array(z.string()).readonly(),
	pathPrefixes: z.array(z.string()).readonly(),
	generatedOutputs: z.array(z.string()).readonly(),
	dependsOn: z.array(z.string()).readonly(),
	deliveryLayers: z.array(TaskManifestDeliveryLayerSchema).readonly(),
	dependencyMutations: z.array(DependencyMutationSchema).readonly(),
	shadowPaths: ShadowPathsSchema,
	verificationCommand: z.array(z.string()).readonly(),
	generatorCommand: z.array(z.string()).readonly().nullable(),
	acceptanceCriteria: z.array(z.string()).readonly().optional(),
});
export type ManifestTask = z.infer<typeof ManifestTaskSchema>;

export const TaskManifestSchema = z.object({
	schemaVersion: z.literal(TASK_MANIFEST_SCHEMA_VERSION),
	slices: z.array(ManifestSliceSchema).readonly(),
	tasks: z.array(ManifestTaskSchema).readonly(),
});
export type TaskManifest = z.infer<typeof TaskManifestSchema>;

export function validateTaskManifest(input: unknown): Readonly<TaskManifest> {
	assertClosedContract(input, ['schemaVersion', 'slices', 'tasks'], 'taskManifest');
	if (input.schemaVersion !== TASK_MANIFEST_SCHEMA_VERSION) {
		failContract(`taskManifest.schemaVersion must be ${TASK_MANIFEST_SCHEMA_VERSION}`);
	}
	if (!Array.isArray(input.slices) || input.slices.length === 0 || input.slices.length > 64) {
		failContract('taskManifest.slices must be a non-empty array with at most 64 items');
	}
	if (!Array.isArray(input.tasks) || input.tasks.length === 0 || input.tasks.length > 64) {
		failContract('taskManifest.tasks must be a non-empty array with at most 64 items');
	}

	const slices = input.slices.map((slice, index) => validateManifestSlice(slice, index));
	const tasks = input.tasks.map((task, index) => validateManifestTask(task, index));
	assertUniqueManifestIds(slices, 'sliceId', 'taskManifest.slices');
	assertUniqueManifestIds(tasks, 'taskId', 'taskManifest.tasks');

	const sliceIds = new Set(slices.map((slice) => slice.sliceId));
	const taskIds = new Set(tasks.map((task) => task.taskId));
	validateManifestDependencies(slices, 'sliceId', sliceIds, 'taskManifest.slices');
	validateManifestDependencies(tasks, 'taskId', taskIds, 'taskManifest.tasks');

	for (const task of tasks) {
		if (!sliceIds.has(task.sliceId)) {
			failContract(`taskManifest task '${task.taskId}' references unknown slice '${task.sliceId}'`);
		}
	}
	for (const slice of slices) {
		if (!tasks.some((task) => task.sliceId === slice.sliceId)) {
			failContract(`taskManifest slice '${slice.sliceId}' has no tasks`);
		}
	}

	return Object.freeze({
		schemaVersion: TASK_MANIFEST_SCHEMA_VERSION,
		slices: Object.freeze(slices),
		tasks: Object.freeze(tasks),
	});
}

export function validateTaskManifestAcceptanceCriteria(
	manifestInput: unknown,
	criterionIdsInput: unknown,
): Readonly<TaskManifest> {
	const manifest = validateTaskManifest(manifestInput);
	const criterionIds = contractStringArray(
		criterionIdsInput,
		'criterionIds',
		{ allowEmpty: false, maxItems: 64 },
	);
	for (const criterionId of criterionIds) {
		if (!ACCEPTANCE_CRITERION_ID.test(criterionId)) {
			failContract(`criterionIds contains invalid criterion id '${criterionId}'`);
		}
	}
	const ownerCounts = new Map<string, number>(criterionIds.map((criterionId) => [criterionId, 0]));
	for (const slice of manifest.slices) {
		if (slice.kind === 'enabling') continue;
		for (const criterionId of slice.acceptanceCriteria) {
			const prev = ownerCounts.get(criterionId);
			if (prev === undefined) {
				failContract(`taskManifest assigns unknown acceptance criterion '${criterionId}'`);
			}
			ownerCounts.set(criterionId, prev + 1);
		}
	}
	const missing: string[] = [];
	const duplicate: string[] = [];
	for (const [criterionId, count] of ownerCounts) {
		if (count === 0) missing.push(criterionId);
		if (count > 1) duplicate.push(criterionId);
	}
	if (missing.length > 0 || duplicate.length > 0) {
		const details = [
			missing.length > 0 ? `missing: ${missing.join(', ')}` : null,
			duplicate.length > 0 ? `duplicate: ${duplicate.join(', ')}` : null,
		].filter(Boolean);
		failContract(`taskManifest acceptance criterion ownership is invalid (${details.join('; ')})`);
	}
	return manifest;
}

function validateManifestSlice(input: unknown, index: number): Readonly<ManifestSlice> {
	const name = `taskManifest.slices[${index}]`;
	assertClosedContract(input, ['sliceId', 'kind', 'goal', 'acceptanceCriteria', 'dependsOn'], name);
	const sliceId = manifestId(input.sliceId, `${name}.sliceId`);
	if (
		typeof input.kind !== 'string' ||
		!(TASK_MANIFEST_SLICE_KINDS as readonly string[]).includes(input.kind)
	) {
		failContract(`${name}.kind must be enabling, vertical, or activation`);
	}
	const acceptanceCriteria = contractStringArray(input.acceptanceCriteria, `${name}.acceptanceCriteria`, {
		maxItems: 5,
	});
	if (input.kind === 'enabling' && acceptanceCriteria.length !== 0) {
		failContract(
			`${name}.acceptanceCriteria must be empty for an enabling slice; assigned: ${acceptanceCriteria.join(', ')}`,
		);
	}
	if (input.kind !== 'enabling' && acceptanceCriteria.length === 0) {
		failContract(`${name}.acceptanceCriteria must contain between 1 and 5 criterion ids`);
	}
	for (const criterionId of acceptanceCriteria) {
		if (!ACCEPTANCE_CRITERION_ID.test(criterionId)) {
			failContract(`${name}.acceptanceCriteria contains invalid criterion id '${criterionId}'`);
		}
	}
	return Object.freeze({
		sliceId,
		kind: input.kind as TaskManifestSliceKind,
		goal: contractNonEmptyString(input.goal, `${name}.goal`),
		acceptanceCriteria: Object.freeze(acceptanceCriteria),
		dependsOn: Object.freeze(manifestIdArray(input.dependsOn, `${name}.dependsOn`)),
	});
}

function validateManifestTask(input: unknown, index: number): Readonly<ManifestTask> {
	const name = `taskManifest.tasks[${index}]`;
	assertClosedContract(
		input,
		[
			'taskId',
			'sliceId',
			'targetPackage',
			'authoredPaths',
			'pathPrefixes',
			'generatedOutputs',
			'dependsOn',
			'deliveryLayers',
			'dependencyMutations',
			'shadowPaths',
			'verificationCommand',
			'generatorCommand',
		],
		name,
	);
	const generatedOutputs = repositoryPathArray(input.generatedOutputs, `${name}.generatedOutputs`);
	const generatorCommand =
		input.generatorCommand === null
			? null
			: declaredTaskCommand(input.generatorCommand, `${name}.generatorCommand`);
	if (
		generatorCommand === null &&
		generatedOutputs.some((output) => output !== 'pnpm-lock.yaml')
	) {
		failContract(
			`${name}.generatorCommand is required when generatedOutputs contains non-lockfile output`,
		);
	}
	return Object.freeze({
		taskId: manifestId(input.taskId, `${name}.taskId`),
		sliceId: manifestId(input.sliceId, `${name}.sliceId`),
		targetPackage: contractNonEmptyString(input.targetPackage, `${name}.targetPackage`, 512),
		authoredPaths: Object.freeze(
			repositoryPathArray(input.authoredPaths, `${name}.authoredPaths`, false),
		),
		pathPrefixes: Object.freeze(
			repositoryPathArray(input.pathPrefixes, `${name}.pathPrefixes`, false),
		),
		generatedOutputs: Object.freeze(generatedOutputs),
		dependsOn: Object.freeze(manifestIdArray(input.dependsOn, `${name}.dependsOn`)),
		deliveryLayers: Object.freeze(
			enumArray(
				input.deliveryLayers,
				TASK_MANIFEST_DELIVERY_LAYERS,
				`${name}.deliveryLayers`,
				false,
			),
		),
		dependencyMutations: Object.freeze(
			validateDependencyMutations(input.dependencyMutations, `${name}.dependencyMutations`),
		),
		shadowPaths: validateShadowPaths(input.shadowPaths, `${name}.shadowPaths`),
		verificationCommand: Object.freeze(
			declaredTaskCommand(input.verificationCommand, `${name}.verificationCommand`),
		),
		generatorCommand: generatorCommand === null ? null : Object.freeze(generatorCommand),
	});
}

function manifestId(value: unknown, name: string): string {
	if (typeof value !== 'string' || !TASK_MANIFEST_ID.test(value)) {
		failContract(`${name} must match ${TASK_MANIFEST_ID}`);
	}
	return value;
}

function manifestIdArray(value: unknown, name: string): string[] {
	const ids = contractStringArray(value, name);
	for (const id of ids) manifestId(id, `${name} entry`);
	return ids;
}

function repositoryPathArray(value: unknown, name: string, allowEmpty = true): string[] {
	const paths = contractStringArray(value, name, { allowEmpty, maxItems: 64 });
	for (const relPath of paths) {
		if (
			relPath.startsWith('/') ||
			relPath.includes('\\') ||
			relPath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
		) {
			failContract(`${name} contains non-repository-relative path '${relPath}'`);
		}
	}
	return paths;
}

function enumArray<T extends string>(
	value: unknown,
	allowed: readonly T[],
	name: string,
	allowEmpty = true,
): T[] {
	const values = contractStringArray(value, name, { allowEmpty });
	for (const entry of values) {
		if (!(allowed as readonly string[]).includes(entry)) {
			failContract(`${name} contains unsupported value '${entry}'`);
		}
	}
	return values as T[];
}

const ALLOWED_TASK_VERBS = [
	'test',
	'test:unit',
	'test:integration',
	'build',
	'build:contracts',
	'build:types',
	'build:openapi',
	'build:gateway-client',
	'check:gateway-client',
	'check:contract-drift',
	'lint',
	'typecheck',
];

function declaredTaskCommand(value: unknown, name: string): string[] {
	const argv = contractStringArray(value, name, { allowEmpty: false, maxItems: 32 });
	const isRepositorySuite =
		argv.length === 3 &&
		argv[0] === 'pnpm' &&
		argv[1] === 'run' &&
		/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(argv[2] ?? '');
	const isFilteredScript =
		argv[0] === 'pnpm' &&
		argv[1] === '--filter' &&
		typeof argv[2] === 'string' &&
		argv[2].length > 0 &&
		((argv.length === 4 && ALLOWED_TASK_VERBS.includes(argv[3])) ||
			(argv.length === 5 &&
				argv[3] === 'run' &&
				ALLOWED_TASK_VERBS.includes(argv[4])));
	if (!isRepositorySuite && !isFilteredScript) {
		failContract(
			`${name} must be pnpm run <script> (checked against the host commandPolicy at execution) or a pnpm --filter package test/build/lint/typecheck command`,
		);
	}
	return argv;
}

function validateDependencyMutations(input: unknown, name: string): Readonly<DependencyMutation>[] {
	if (!Array.isArray(input) || input.length > 64) {
		failContract(`${name} must be an array with at most 64 items`);
	}
	return input.map((mutation, index) => {
		const mutationName = `${name}[${index}]`;
		assertClosedContract(
			mutation,
			['manifestPath', 'dependencyName', 'fromRange', 'toRange'],
			mutationName,
		);
		const [manifestPath] = repositoryPathArray(
			[mutation.manifestPath],
			`${mutationName}.manifestPath`,
			false,
		);
		return Object.freeze({
			manifestPath,
			dependencyName: contractNonEmptyString(
				mutation.dependencyName,
				`${mutationName}.dependencyName`,
				512,
			),
			fromRange: contractNonEmptyString(mutation.fromRange, `${mutationName}.fromRange`, 512),
			toRange: contractNonEmptyString(mutation.toRange, `${mutationName}.toRange`, 512),
		});
	});
}

function validateShadowPaths(input: unknown, name: string): Readonly<ShadowPaths> {
	assertClosedContract(input, ['unhappy', 'timeout', 'empty', 'boundary'], name);
	return Object.freeze({
		unhappy: contractNonEmptyString(input.unhappy, `${name}.unhappy`),
		timeout: contractNonEmptyString(input.timeout, `${name}.timeout`),
		empty: contractNonEmptyString(input.empty, `${name}.empty`),
		boundary: contractNonEmptyString(input.boundary, `${name}.boundary`),
	});
}

function assertUniqueManifestIds<K extends string>(
	items: readonly Record<K, string>[],
	key: K,
	name: string,
): void {
	const seen = new Set<string>();
	for (const item of items) {
		const id = item[key];
		if (seen.has(id)) failContract(`${name} contains duplicate ${key} '${id}'`);
		seen.add(id);
	}
}

function validateManifestDependencies<K extends string>(
	items: readonly (Record<K, string> & { dependsOn: readonly string[] })[],
	idKey: K,
	knownIds: ReadonlySet<string>,
	name: string,
): void {
	const dependenciesById = new Map<string, readonly string[]>();
	for (const item of items) {
		const itemId = item[idKey];
		for (const dependencyId of item.dependsOn) {
			if (!knownIds.has(dependencyId)) {
				failContract(`${name} '${itemId}' depends on unknown id '${dependencyId}'`);
			}
			if (dependencyId === itemId) {
				failContract(`${name} '${itemId}' cannot depend on itself`);
			}
		}
		dependenciesById.set(itemId, item.dependsOn);
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) failContract(`${name} contains a dependency cycle involving '${id}'`);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependencyId of dependenciesById.get(id) ?? []) visit(dependencyId);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of knownIds) visit(id);
}
