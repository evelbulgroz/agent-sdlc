import fs from 'node:fs';
import path from 'node:path';
import {
	HOST_PROFILE_RELATIVE_PATH,
	type PathScopedPromptRule,
	loadHostProfile,
} from '../host/host-profile.ts';
import {
	INSERTION_POINTS,
	type InsertionPoint,
	type RoleDefinition,
	type WorkflowDefinition,
	sha256,
	validateRoleDefinition,
	validateWorkflowDefinition,
} from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { evaluatorRegistryHash, hasEvaluator } from '../review/evaluator-registry.ts';
import { capabilityRegistryHash, hasCapability } from './capability-registry.ts';

export const PACKAGE_ROLE_DEFAULTS_ROOT = path.join(import.meta.dirname, 'defaults');

const FORBIDDEN_CONFIGURATION_KEYS = new Set([
	'command',
	'commands',
	'executable',
	'script',
	'shell',
	'tool',
	'tools',
	'provider',
	'apiKey',
	'credential',
	'transition',
	'approval',
]);

export interface LoadedRoleHashes {
	readonly roleHash: string;
	readonly promptPolicyHash: string;
	readonly capabilitySetHash: string;
	readonly evaluatorSetHash: string;
}

export interface LoadedWorkflowHashes extends LoadedRoleHashes {
	readonly workflowHash: string;
}

export interface LoadedRole {
	readonly role: Readonly<RoleDefinition>;
	readonly promptPolicy: string;
	readonly hashes: LoadedRoleHashes;
}

export interface LoadedPipelineRole extends LoadedRole {
	readonly roleId: string;
}

export interface LoadedWorkflowBundle {
	readonly workflow: Readonly<WorkflowDefinition>;
	readonly role: Readonly<RoleDefinition>;
	readonly promptPolicy: string;
	readonly hashes: LoadedWorkflowHashes;
}

export interface LoadRoleOptions {
	readonly authoredPaths?: readonly string[];
	readonly touchedFiles?: ReadonlyArray<string | { readonly path?: string }>;
}

export interface ResolvedHostPromptsConfig {
	readonly preset: 'default' | 'none';
	readonly roleAddendaDir: string;
	readonly rubricAddendaDir: string;
	readonly pathScopedRules: readonly PathScopedPromptRule[];
}

export interface ValidatedPathScopedRule extends PathScopedPromptRule {
	readonly content: string;
}

export function isDeterministicRole(role: unknown): boolean {
	if (!role || typeof role !== 'object') return false;
	const rec = role as { role?: { modelProfile?: unknown }; modelProfile?: unknown };
	const target = rec.role && typeof rec.role === 'object' ? rec.role : rec;
	return target.modelProfile === 'agent-sdlc-deterministic';
}

export function matchesPathPrefix(candidatePath: string, prefix: string): boolean {
	const normCandidate = candidatePath
		.replace(/\\/g, '/')
		.replace(/^\.\//, '')
		.replace(/\/+$/, '');
	const normPrefix = prefix
		.replace(/\\/g, '/')
		.replace(/^\.\//, '')
		.replace(/\/+$/, '');
	if (!normCandidate || !normPrefix) return false;
	return normCandidate === normPrefix || normCandidate.startsWith(`${normPrefix}/`);
}

export function resolveHostPromptsConfig(rootDir: string): ResolvedHostPromptsConfig {
	const profilePath = path.join(path.resolve(rootDir), HOST_PROFILE_RELATIVE_PATH);
	if (!fs.existsSync(profilePath)) {
		return {
			preset: 'default',
			roleAddendaDir: '.agents/workflows/prompts',
			rubricAddendaDir: '.agents/review-rubrics',
			pathScopedRules: [],
		};
	}
	const profile = loadHostProfile(rootDir);
	return {
		preset: profile.prompts?.preset ?? 'default',
		roleAddendaDir: profile.prompts?.roleAddendaDir ?? '.agents/workflows/prompts',
		rubricAddendaDir: profile.prompts?.rubricAddendaDir ?? '.agents/review-rubrics',
		pathScopedRules: profile.prompts?.pathScopedRules ?? [],
	};
}

export function loadAndValidatePathScopedRules(
	rootDir: string,
	rules: readonly PathScopedPromptRule[],
): ValidatedPathScopedRule[] {
	if (rules.length === 0) return [];
	let realRoot: string;
	try {
		realRoot = fs.realpathSync(rootDir);
	} catch (error: unknown) {
		throw new SdlcError(
			'INVALID_CONTRACT',
			`Host root directory is unreadable: ${rootDir}`,
			{},
			{ cause: error },
		);
	}
	const validated: ValidatedPathScopedRule[] = [];
	for (const rule of rules) {
		const candidatePath = path.join(rootDir, rule.addendaFile);
		let realCandidate: string;
		try {
			realCandidate = fs.realpathSync(candidatePath);
		} catch (error: unknown) {
			throw new SdlcError(
				'INVALID_CONTRACT',
				`Path-scoped addendum file is missing or unreadable: ${rule.addendaFile}`,
				{ ruleId: rule.id, addendaFile: rule.addendaFile },
				{ cause: error },
			);
		}
		if (!realCandidate.startsWith(`${realRoot}${path.sep}`)) {
			throw new SdlcError(
				'PATH_OUTSIDE_ROOT',
				`Path-scoped addendum escapes rootDir: ${rule.addendaFile}`,
				{ ruleId: rule.id, addendaFile: rule.addendaFile },
			);
		}
		const content = fs.readFileSync(realCandidate, 'utf8').trim();
		if (!content) {
			throw new SdlcError(
				'INVALID_CONTRACT',
				`Path-scoped addendum file is empty: ${rule.addendaFile}`,
				{ ruleId: rule.id, addendaFile: rule.addendaFile },
			);
		}
		rejectExecutablePrompt(content);
		validated.push({ ...rule, content });
	}
	return validated;
}

export class RoleRegistry {
	readonly rootDir: string;
	readonly workflowRoot: string;
	readonly workflowPath: string;
	readonly defaultAuthoredPaths: readonly string[];
	private _workflow: Readonly<WorkflowDefinition> | null;

	constructor({
		rootDir,
		workflowPath,
		authoredPaths,
	}: {
		rootDir?: string;
		workflowPath?: string;
		authoredPaths?: readonly string[];
	} = {}) {
		this.rootDir = rootDir ?? process.cwd();
		this.defaultAuthoredPaths = authoredPaths ?? [];
		const localWorkflowRoot = path.join(this.rootDir, '.agents/workflows');
		if (workflowPath) {
			const fallbackCandidate = path.join(
				PACKAGE_ROLE_DEFAULTS_ROOT,
				path.basename(workflowPath),
			);
			this.workflowPath =
				!fs.existsSync(workflowPath) && fs.existsSync(fallbackCandidate)
					? fallbackCandidate
					: workflowPath;
		} else {
			const localSpec = path.join(localWorkflowRoot, 'specification.json');
			this.workflowPath = fs.existsSync(localSpec)
				? localSpec
				: path.join(PACKAGE_ROLE_DEFAULTS_ROOT, 'specification.json');
		}
		this.workflowRoot = path.dirname(this.workflowPath);
		this._workflow = null;
	}

	loadWorkflow(): Readonly<WorkflowDefinition> {
		if (this._workflow) return this._workflow;
		const workflowDir = path.dirname(this.workflowPath);
		const workflowRaw = readContainedJson(workflowDir, this.workflowPath);
		rejectExecutableConfiguration(workflowRaw, 'workflow');
		const workflow = validateWorkflowDefinition(workflowRaw);
		if (workflow.pipelines) {
			const seenRoles = new Set<string>();
			for (const [point, roleIds] of Object.entries(workflow.pipelines)) {
				if (!(INSERTION_POINTS as readonly string[]).includes(point)) {
					throw new SdlcError('INVALID_CONTRACT', `Invalid insertion point '${point}'`);
				}
				for (const roleId of roleIds ?? []) {
					if (seenRoles.has(roleId)) {
						throw new SdlcError(
							'INVALID_CONTRACT',
							`Duplicate role '${roleId}' across workflow pipelines`,
						);
					}
					seenRoles.add(roleId);
					const loaded = this.loadRole(roleId);
					if (loaded.role.insertionPoint && loaded.role.insertionPoint !== point) {
						throw new SdlcError(
							'INVALID_CONTRACT',
							`Role '${roleId}' declared insertionPoint '${loaded.role.insertionPoint}' does not match pipeline '${point}'`,
						);
					}
				}
			}
			if (workflow.roles) {
				for (const roleId of seenRoles) {
					if (!workflow.roles.includes(roleId)) {
						throw new SdlcError(
							'INVALID_CONTRACT',
							`Role '${roleId}' in pipeline is not declared in workflow.roles`,
						);
					}
				}
			}
		}
		this._workflow = workflow;
		return this._workflow;
	}

	loadPipeline(insertionPoint: string, options?: LoadRoleOptions): LoadedPipelineRole[] {
		if (!(INSERTION_POINTS as readonly string[]).includes(insertionPoint)) {
			throw new SdlcError('INVALID_CONTRACT', `Invalid insertion point '${insertionPoint}'`);
		}
		const workflow = this.loadWorkflow();
		const roleIds = workflow.pipelines?.[insertionPoint as InsertionPoint] ?? [];
		return roleIds.map((roleId) => {
			const loaded = this.loadRole(roleId, options);
			return Object.freeze({
				roleId,
				...loaded,
			});
		});
	}

	load(options?: LoadRoleOptions): LoadedWorkflowBundle {
		const workflow = this.loadWorkflow();
		const loadedRole = this.loadRole(workflow.roleId, options);
		return Object.freeze({
			workflow,
			role: loadedRole.role,
			promptPolicy: loadedRole.promptPolicy,
			hashes: Object.freeze({
				workflowHash: sha256(workflow),
				roleHash: loadedRole.hashes.roleHash,
				promptPolicyHash: loadedRole.hashes.promptPolicyHash,
				capabilitySetHash: capabilityRegistryHash(),
				evaluatorSetHash: evaluatorRegistryHash(),
			}),
		});
	}

	loadRole(
		roleId: string,
		options?: LoadRoleOptions | readonly string[],
	): LoadedRole {
		const localRolesRoot = path.join(this.rootDir, '.agents/workflows/roles');
		const localRolePath = path.join(localRolesRoot, `${roleId}.json`);
		const defaultRolesRoot = path.join(PACKAGE_ROLE_DEFAULTS_ROOT, 'roles');
		const defaultRolePath = path.join(defaultRolesRoot, `${roleId}.json`);
		const useLocalRole = fs.existsSync(localRolesRoot) && (fs.existsSync(localRolePath) || !fs.existsSync(defaultRolePath));
		const rolesRoot = useLocalRole ? localRolesRoot : defaultRolesRoot;
		const rolePath = useLocalRole ? localRolePath : defaultRolePath;

		const roleRaw = readContainedJson(rolesRoot, rolePath);
		rejectExecutableConfiguration(roleRaw, 'role');
		const role = validateRoleDefinition(roleRaw);
		if (role.roleId !== roleId) {
			throw new SdlcError('INVALID_CONTRACT', 'Role ID does not match expected ID');
		}
		if (!hasCapability(role.capabilityId)) {
			throw new SdlcError('INVALID_CONTRACT', `Unknown capability '${role.capabilityId}'`);
		}
		if (!hasEvaluator(role.evaluatorId)) {
			throw new SdlcError('INVALID_CONTRACT', `Unknown evaluator '${role.evaluatorId}'`);
		}
		if (isDeterministicRole(role)) {
			if (
				role.requestedLimits.maxPromptTokens !== 0 ||
				role.requestedLimits.maxCompletionTokens !== 0
			) {
				throw new SdlcError(
					'INVALID_CONTRACT',
					`Deterministic role '${roleId}' must have 0 prompt and completion token limits`,
				);
			}
		}

		const promptsConfig = resolveHostPromptsConfig(this.rootDir);
		const scopedRules = loadAndValidatePathScopedRules(
			this.rootDir,
			promptsConfig.pathScopedRules,
		);

		const protocolRoot = path.join(PACKAGE_ROLE_DEFAULTS_ROOT, 'protocol');
		const protocolPath = path.join(protocolRoot, role.promptFile);
		const philosophyRoot = path.join(PACKAGE_ROLE_DEFAULTS_ROOT, 'philosophy');
		const philosophyPath = path.join(philosophyRoot, role.promptFile);
		const hostPromptsRoot = path.join(this.rootDir, promptsConfig.roleAddendaDir);
		const hostPromptPath = path.join(hostPromptsRoot, role.promptFile);

		const fragments: string[] = [];

		if (fs.existsSync(protocolPath)) {
			const layer1 = readContainedText(protocolRoot, protocolPath).trim();
			rejectExecutablePrompt(layer1);
			if (layer1) fragments.push(layer1);
		}

		if (promptsConfig.preset === 'default' && fs.existsSync(philosophyPath)) {
			const layer2 = readContainedText(philosophyRoot, philosophyPath).trim();
			rejectExecutablePrompt(layer2);
			if (layer2) fragments.push(layer2);
		}

		if (fs.existsSync(hostPromptsRoot) && (fs.existsSync(hostPromptPath) || fragments.length === 0)) {
			const layer3 = readContainedText(hostPromptsRoot, hostPromptPath).trim();
			rejectExecutablePrompt(layer3);
			if (layer3) fragments.push(layer3);
		}

		if (fragments.length === 0) {
			throw new SdlcError(
				'INVALID_CONTRACT',
				`Configuration file is unreadable: ${hostPromptPath}`,
			);
		}

		const candidatePaths = extractCandidatePaths(options, this.defaultAuthoredPaths);
		for (const rule of scopedRules) {
			const roleMatches = rule.roles ? rule.roles.includes(roleId) : !rule.phases;
			const pathMatches = candidatePaths.some((candidate) =>
				rule.pathPrefixes.some((prefix) => matchesPathPrefix(candidate, prefix)),
			);
			if (roleMatches && pathMatches) {
				fragments.push(rule.content);
			}
		}

		const promptPolicy = `${fragments.join('\n\n')}\n`;
		rejectExecutablePrompt(promptPolicy);
		return Object.freeze({
			role,
			promptPolicy,
			hashes: Object.freeze({
				roleHash: sha256(role),
				promptPolicyHash: sha256(promptPolicy),
				capabilitySetHash: capabilityRegistryHash(),
				evaluatorSetHash: evaluatorRegistryHash(),
			}),
		});
	}
}

function extractCandidatePaths(
	options: LoadRoleOptions | readonly string[] | undefined,
	fallbackPaths: readonly string[],
): string[] {
	let raw: readonly (string | { readonly path?: string })[];
	if (Array.isArray(options)) {
		raw = options as readonly string[];
	} else if (options && typeof options === 'object') {
		const opts = options as LoadRoleOptions;
		raw = opts.authoredPaths ?? opts.touchedFiles ?? fallbackPaths;
	} else {
		raw = fallbackPaths;
	}
	const paths: string[] = [];
	for (const entry of raw) {
		if (typeof entry === 'string' && entry.length > 0) {
			paths.push(entry);
		} else if (entry && typeof entry === 'object' && 'path' in entry && typeof entry.path === 'string' && entry.path.length > 0) {
			paths.push(entry.path);
		}
	}
	return paths;
}

function readContainedJson(root: string, candidate: string): unknown {
	try {
		return JSON.parse(readContainedText(root, candidate));
	} catch (error: unknown) {
		if (error instanceof SdlcError) throw error;
		throw new SdlcError(
			'INVALID_CONTRACT',
			`Invalid JSON configuration: ${candidate}`,
			{},
			{
				cause: error,
			},
		);
	}
}

function readContainedText(root: string, candidate: string): string {
	let realRoot: string;
	try {
		realRoot = fs.realpathSync(root);
	} catch (error: unknown) {
		throw new SdlcError(
			'INVALID_CONTRACT',
			`Configuration directory is unreadable: ${root}`,
			{},
			{
				cause: error,
			},
		);
	}
	let realCandidate: string;
	try {
		realCandidate = fs.realpathSync(candidate);
	} catch (error: unknown) {
		throw new SdlcError(
			'INVALID_CONTRACT',
			`Configuration file is unreadable: ${candidate}`,
			{},
			{
				cause: error,
			},
		);
	}
	if (path.dirname(realCandidate) !== realRoot) {
		throw new SdlcError('PATH_OUTSIDE_ROOT', 'Configuration must be a direct contained file');
	}
	return fs.readFileSync(realCandidate, 'utf8');
}

function rejectExecutableConfiguration(value: unknown, location: string): void {
	if (!value || typeof value !== 'object') return;
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (FORBIDDEN_CONFIGURATION_KEYS.has(key)) {
			throw new SdlcError(
				'INVALID_CONTRACT',
				`${location} contains forbidden executable or authority field '${key}'`,
			);
		}
		rejectExecutableConfiguration(child, `${location}.${key}`);
	}
}

export function rejectExecutablePrompt(prompt: string): void {
	if (
		/```(?:sh|bash|javascript|typescript|python)/i.test(prompt) ||
		/(?:child_process|process\.env|git\s+(?:push|commit)|rm\s+-rf|curl\s+https?:)/i.test(prompt)
	) {
		throw new SdlcError('INVALID_CONTRACT', 'Prompt policy contains executable instructions');
	}
}
