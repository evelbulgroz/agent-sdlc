import path from 'node:path';
import { z } from 'zod';

const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase alphanumerics and hyphens');
const PathSchema = z.string().min(1);

const AdapterCommandSchema = z.strictObject({
	argv: z.array(z.string().min(1)).min(1).refine((argv) => path.isAbsolute(argv[0] as string), {
		message: 'argv[0] must be an absolute executable path',
	}),
	bundleFiles: z.array(PathSchema),
});

const CanarySchema = z.strictObject({
	spec: PathSchema,
	tasks: PathSchema,
	corpus: PathSchema,
	// Host data file listing one evidence obligation per acceptance case; validated by the engine.
	obligations: PathSchema,
	files: z.array(z.strictObject({ path: PathSchema, kind: z.enum(['support', 'unit', 'browser']) })).min(1),
});

export const AcceptanceEvidenceSchema = z.strictObject({
	canaryId: IdSchema,
	slug: IdSchema,
	evidenceDir: PathSchema,
	runtimeDir: PathSchema,
	helpersDir: PathSchema,
	nodeExecutable: z.string().refine((value) => path.isAbsolute(value), { message: 'must be an absolute path' }),
	packageManager: z.string().min(1).optional(),
	// Host-declared preflight argv prefix ending in the base flag; the engine appends one base commit.
	preflightCommand: z.array(z.string().min(1)).min(2).optional(),
	// Per-task verification argv recorded in the admission commands (e.g. a package lint run).
	taskVerificationCommand: z.array(z.string().min(1)).min(1).optional(),
	canary: CanarySchema.optional(),
	caseManifest: PathSchema,
	runtimeSources: PathSchema,
	package: z.strictObject({ root: PathSchema, openApiPath: PathSchema.optional() }),
	sandbox: z.strictObject({ readOnlyBinds: z.array(PathSchema) }),
	runners: z.record(IdSchema, AdapterCommandSchema).refine((runners) => Object.keys(runners).length > 0, {
		message: 'at least one runner is required',
	}),
});

export type AcceptanceEvidenceConfig = z.infer<typeof AcceptanceEvidenceSchema>;

/** Repository-relative paths the block names, with the field each came from. */
export function acceptanceContainmentPaths(config: AcceptanceEvidenceConfig | undefined): [string, string][] {
	if (!config) return [];
	const paths: [string, string][] = [
		[config.evidenceDir, 'acceptanceEvidence.evidenceDir'],
		[config.runtimeDir, 'acceptanceEvidence.runtimeDir'],
		[config.helpersDir, 'acceptanceEvidence.helpersDir'],
		[config.caseManifest, 'acceptanceEvidence.caseManifest'],
		[config.runtimeSources, 'acceptanceEvidence.runtimeSources'],
		[config.package.root, 'acceptanceEvidence.package.root'],
	];
	if (config.package.openApiPath) paths.push([config.package.openApiPath, 'acceptanceEvidence.package.openApiPath']);
	if (config.canary) {
		for (const key of ['spec', 'tasks', 'corpus', 'obligations'] as const) {
			paths.push([config.canary[key], `acceptanceEvidence.canary.${key}`]);
		}
		for (const file of config.canary.files) paths.push([file.path, 'acceptanceEvidence.canary.files']);
	}
	for (const bind of config.sandbox.readOnlyBinds) {
		paths.push([`${config.package.root}/${bind}`, 'acceptanceEvidence.sandbox.readOnlyBinds']);
	}
	for (const [name, runner] of Object.entries(config.runners)) {
		for (const file of runner.bundleFiles) paths.push([file, `acceptanceEvidence.runners.${name}.bundleFiles`]);
	}
	return paths;
}
