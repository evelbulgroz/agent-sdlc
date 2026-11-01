// Normalization, hashing, selection and semantic validation for host `verificationPreparation` builds.
// The normalized policy hash is bound at authorization; the per-task selection is bound at plan freeze.
import { validateCommandAllowlist } from '../execution/tool-commands.ts';
import { sha256 } from '../policy/contracts/primitives.ts';
import { SdlcError } from '../policy/errors.ts';
import { resolveCommandPolicy } from './command-policy.ts';
import type { HostProfile } from './host-profile.ts';
import {
	orderPreparationBuilds,
	type VerificationPreparationBuild,
	type VerificationPreparationConfig,
} from './verification-preparation-schema.ts';
import { discoverWorkspace } from './workspace.ts';

export interface NormalizedPreparationBuild {
	readonly id: string;
	readonly targetPackages: readonly string[];
	readonly packagePath: string;
	readonly argv: readonly string[];
	readonly outputPathPrefixes: readonly string[];
	readonly dependsOn: readonly string[];
}

export interface PreparationPlanStep {
	readonly id: string;
	readonly packagePath: string;
	readonly argv: readonly string[];
	readonly outputPathPrefixes: readonly string[];
}

export interface PreparationPlan {
	/** Ordered steps: dependencies first, ties broken by id. Empty when nothing applies. */
	readonly steps: readonly PreparationPlanStep[];
	/** Hash of the ordered steps, or null when the plan is empty. */
	readonly selectionHash: string | null;
}

const EMPTY_PLAN: PreparationPlan = Object.freeze({ steps: Object.freeze([]), selectionHash: null });

function trimPath(value: string): string {
	return value === '.' ? value : value.replace(/\/+$/, '');
}

function sortedUnique(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function invalidPreparation(detail: string, metadata: Record<string, unknown> = {}, cause?: unknown): never {
	throw new SdlcError(
		'INVALID_INPUT',
		`VERIFICATION_PREPARATION_INVALID: ${detail}`,
		metadata,
		cause !== undefined ? { cause } : {},
	);
}

/** Canonical form of the declared builds (sorted by id), or null when none are declared. */
export function normalizePreparationPolicy(
	config: VerificationPreparationConfig | undefined | null,
): readonly NormalizedPreparationBuild[] | null {
	if (!config || config.builds.length === 0) return null;
	return config.builds
		.map((build: VerificationPreparationBuild) => ({
			id: build.id,
			targetPackages: sortedUnique(build.targetPackages.map(trimPath)),
			packagePath: trimPath(build.packagePath),
			argv: [...build.argv],
			outputPathPrefixes: sortedUnique(build.outputPathPrefixes.map(trimPath)),
			dependsOn: sortedUnique(build.dependsOn ?? []),
		}))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Hash bound into the run authorization; null when the host declares no preparation builds. */
export function computePreparationPolicyHash(config: VerificationPreparationConfig | undefined | null): string | null {
	const normalized = normalizePreparationPolicy(config);
	return normalized ? sha256({ verificationPreparation: normalized }) : null;
}

/**
 * Selects builds whose targetPackages match any of `targetPackages`, plus their transitive
 * prerequisites, in deterministic topological order.
 */
export function selectPreparationPlan(
	config: VerificationPreparationConfig | undefined | null,
	targetPackages: readonly string[],
): PreparationPlan {
	const normalized = normalizePreparationPolicy(config);
	if (!normalized) return EMPTY_PLAN;
	const targets = new Set(targetPackages.map(trimPath));
	const matched = normalized.filter((build) => build.targetPackages.some((target) => targets.has(target)));
	if (matched.length === 0) return EMPTY_PLAN;
	let orderedIds: string[];
	try {
		orderedIds = orderPreparationBuilds(normalized, matched.map((build) => build.id));
	} catch (error: unknown) {
		invalidPreparation((error as Error).message, {}, error);
	}
	const byId = new Map(normalized.map((build) => [build.id, build]));
	const steps = orderedIds.map((id) => {
		const build = byId.get(id) as NormalizedPreparationBuild;
		return Object.freeze({
			id,
			packagePath: build.packagePath,
			argv: Object.freeze([...build.argv]),
			outputPathPrefixes: Object.freeze([...build.outputPathPrefixes]),
		});
	});
	return Object.freeze({ steps: Object.freeze(steps), selectionHash: sha256({ preparationSteps: steps }) });
}

export interface PreparationSelectionBinding {
	/** Per-task and final-integration selections; tasks without builds are omitted. */
	readonly tasks: Readonly<Record<string, PreparationPlan>>;
	readonly final: PreparationPlan;
	/** Digest frozen into runtime state at plan time, or null when nothing is selected. */
	readonly digest: string | null;
}

/** Derives the per-task and union selections for a frozen task plan. */
export function computePreparationSelectionBinding(
	config: VerificationPreparationConfig | undefined | null,
	tasks: readonly { readonly taskId: string; readonly targetPackage: string }[],
): PreparationSelectionBinding {
	const perTask: Record<string, PreparationPlan> = {};
	for (const task of tasks) {
		const plan = selectPreparationPlan(config, [task.targetPackage]);
		if (plan.selectionHash) perTask[task.taskId] = plan;
	}
	const final = selectPreparationPlan(config, tasks.map((task) => task.targetPackage));
	const digest = final.selectionHash
		? sha256({
				tasks: Object.keys(perTask)
					.sort()
					.map((taskId) => ({ taskId, selectionHash: perTask[taskId]?.selectionHash })),
				final: final.selectionHash,
			})
		: null;
	return Object.freeze({ tasks: Object.freeze(perTask), final, digest });
}

/**
 * Plan-freeze entry point: the effective policy must still match the authorized binding before its
 * selection is derived and frozen.
 */
export function freezePreparationSelection(
	profile: Readonly<HostProfile>,
	authorizedPolicyHash: string | null | undefined,
	tasks: readonly { readonly taskId: string; readonly targetPackage: string }[],
): PreparationSelectionBinding {
	const actual = computePreparationPolicyHash(profile.verificationPreparation);
	if (actual !== (authorizedPolicyHash ?? null)) {
		throw new SdlcError(
			'AUTHORIZATION_INVALID',
			'Host verificationPreparation policy differs from the authorized binding; reauthorize the run',
			{ expectedPreparationPolicyHash: authorizedPolicyHash ?? null, actualPreparationPolicyHash: actual },
		);
	}
	return computePreparationSelectionBinding(profile.verificationPreparation, tasks);
}

/**
 * Recomputes the selection for a frozen plan and fails closed when it differs from the digest
 * frozen at plan time (changed selection, ordering, argv or scope).
 */
export function assertPreparationSelectionBinding(
	config: VerificationPreparationConfig | undefined | null,
	tasks: readonly { readonly taskId: string; readonly targetPackage: string }[],
	frozenDigest: string | null | undefined,
): PreparationSelectionBinding {
	const binding = computePreparationSelectionBinding(config, tasks);
	if (binding.digest !== (frozenDigest ?? null)) {
		throw new SdlcError(
			'AUTHORIZATION_INVALID',
			'Verification preparation selection differs from the frozen task plan binding; reauthorize the run',
			{ expectedSelectionHash: frozenDigest ?? null, actualSelectionHash: binding.digest },
		);
	}
	return binding;
}

/**
 * Semantic checks that need the workspace and command policy: every packagePath is a workspace
 * package (or declared repository scope) and every argv passes the existing command allowlist,
 * scoped to its own package. Throws before any worktree mutation.
 */
export function validatePreparationPolicy({
	profile,
	rootDir,
}: {
	profile: Readonly<HostProfile>;
	rootDir: string;
}): void {
	const normalized = normalizePreparationPolicy(profile.verificationPreparation);
	if (!normalized) return;
	const workspace = discoverWorkspace(rootDir, profile as HostProfile);
	const known = new Set([...workspace.directories.map(trimPath), ...(profile.workspace?.repositoryScopes ?? []).map(trimPath)]);
	const policy = resolveCommandPolicy(profile);
	for (const build of normalized) {
		if (!known.has(build.packagePath)) {
			invalidPreparation(`build '${build.id}' packagePath '${build.packagePath}' is not a workspace package`, {
				buildId: build.id,
				packagePath: build.packagePath,
			});
		}
		const [command, ...args] = build.argv;
		try {
			validateCommandAllowlist(command, args, [build.packagePath], rootDir, policy);
		} catch (error: unknown) {
			invalidPreparation(`build '${build.id}' argv is not allowlisted: ${(error as Error).message}`, { buildId: build.id }, error);
		}
	}
}
