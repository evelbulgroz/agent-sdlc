import path from 'node:path';
import { z } from 'zod';

const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase alphanumerics and hyphens');
const PathSchema = z.string().min(1);

const AdapterCommandSchema = z.strictObject({
	argv: z.array(z.string().min(1)).min(1).refine((argv) => path.isAbsolute(argv[0] as string), {
		message: 'argv[0] must be an absolute executable path',
	}),
	bundleFiles: z.array(PathSchema),
	// Runner config file, relative to package.root; the canary execution manifest pins it.
	config: PathSchema.optional(),
	// Runner project name recorded in the case map (e.g. a browser project).
	project: z.string().min(1).optional(),
	// Capabilities the runner qualifies for, and its per-operation timeout (default 120000 ms).
	capabilities: z.array(z.string().min(1)).optional(),
	timeoutMs: z.number().int().positive().optional(),
});

const PLACEHOLDER = /\{[^{}]*\}/g;
const KNOWN_PLACEHOLDERS = new Set(['{reportPath}', '{baseSha}']);
// Placeholders are whole-token or `key=value` substitutions; anything else in braces is rejected.
const placeholdersValid = (argv: string[]): boolean => argv.every((token, index) => {
	const found = token.match(PLACEHOLDER) ?? [];
	if (found.length === 0) return true;
	if (index === 0 || found.length > 1 || !KNOWN_PLACEHOLDERS.has(found[0] as string)) return false;
	return token === found[0] || token.endsWith(`=${found[0]}`);
});

const PinSchema = z.union([
	z.strictObject({ file: PathSchema }),
	z.strictObject({ script: z.strictObject({ file: PathSchema, name: z.string().min(1) }) }),
]);

const CommandBodyShape = {
	argv: z.array(z.string().min(1)).min(1).refine(placeholdersValid, {
		message: 'only {reportPath} or {baseSha} may appear, as a whole token or a key=value value, never in argv[0]',
	}),
	// Repository-relative; defaults to package.root and must lie inside it.
	cwd: PathSchema.optional(),
	timeoutMs: z.number().int().positive().optional(),
	// Files and package scripts whose SHA-256 joins admission; paths are relative to the command cwd.
	pins: z.array(PinSchema).optional(),
	// Runner retry count declared by the host; attempts beyond retries + 1 fail closed.
	retries: z.number().int().min(0).max(5).optional(),
};
const CommandSchema = z.strictObject(CommandBodyShape);
const PretestSchema = z.strictObject({ id: IdSchema, ...CommandBodyShape });

const CanarySchema = z.strictObject({
	spec: PathSchema,
	tasks: PathSchema,
	corpus: PathSchema,
	// Host data file listing one evidence obligation per acceptance case; validated by the engine.
	obligations: PathSchema,
	// Environment variable names the orchestrator may pass through to model providers.
	providerCredentials: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).optional(),
	files: z.array(z.strictObject({ path: PathSchema, kind: z.enum(['support', 'unit', 'browser']) })).min(1),
});

export const AcceptanceEvidenceSchema = z.strictObject({
	canaryId: IdSchema,
	slug: IdSchema,
	evidenceDir: PathSchema,
	runtimeDir: PathSchema,
	// Optional from 1.6.0: bound only when set; nodeExecutable defaults to the running engine's node.
	helpersDir: PathSchema.optional(),
	nodeExecutable: z.string().refine((value) => path.isAbsolute(value), { message: 'must be an absolute path' }).optional(),
	packageManager: z.string().min(1).optional(),
	// Host-declared preflight argv prefix ending in the base flag; the engine appends one base commit.
	preflightCommand: z.array(z.string().min(1)).min(2).optional(),
	// Per-task verification argv recorded in the admission commands (e.g. a package lint run).
	taskVerificationCommand: z.array(z.string().min(1)).min(1).optional(),
	canary: CanarySchema.optional(),
	// Receipt the host's preflight command writes for the integration base commit.
	preflightResult: PathSchema.optional(),
	caseManifest: PathSchema,
	runtimeSources: PathSchema,
	package: z.strictObject({ root: PathSchema, openApiPath: PathSchema.optional() }),
	sandbox: z.strictObject({ readOnlyBinds: z.array(PathSchema) }),
	runners: z.record(IdSchema, AdapterCommandSchema).optional(),
	// Command evidence (1.6.0): one host command per layer, a neutral report instead of an adapter program.
	commands: z.record(IdSchema, CommandSchema).optional(),
	pretest: z.array(PretestSchema).optional(),
	// Admission-time tripwire: must exit non-zero with exactly its planted case failed.
	sentinel: CommandSchema.optional(),
}).superRefine((block, context) => {
	const runners = Object.keys(block.runners ?? {});
	const commands = Object.keys(block.commands ?? {});
	if (runners.length + commands.length === 0) {
		context.addIssue({ code: 'custom', path: ['runners'], message: 'at least one runner or command is required' });
	}
	for (const layer of runners.filter((name) => commands.includes(name))) {
		context.addIssue({ code: 'custom', path: ['commands', layer], message: `layer '${layer}' sets both runners and commands` });
	}
	const root = block.package.root;
	const inside = (cwd: string | undefined) => cwd === undefined || cwd === root || cwd.startsWith(`${root}/`);
	const all = [...Object.values(block.commands ?? {}), ...(block.pretest ?? []), ...(block.sentinel ? [block.sentinel] : [])];
	if (all.some((command) => !inside(command.cwd))) {
		context.addIssue({ code: 'custom', path: ['commands'], message: 'command cwd must lie inside package.root' });
	}
});

export type AcceptanceEvidenceConfig = z.infer<typeof AcceptanceEvidenceSchema>;

/** Repository-relative paths the block names, with the field each came from. */
export function acceptanceContainmentPaths(config: AcceptanceEvidenceConfig | undefined): [string, string][] {
	if (!config) return [];
	const paths: [string, string][] = [
		[config.evidenceDir, 'acceptanceEvidence.evidenceDir'],
		[config.runtimeDir, 'acceptanceEvidence.runtimeDir'],
		[config.caseManifest, 'acceptanceEvidence.caseManifest'],
		[config.runtimeSources, 'acceptanceEvidence.runtimeSources'],
		[config.package.root, 'acceptanceEvidence.package.root'],
	];
	if (config.package.openApiPath) paths.push([config.package.openApiPath, 'acceptanceEvidence.package.openApiPath']);
	if (config.helpersDir) paths.push([config.helpersDir, 'acceptanceEvidence.helpersDir']);
	if (config.preflightResult) paths.push([config.preflightResult, 'acceptanceEvidence.preflightResult']);
	if (config.canary) {
		for (const key of ['spec', 'tasks', 'corpus', 'obligations'] as const) {
			paths.push([config.canary[key], `acceptanceEvidence.canary.${key}`]);
		}
		for (const file of config.canary.files) paths.push([file.path, 'acceptanceEvidence.canary.files']);
	}
	for (const bind of config.sandbox.readOnlyBinds) {
		paths.push([`${config.package.root}/${bind}`, 'acceptanceEvidence.sandbox.readOnlyBinds']);
	}
	const commands: [string, { cwd?: string | undefined; pins?: z.infer<typeof PinSchema>[] | undefined }][] = [
		...Object.entries(config.commands ?? {}),
		...(config.pretest ?? []).map((entry): [string, typeof entry] => [`pretest.${entry.id}`, entry]),
		...(config.sentinel ? [['sentinel', config.sentinel] as [string, typeof config.sentinel]] : []),
	];
	for (const [name, command] of commands) {
		const cwd = command.cwd ?? config.package.root;
		paths.push([cwd, `acceptanceEvidence.commands.${name}.cwd`]);
		for (const pin of command.pins ?? []) {
			const file = 'file' in pin ? pin.file : pin.script.file;
			paths.push([`${cwd}/${file}`, `acceptanceEvidence.commands.${name}.pins`]);
		}
	}
	for (const [name, runner] of Object.entries(config.runners ?? {})) {
		for (const file of runner.bundleFiles) paths.push([file, `acceptanceEvidence.runners.${name}.bundleFiles`]);
		if (runner.config) paths.push([`${config.package.root}/${runner.config}`, `acceptanceEvidence.runners.${name}.config`]);
	}
	return paths;
}

/** Fields that only exist from schemaVersion 1.6.0, or that 1.5.0 still required. */
export function acceptanceVersionIssue(block: AcceptanceEvidenceConfig, schemaVersion: string): string | undefined {
	if (schemaVersion !== '1.5.0') return undefined;
	for (const key of ['commands', 'pretest', 'sentinel'] as const) {
		if (block[key] !== undefined) return `acceptanceEvidence.${key} requires schemaVersion '1.6.0'`;
	}
	for (const key of ['helpersDir', 'nodeExecutable', 'runners'] as const) {
		if (block[key] === undefined) return `acceptanceEvidence.${key} is required below schemaVersion '1.6.0'`;
	}
	return undefined;
}
