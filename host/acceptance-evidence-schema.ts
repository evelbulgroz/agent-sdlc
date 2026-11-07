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

export const AcceptanceEvidenceSchema = z.strictObject({
	canaryId: IdSchema,
	slug: IdSchema,
	evidenceDir: PathSchema,
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
		[config.caseManifest, 'acceptanceEvidence.caseManifest'],
		[config.runtimeSources, 'acceptanceEvidence.runtimeSources'],
		[config.package.root, 'acceptanceEvidence.package.root'],
	];
	if (config.package.openApiPath) paths.push([config.package.openApiPath, 'acceptanceEvidence.package.openApiPath']);
	for (const bind of config.sandbox.readOnlyBinds) {
		paths.push([`${config.package.root}/${bind}`, 'acceptanceEvidence.sandbox.readOnlyBinds']);
	}
	for (const [name, runner] of Object.entries(config.runners)) {
		for (const file of runner.bundleFiles) paths.push([file, `acceptanceEvidence.runners.${name}.bundleFiles`]);
	}
	return paths;
}
