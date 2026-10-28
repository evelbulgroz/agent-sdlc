import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { SdlcError } from '../policy/errors.ts';
import {
	DEFAULT_VERIFY_ARGV,
	DEFAULT_VERIFY_HEAD_FIELD,
	DEFAULT_VERIFY_REQUIRE,
	resolveHostVerifyConfig,
	VerifySchema,
	type HostVerifyConfig,
} from './verify-config.ts';

export {
	DEFAULT_VERIFY_ARGV,
	DEFAULT_VERIFY_HEAD_FIELD,
	DEFAULT_VERIFY_REQUIRE,
	resolveHostVerifyConfig,
	VerifySchema,
	type HostVerifyConfig,
};

export const HOST_PROFILE_RELATIVE_PATH = '.agents/sdlc-host.json';
export const HOST_PROFILE_SCHEMA_VERSION = '1.3.0';
export const LEGACY_HOST_PROFILE_SCHEMA_VERSION = '1.2.0';
export const MAX_HOST_PROFILE_BYTES = 65_536;

const NonEmptyTokenSchema = z.string().min(1);
const ArgvSchema = z.array(NonEmptyTokenSchema).min(1);
const CriticPhaseSchema = z.enum(['spec', 'plan', 'code', 'qa']);
const SupportedSchemaVersionSchema = z.enum([HOST_PROFILE_SCHEMA_VERSION, LEGACY_HOST_PROFILE_SCHEMA_VERSION]);

const PathScopedRuleSchema = z.strictObject({
	id: NonEmptyTokenSchema, pathPrefixes: z.array(NonEmptyTokenSchema).min(1), addendaFile: NonEmptyTokenSchema,
	roles: z.array(NonEmptyTokenSchema).min(1).optional(), phases: z.array(CriticPhaseSchema).min(1).optional(),
});

const PromptsConfigSchema = z.strictObject({
	preset: z.enum(['default', 'none']).optional(), roleAddendaDir: NonEmptyTokenSchema.optional(),
	rubricAddendaDir: NonEmptyTokenSchema.optional(), pathScopedRules: z.array(PathScopedRuleSchema).optional(),
});

const GitConfigSchema = z.strictObject({ authorName: NonEmptyTokenSchema, authorEmail: NonEmptyTokenSchema });

const DeclarativeWorkspaceSchema = z.strictObject({
	directories: z.array(NonEmptyTokenSchema).min(1).optional(), packageRoots: z.array(NonEmptyTokenSchema).optional(),
	singlePackages: z.array(NonEmptyTokenSchema).optional(), allowedPathRoots: z.array(NonEmptyTokenSchema).optional(),
});

const HydrationUntrackedCopyRuleSchema = z.strictObject({
	source: NonEmptyTokenSchema, target: NonEmptyTokenSchema.optional(), required: z.boolean().optional(),
});

const HydrationConditionalBuildRuleSchema = z.strictObject({ skipIfExists: NonEmptyTokenSchema, argv: ArgvSchema });

const HydrationPackageArtifactCopyRuleSchema = z.strictObject({
	packageRoot: NonEmptyTokenSchema, artifactRelativePath: NonEmptyTokenSchema,
	excludedPackages: z.array(NonEmptyTokenSchema).optional(), requiredIfPresentInRoot: z.boolean().optional(),
});

const DeclarativeHydrationObjectSchema = z.strictObject({
	installArgv: ArgvSchema.optional(), untrackedCopies: z.array(HydrationUntrackedCopyRuleSchema).optional(),
	conditionalBuilds: z.array(HydrationConditionalBuildRuleSchema).optional(),
	packageArtifactCopies: z.array(HydrationPackageArtifactCopyRuleSchema).optional(), steps: z.array(ArgvSchema).optional(),
});

const HydrationConfigSchema = z.union([z.array(ArgvSchema), DeclarativeHydrationObjectSchema]);

const ContractProducerRulesSchema = z.strictObject({
	producerPrefixes: z.array(NonEmptyTokenSchema).optional(), excludedProducerPackages: z.array(NonEmptyTokenSchema).optional(),
	excludedProducerPrefixes: z.array(NonEmptyTokenSchema).optional(), consumerPackages: z.array(NonEmptyTokenSchema).optional(),
	consumerPrefixes: z.array(NonEmptyTokenSchema).optional(), downstreamPrefixes: z.array(NonEmptyTokenSchema).optional(),
	sharedPackagePrefixes: z.array(NonEmptyTokenSchema).optional(), contractScripts: z.array(NonEmptyTokenSchema).optional(),
	sharedPackageBuildArgv: ArgvSchema.optional(),
});

const PolicyConfigSchema = z.strictObject({
	highRiskPaths: z.array(NonEmptyTokenSchema).optional(), protectedBaselinePaths: z.array(NonEmptyTokenSchema).optional(),
	defaultFailureTargetPaths: z.array(NonEmptyTokenSchema).optional(),
	contractProducerRules: ContractProducerRulesSchema.optional(), irreversiblePatterns: z.array(NonEmptyTokenSchema).optional(),
});

const ArchitectureImportRuleSchema = z.strictObject({
	id: NonEmptyTokenSchema.optional(), boundary: NonEmptyTokenSchema.optional(), description: NonEmptyTokenSchema.optional(),
	severity: z.enum(['P1', 'P2', 'P3']).optional(), sourcePathPattern: NonEmptyTokenSchema.optional(),
	sourcePathPrefixes: z.array(NonEmptyTokenSchema).optional(), forbiddenSpecifierPattern: NonEmptyTokenSchema,
	allowedSpecifierPattern: NonEmptyTokenSchema.optional(),
});

const ArchitectureConfigSchema = z.strictObject({
	enforcePackageContainment: z.boolean().optional(), importRules: z.array(ArchitectureImportRuleSchema).optional(),
});

const QualityGateConfigSchema = z.strictObject({
	eslintConfigPath: NonEmptyTokenSchema.optional(), baselinePath: NonEmptyTokenSchema.optional(),
	exceptionsPath: NonEmptyTokenSchema.optional(),
});

const LearningScopeInferenceRuleSchema = z.strictObject({
	exact: NonEmptyTokenSchema.optional(), prefix: NonEmptyTokenSchema.optional(), pathPrefix: NonEmptyTokenSchema.optional(),
	pattern: NonEmptyTokenSchema.optional(), mode: z.enum(['literal', 'segment', 'prefix']).optional(),
	scope: NonEmptyTokenSchema.optional(), extractSegment: z.boolean().optional(),
});

const LearningsConfigSchema = z.strictObject({
	filePath: NonEmptyTokenSchema.optional(), scopes: z.array(NonEmptyTokenSchema).optional(),
	scopeInference: z.array(LearningScopeInferenceRuleSchema).optional(),
});

const BaseProfileFields = {
	schemaVersion: SupportedSchemaVersionSchema, profileId: NonEmptyTokenSchema, repositoryId: NonEmptyTokenSchema,
	stateDir: NonEmptyTokenSchema.optional(), reviewDir: NonEmptyTokenSchema.optional(),
	specDraftDir: NonEmptyTokenSchema.optional(), runsDir: NonEmptyTokenSchema.optional(), verify: VerifySchema.optional(),
	prompts: PromptsConfigSchema.optional(), git: GitConfigSchema.optional(), workspace: DeclarativeWorkspaceSchema.optional(),
	hydration: HydrationConfigSchema.optional(), policy: PolicyConfigSchema.optional(),
	architecture: ArchitectureConfigSchema.optional(), qualityGate: QualityGateConfigSchema.optional(),
	learnings: LearningsConfigSchema.optional(),
};

const FitnessAppHostProfileSchema = z.strictObject({
	...BaseProfileFields, adapter: z.literal('fitness-app'), commands: z.array(ArgvSchema).min(1).optional(),
});

const ScriptHostProfileSchema = z.strictObject({
	...BaseProfileFields, adapter: z.literal('script'),
	hydration: HydrationConfigSchema, commands: z.array(ArgvSchema).min(1), workspace: DeclarativeWorkspaceSchema,
});

export const HostProfileSchema = z.discriminatedUnion('adapter', [FitnessAppHostProfileSchema, ScriptHostProfileSchema]);

type ResolvedHostProfileDirs = { stateDir: string; reviewDir: string; specDraftDir: string; verify: HostVerifyConfig };

export type PathScopedPromptRule = z.infer<typeof PathScopedRuleSchema>;
export type HostPromptsConfig = z.infer<typeof PromptsConfigSchema>;
export type HostGitConfig = z.infer<typeof GitConfigSchema>;
export type HostWorkspaceConfig = z.infer<typeof DeclarativeWorkspaceSchema>;
export type HostHydrationUntrackedCopyRule = z.infer<typeof HydrationUntrackedCopyRuleSchema>;
export type HostHydrationConditionalBuildRule = z.infer<typeof HydrationConditionalBuildRuleSchema>;
export type HostHydrationPackageArtifactCopyRule = z.infer<typeof HydrationPackageArtifactCopyRuleSchema>;
export type HostDeclarativeHydrationConfig = z.infer<typeof DeclarativeHydrationObjectSchema>;
export type HostHydrationConfig = z.infer<typeof HydrationConfigSchema>;
export type HostContractProducerRules = z.infer<typeof ContractProducerRulesSchema>;
export type HostPolicyConfig = z.infer<typeof PolicyConfigSchema>;
export type HostArchitectureImportRule = z.infer<typeof ArchitectureImportRuleSchema>;
export type HostArchitectureConfig = z.infer<typeof ArchitectureConfigSchema>;
export type HostQualityGateConfig = z.infer<typeof QualityGateConfigSchema>;
export type HostLearningScopeInferenceRule = z.infer<typeof LearningScopeInferenceRuleSchema>;
export type HostLearningsConfig = z.infer<typeof LearningsConfigSchema>;
export type FitnessAppHostProfile = Omit<z.infer<typeof FitnessAppHostProfileSchema>, keyof ResolvedHostProfileDirs> & ResolvedHostProfileDirs;
export type ScriptHostProfile = Omit<z.infer<typeof ScriptHostProfileSchema>, keyof ResolvedHostProfileDirs> & ResolvedHostProfileDirs;
export type HostProfile = FitnessAppHostProfile | ScriptHostProfile;

function invalidHostProfile(detail: string, metadata: Record<string, unknown> = {}, cause?: unknown): never {
	throw new SdlcError('INVALID_INPUT', `HOST_PROFILE_INVALID: ${detail}`, metadata, cause !== undefined ? { cause } : {});
}

function validateContainedRelativePath(
	rootDir: string,
	candidate: string,
	fieldName: string,
	{ allowDot = false }: { allowDot?: boolean } = {},
): string {
	if (typeof candidate !== 'string' || candidate.length === 0) {
		invalidHostProfile(`${fieldName} must be a non-empty relative path`, { fieldName });
	}
	if (
		candidate.startsWith('/') ||
		candidate.startsWith('\\') ||
		candidate.includes('\\') ||
		path.posix.isAbsolute(candidate) ||
		path.isAbsolute(candidate)
	) {
		invalidHostProfile(`${fieldName} '${candidate}' must be a relative path`, { fieldName, candidate });
	}
	if (candidate === '.') {
		if (!allowDot) invalidHostProfile(`${fieldName} cannot be '.'`, { fieldName, candidate });
	} else {
		const segments = candidate.split('/');
		if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
			invalidHostProfile(`${fieldName} '${candidate}' contains an invalid path segment`, { fieldName, candidate });
		}
	}

	const resolvedRoot = path.resolve(rootDir);
	const resolvedCandidate = path.resolve(resolvedRoot, candidate);
	const lexicallyInside = allowDot
		? resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
		: resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
	if (!lexicallyInside) {
		invalidHostProfile(`${fieldName} '${candidate}' resolves outside rootDir`, { fieldName, candidate });
	}

	if (fs.existsSync(resolvedRoot)) {
		const realRoot = fs.realpathSync(resolvedRoot);
		const relSegments = candidate === '.' ? [] : candidate.split('/');
		let current = resolvedRoot;
		for (const segment of relSegments) {
			const next = path.join(current, segment);
			if (!fs.existsSync(next)) break;
			const realNext = fs.realpathSync(next);
			if (realNext !== realRoot && !realNext.startsWith(`${realRoot}${path.sep}`)) {
				invalidHostProfile(`${fieldName} '${candidate}' escapes rootDir via symlink`, { fieldName, candidate });
			}
			current = next;
		}
	}
	return candidate;
}

export function loadHostProfile(rootDir: string = REPOSITORY_ROOT): Readonly<HostProfile> {
	if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
		invalidHostProfile('rootDir must be a non-empty string');
	}
	const profilePath = path.join(path.resolve(rootDir), HOST_PROFILE_RELATIVE_PATH);
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(profilePath);
	} catch (error: unknown) {
		invalidHostProfile(`Missing or unreadable host profile at ${HOST_PROFILE_RELATIVE_PATH}`, { profilePath }, error);
	}
	if (!stat.isFile() || stat.isSymbolicLink()) {
		invalidHostProfile(`${HOST_PROFILE_RELATIVE_PATH} must be a regular file`, { profilePath });
	}
	if (stat.size === 0 || stat.size > MAX_HOST_PROFILE_BYTES) {
		invalidHostProfile(
			`${HOST_PROFILE_RELATIVE_PATH} size ${stat.size} must be between 1 and ${MAX_HOST_PROFILE_BYTES} bytes`,
			{ size: stat.size },
		);
	}

	let rawText: string;
	try {
		rawText = fs.readFileSync(profilePath, 'utf8');
	} catch (error: unknown) {
		invalidHostProfile(`Cannot read ${HOST_PROFILE_RELATIVE_PATH}`, { profilePath }, error);
	}

	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(rawText);
	} catch (error: unknown) {
		invalidHostProfile(`${HOST_PROFILE_RELATIVE_PATH} is not valid JSON`, { profilePath }, error);
	}

	if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
		invalidHostProfile(`${HOST_PROFILE_RELATIVE_PATH} must be a JSON object`, { profilePath });
	}

	const rawRecord = parsedJson as Record<string, unknown>;
	if (
		rawRecord.schemaVersion !== HOST_PROFILE_SCHEMA_VERSION &&
		rawRecord.schemaVersion !== LEGACY_HOST_PROFILE_SCHEMA_VERSION
	) {
		invalidHostProfile(
			`Expected schemaVersion '${HOST_PROFILE_SCHEMA_VERSION}', got '${String(rawRecord.schemaVersion)}'`,
			{ schemaVersion: String(rawRecord.schemaVersion ?? '') },
		);
	}

	if (rawRecord.schemaVersion === LEGACY_HOST_PROFILE_SCHEMA_VERSION) {
		for (const requiredKey of ['stateDir', 'reviewDir', 'specDraftDir']) {
			if (typeof rawRecord[requiredKey] !== 'string' || rawRecord[requiredKey].length === 0) {
				invalidHostProfile(
					`Field '${requiredKey}' is required at schemaVersion '${LEGACY_HOST_PROFILE_SCHEMA_VERSION}'`,
					{ fieldName: requiredKey, schemaVersion: rawRecord.schemaVersion },
				);
			}
		}
		for (const key of ['runsDir', 'git', 'policy', 'architecture', 'qualityGate', 'learnings']) {
			if (rawRecord[key] !== undefined) {
				invalidHostProfile(`Field '${key}' requires schemaVersion '${HOST_PROFILE_SCHEMA_VERSION}'`, {
					fieldName: key,
					schemaVersion: rawRecord.schemaVersion,
				});
			}
		}
		if (rawRecord.adapter === 'fitness-app') {
			for (const forbidden of ['hydration', 'commands', 'workspace']) {
				if (rawRecord[forbidden] !== undefined) {
					invalidHostProfile(
						`fitness-app profile at schemaVersion '${LEGACY_HOST_PROFILE_SCHEMA_VERSION}' cannot include '${forbidden}'`,
						{ fieldName: forbidden },
					);
				}
			}
		}
	} else if (rawRecord.adapter === 'fitness-app' && rawRecord.commands !== undefined) {
		invalidHostProfile("fitness-app profile cannot include 'commands'", { fieldName: 'commands' });
	}

	const parsed = HostProfileSchema.safeParse(parsedJson);
	if (!parsed.success) {
		const issueSummary = parsed.error.issues
			.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
			.join('; ');
		invalidHostProfile(issueSummary, { profilePath });
	}

	const checkRel = (candidate: string | undefined, field: string, allowDot = false): void => {
		if (candidate !== undefined) validateContainedRelativePath(rootDir, candidate, field, { allowDot });
	};
	const checkRelList = (items: readonly string[] | undefined, field: string, allowDot = false): void => {
		for (const item of items ?? []) validateContainedRelativePath(rootDir, item, field, { allowDot });
	};

	const resolvedStateDir = parsed.data.stateDir ?? '.agent-sdlc';
	const resolvedReviewDir = parsed.data.reviewDir ?? `${resolvedStateDir}/reviews`;
	const resolvedSpecDraftDir = parsed.data.specDraftDir ?? `${resolvedStateDir}/specs/drafts`;
	const resolvedVerify = resolveHostVerifyConfig(parsed.data.verify, parsed.data.schemaVersion, checkRel);
	const profile: HostProfile = {
		...parsed.data,
		stateDir: resolvedStateDir,
		reviewDir: resolvedReviewDir,
		specDraftDir: resolvedSpecDraftDir,
		verify: resolvedVerify,
	};

	checkRel(profile.stateDir, 'stateDir');
	checkRel(profile.reviewDir, 'reviewDir');
	checkRel(profile.specDraftDir, 'specDraftDir');
	checkRel(profile.runsDir, 'runsDir');

	if (profile.prompts) {
		checkRel(profile.prompts.roleAddendaDir, 'prompts.roleAddendaDir');
		checkRel(profile.prompts.rubricAddendaDir, 'prompts.rubricAddendaDir');
		for (const rule of profile.prompts.pathScopedRules ?? []) {
			checkRel(rule.addendaFile, 'prompts.pathScopedRules.addendaFile');
			checkRelList(rule.pathPrefixes, 'prompts.pathScopedRules.pathPrefixes');
		}
	}

	if (profile.workspace) {
		const w = profile.workspace;
		const hasAny =
			(w.directories?.length ?? 0) > 0 || (w.packageRoots?.length ?? 0) > 0 ||
			(w.singlePackages?.length ?? 0) > 0 || (w.allowedPathRoots?.length ?? 0) > 0;
		if (profile.adapter === 'script' && !hasAny) {
			invalidHostProfile('workspace must declare at least one directory, packageRoot, singlePackage, or allowedPathRoot', { fieldName: 'workspace' });
		}
		checkRelList(w.directories, 'workspace.directories', true);
		checkRelList(w.packageRoots, 'workspace.packageRoots', true);
		checkRelList(w.singlePackages, 'workspace.singlePackages', true);
		checkRelList(w.allowedPathRoots, 'workspace.allowedPathRoots', true);
	}

	if (profile.hydration && !Array.isArray(profile.hydration)) {
		const h = profile.hydration as HostDeclarativeHydrationConfig;
		for (const c of h.untrackedCopies ?? []) {
			checkRel(c.source, 'hydration.untrackedCopies.source');
			checkRel(c.target, 'hydration.untrackedCopies.target');
		}
		for (const b of h.conditionalBuilds ?? []) checkRel(b.skipIfExists, 'hydration.conditionalBuilds.skipIfExists');
		for (const a of h.packageArtifactCopies ?? []) {
			checkRel(a.packageRoot, 'hydration.packageArtifactCopies.packageRoot');
			checkRel(a.artifactRelativePath, 'hydration.packageArtifactCopies.artifactRelativePath');
		}
	}

	if (profile.policy) {
		checkRelList(profile.policy.highRiskPaths, 'policy.highRiskPaths');
		checkRelList(profile.policy.protectedBaselinePaths, 'policy.protectedBaselinePaths');
		for (const p of profile.policy.irreversiblePatterns ?? []) validateRegexPattern(p, 'policy.irreversiblePatterns');
	}

	if (profile.architecture) {
		for (const rule of profile.architecture.importRules ?? []) {
			validateRegexPattern(rule.forbiddenSpecifierPattern, 'architecture.importRules.forbiddenSpecifierPattern');
			if (rule.sourcePathPattern !== undefined) validateRegexPattern(rule.sourcePathPattern, 'architecture.importRules.sourcePathPattern');
			if (rule.allowedSpecifierPattern !== undefined) validateRegexPattern(rule.allowedSpecifierPattern, 'architecture.importRules.allowedSpecifierPattern');
		}
	}

	if (profile.qualityGate) {
		checkRel(profile.qualityGate.eslintConfigPath, 'qualityGate.eslintConfigPath');
		checkRel(profile.qualityGate.baselinePath, 'qualityGate.baselinePath');
		checkRel(profile.qualityGate.exceptionsPath, 'qualityGate.exceptionsPath');
	}

	if (profile.learnings) {
		checkRel(profile.learnings.filePath, 'learnings.filePath');
		for (const rule of profile.learnings.scopeInference ?? []) {
			checkRel(rule.exact, 'learnings.scopeInference.exact', true);
			for (const [key, val] of [['prefix', rule.prefix], ['pathPrefix', rule.pathPrefix]] as const) {
				if (val !== undefined) {
					const cleanPrefix = val.replace(/\/+$/, '');
					if (cleanPrefix.length > 0) checkRel(cleanPrefix, `learnings.scopeInference.${key}`, true);
				}
			}
			if (rule.pattern !== undefined) validateRegexPattern(rule.pattern, 'learnings.scopeInference.pattern');
		}
	}

	return deepFreezeProfile(profile);
}

function validateRegexPattern(pattern: string, fieldName: string): void {
	try {
		new RegExp(pattern);
	} catch (error: unknown) {
		invalidHostProfile(`${fieldName} '${pattern}' is not a valid regular expression`, { fieldName, pattern }, error);
	}
}

export function hasHostProfile(rootDir: string): boolean {
	if (typeof rootDir !== 'string' || rootDir.trim().length === 0) return false;
	return fs.existsSync(path.join(path.resolve(rootDir), HOST_PROFILE_RELATIVE_PATH));
}

export function loadHostProfileOrFallback(rootDir: string = REPOSITORY_ROOT): Readonly<HostProfile> {
	if (hasHostProfile(rootDir)) return loadHostProfile(rootDir);
	if (rootDir !== REPOSITORY_ROOT && hasHostProfile(REPOSITORY_ROOT)) {
		return deepFreezeProfile({
			...loadHostProfile(REPOSITORY_ROOT),
			verify: { argv: [...DEFAULT_VERIFY_ARGV] },
		});
	}
	return deepFreezeProfile({
		schemaVersion: HOST_PROFILE_SCHEMA_VERSION,
		profileId: 'default-host',
		repositoryId: 'default-host',
		adapter: 'fitness-app',
		stateDir: 'tools/.agent-sdlc',
		reviewDir: 'tools/.review',
		specDraftDir: 'docs/specs/drafts',
		runsDir: 'docs/specs/runs',
		verify: {
			argv: [...DEFAULT_VERIFY_ARGV],
		},
	});
}

function deepFreezeProfile<T>(value: T): Readonly<T> {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreezeProfile(child);
	}
	return value;
}
