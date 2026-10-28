import {
	type HostProfile,
	loadHostProfile,
	loadHostProfileOrFallback,
} from '../host/host-profile.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import {
	RUNTIME_SCHEMA_VERSION,
	type RunAuthorization,
	sha256,
	validateRunAuthorization,
} from './contracts.ts';
import { SdlcError } from './errors.ts';

export const DEFAULT_AUTHORIZATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface CreateDefaultAuthorizationOptions {
	runId: string;
	approvedSpecHash: string;
	taskManifestHash?: string | null;
	repositoryId?: string;
	rootDir?: string;
	baseCommitSha: string;
	allowedPackages: readonly string[];
	allowedPathPrefixes: readonly string[];
	maxSemanticRepairs?: number;
	modelUsageProfile?: string;
	approvalMethod?: string;
	createBranch?: boolean;
	createLocalCommits?: boolean;
	push?: boolean;
	openPullRequest?: boolean;
	targetBranch?: string | null;
	now?: Date;
}

export function createDefaultAuthorizationEnvelope({
	runId,
	approvedSpecHash,
	taskManifestHash = null,
	repositoryId,
	rootDir = REPOSITORY_ROOT,
	baseCommitSha,
	allowedPackages,
	allowedPathPrefixes,
	maxSemanticRepairs = 2,
	modelUsageProfile = 'agent-sdlc-default',
	approvalMethod = 'cli_prompt',
	createBranch = false,
	createLocalCommits = false,
	push = false,
	openPullRequest = false,
	targetBranch = null,
	now = new Date(),
}: CreateDefaultAuthorizationOptions): RunAuthorization {
	const resolvedRepositoryId =
		typeof repositoryId === 'string' && repositoryId.trim().length > 0
			? repositoryId
			: loadHostProfile(rootDir).repositoryId;
	const approvedPlanPolicyHash = sha256({
		runId,
		approvedSpecHash,
		taskManifestHash,
		baseCommitSha,
		allowedPackages: [...allowedPackages].sort(),
		allowedPathPrefixes: [...allowedPathPrefixes].sort(),
		maxSemanticRepairs,
		createBranch: Boolean(createBranch),
		createLocalCommits: Boolean(createLocalCommits),
		push: Boolean(push),
		openPullRequest: Boolean(openPullRequest),
		targetBranch: targetBranch ?? null,
	});

	const envelope = {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		runId,
		approvedSpecHash,
		taskManifestHash,
		approvedPlanPolicyHash,
		repositoryId: resolvedRepositoryId,
		baseCommitSha,
		allowedPackages: [...allowedPackages],
		allowedPathPrefixes: [...allowedPathPrefixes],
		allowedOperations: {
			editIsolatedWorktree: true,
			runAllowlistedCommands: true,
			createDetachedWorktree: true,
			createBranch: Boolean(createBranch),
			createLocalCommits: Boolean(createLocalCommits),
			push: Boolean(push),
			openPullRequest: Boolean(openPullRequest),
			merge: false,
			deploy: false,
		},
		targetBranch,
		maxSemanticRepairs,
		modelUsageProfile,
		expiresAt: new Date(now.getTime() + DEFAULT_AUTHORIZATION_TTL_MS).toISOString(),
		approvedAt: now.toISOString(),
		approvalMethod,
	};

	return validateRunAuthorization(envelope);
}

export interface ValidateAuthorizationOptions {
	currentRunId?: string;
	currentBaseCommitSha?: string;
	currentSpecHash?: string;
	currentTaskManifestHash?: string | null;
	rootDir?: string;
	profile?: Readonly<HostProfile>;
	now?: Date;
}

export function validateAuthorizationEnvelope(
	envelope: unknown,
	{
		currentRunId,
		currentBaseCommitSha,
		currentSpecHash,
		currentTaskManifestHash,
		rootDir = REPOSITORY_ROOT,
		profile,
		now = new Date(),
	}: ValidateAuthorizationOptions = {},
): RunAuthorization {
	const validated = validateRunAuthorization(envelope);

	if (currentRunId && validated.runId !== currentRunId) {
		throw new SdlcError(
			'AUTHORIZATION_INVALID',
			'Run ID mismatch between envelope and runtime state',
			{
				expectedRunId: currentRunId,
				actualRunId: validated.runId,
			},
		);
	}

	if (currentBaseCommitSha && validated.baseCommitSha !== currentBaseCommitSha) {
		throw new SdlcError(
			'AUTHORIZATION_INVALID',
			'Base commit SHA mismatch between envelope and repository state',
			{
				expectedSha: currentBaseCommitSha,
				actualSha: validated.baseCommitSha,
			},
		);
	}

	if (currentSpecHash && validated.approvedSpecHash !== currentSpecHash) {
		throw new SdlcError(
			'AUTHORIZATION_INVALID',
			'Approved spec hash mismatch between envelope and runtime state',
			{
				expectedHash: currentSpecHash,
				actualHash: validated.approvedSpecHash,
			},
		);
	}

	if (
		currentTaskManifestHash !== undefined &&
		validated.taskManifestHash !== currentTaskManifestHash
	) {
		throw new SdlcError(
			'AUTHORIZATION_INVALID',
			'Task manifest hash mismatch between envelope and runtime state',
			{
				expectedHash: currentTaskManifestHash,
				actualHash: validated.taskManifestHash,
			},
		);
	}

	if (Date.parse(validated.expiresAt) <= now.getTime()) {
		throw new SdlcError('AUTHORIZATION_EXPIRED', 'Run authorization envelope has expired', {
			expiresAt: validated.expiresAt,
			checkedAt: now.toISOString(),
		});
	}

	const resolvedProfile = profile ?? loadHostProfileOrFallback(rootDir);
	const toolingRoots = (
		resolvedProfile.workspace?.allowedPathRoots ?? ['tools', '.agents', 'docs']
	).filter(
		(root) =>
			!(resolvedProfile.workspace?.packageRoots ?? []).includes(root) &&
			!(resolvedProfile.workspace?.singlePackages ?? []).includes(root),
	);

	for (const prefix of validated.allowedPathPrefixes) {
		if (prefix.includes('..') || prefix.startsWith('/') || prefix.startsWith('\\')) {
			throw new SdlcError(
				'PATH_CONTAINMENT_VIOLATION',
				`Allowed path prefix '${prefix}' contains traversal characters`,
				{ prefix },
			);
		}
		const matchesPackage = validated.allowedPackages.some(
			(pkg) => prefix.startsWith(pkg + '/') || prefix === pkg,
		);
		const matchesPermittedRoot =
			toolingRoots.some((root) => {
				const cleanRoot = root.replace(/\/+$/, '');
				return prefix === cleanRoot || prefix.startsWith(`${cleanRoot}/`);
			}) ||
			prefix.startsWith('tools/') ||
			prefix.startsWith('.agents/') ||
			prefix.startsWith('docs/') ||
			prefix === 'pnpm-lock.yaml';
		if (!matchesPackage && !matchesPermittedRoot) {
			throw new SdlcError(
				'PATH_CONTAINMENT_VIOLATION',
				`Allowed path prefix '${prefix}' is outside allowedPackages and repository tooling paths`,
				{ prefix, allowedPackages: validated.allowedPackages },
			);
		}
	}

	return validated;
}

export interface DraftScopeInput {
	touchedSurfaces?: readonly string[];
	owningContext?: string;
}

export interface TaskManifestScopeInput {
	tasks?: readonly {
		pathPrefixes?: readonly string[];
		targetPackage?: string;
	}[];
}

export function deriveScopeFromDraft(
	draft: DraftScopeInput | null | undefined,
	taskManifest: TaskManifestScopeInput | null = null,
	options: { rootDir?: string; profile?: Readonly<HostProfile> } = {},
): { allowedPackages: string[]; allowedPathPrefixes: string[] } {
	const resolvedProfile = options.profile ?? loadHostProfileOrFallback(options.rootDir);
	const packageRoots = [...(resolvedProfile.workspace?.packageRoots ?? ['packages'])].sort(
		(a, b) => b.length - a.length,
	);
	const singlePackages = [...(resolvedProfile.workspace?.singlePackages ?? [])].sort(
		(a, b) => b.length - a.length,
	);
	const allowedPathRoots = resolvedProfile.workspace?.allowedPathRoots ?? [
		'packages',
		'tools',
		'.agents',
		'docs',
	];

	const rawPrefixes = [
		...(Array.isArray(draft?.touchedSurfaces) && draft.touchedSurfaces.length > 0
			? draft.touchedSurfaces
			: draft?.owningContext
				? [draft.owningContext]
				: []),
	];
	if (taskManifest && Array.isArray(taskManifest.tasks)) {
		for (const task of taskManifest.tasks) {
			for (const p of task.pathPrefixes ?? []) {
				rawPrefixes.push(p);
			}
		}
	}
	const allowedPathPrefixes = [
		...new Set(
			rawPrefixes
				.map((p) => p.replace(/\/\*\*?$/, '').replace(/\/$/, ''))
				.filter(Boolean),
		),
	];

	let allowedPackages: string[] = [];
	const CONTEXT_MAP: Record<string, string> = {
		'Monorepo Tooling': 'tools',
	};
	const owning = draft?.owningContext ?? '';
	const mappedOwning = CONTEXT_MAP[owning] || owning;

	for (const prefix of allowedPathPrefixes) {
		const singleMatch = singlePackages.find(
			(sp) => prefix === sp || prefix.startsWith(`${sp}/`),
		);
		if (singleMatch) {
			allowedPackages.push(singleMatch);
			continue;
		}

		const pkgRootMatch = packageRoots.find(
			(pr) => prefix === pr || prefix.startsWith(`${pr}/`),
		);
		if (pkgRootMatch) {
			const rootSegs = pkgRootMatch.split('/').filter(Boolean);
			const prefixSegs = prefix.split('/').filter(Boolean);
			if (prefixSegs.length >= rootSegs.length + 1) {
				allowedPackages.push(prefixSegs.slice(0, rootSegs.length + 1).join('/'));
				continue;
			}
		}

		const parts = prefix.split('/');
		if (
			['tools', '.agents', 'docs'].includes(parts[0]) ||
			allowedPathRoots.includes(parts[0])
		) {
			allowedPackages.push(parts[0]);
		}
	}

	if (taskManifest && Array.isArray(taskManifest.tasks)) {
		for (const task of taskManifest.tasks) {
			if (task.targetPackage) {
				allowedPackages.push(task.targetPackage);
			}
		}
	}

	const cleanedOwning = mappedOwning.replace(/\/\*\*?$/, '').replace(/\/$/, '');
	if (
		cleanedOwning &&
		(packageRoots.some((pr) => cleanedOwning === pr || cleanedOwning.startsWith(`${pr}/`)) ||
			singlePackages.some((sp) => cleanedOwning === sp || cleanedOwning.startsWith(`${sp}/`)))
	) {
		allowedPackages.push(cleanedOwning);
	} else if (
		allowedPackages.length === 0 &&
		cleanedOwning &&
		allowedPathRoots.some((root) => {
			const cleanRoot = root.replace(/\/+$/, '');
			return cleanedOwning === cleanRoot || cleanedOwning.startsWith(`${cleanRoot}/`);
		})
	) {
		allowedPackages.push(cleanedOwning);
	}

	allowedPackages = Array.from(new Set(allowedPackages));

	return { allowedPackages, allowedPathPrefixes };
}
