import fs from 'node:fs';
import path from 'node:path';
import { assertEvidenceDirectory, hashEvidenceBytes, readEvidenceFile } from '../host/evidence-files.ts';
import type { FrozenEvidencePreparation } from '../host/evidence-source.ts';
import { assertTaskPlanHash } from '../policy/contracts/dag-schema.ts';
import { getCheckpointQualityPolicy } from '../policy/contracts/quality-policy.ts';
import { sha256, validateRunAuthorization, type RuntimeState, type TaskPlan } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { HydrationRunnerFn } from './hydration.ts';

export interface CheckpointHydrationBinding {
	runId: string;
	approvedSpecHash: string;
	taskPlanHash: string;
	baseCommitSha: string;
	adapterBindingsHash: string;
	allowedPackages: readonly string[];
	allowedPathPrefixes: readonly string[];
}

export interface CheckpointHydrationOverride {
	readonly binding: CheckpointHydrationBinding;
	readonly preparation: FrozenEvidencePreparation;
	readonly prepare: (input: {
		worktreeDir: string; packages: readonly string[]; targetPackage: string | null;
		binding: CheckpointHydrationBinding; preparation: FrozenEvidencePreparation;
	}) => Promise<void>;
}

export function checkpointHydrationBinding(
	planInput: unknown, snapshotInput: unknown, authorizationInput: unknown,
): CheckpointHydrationBinding | null {
	if (!getCheckpointQualityPolicy(planInput)) return null;
	const plan = planInput as TaskPlan;
	const snapshot = snapshotInput as Partial<RuntimeState> | null;
	const auth = validateRunAuthorization(authorizationInput);
	if (!snapshot?.taskPlanFrozen || !snapshot.approvedSpecHash ||
		auth.approvedSpecHash !== snapshot.approvedSpecHash || auth.runId !== plan.runId ||
		snapshot.runId !== plan.runId || auth.baseCommitSha !== plan.baseCommitSha ||
		!auth.allowedOperations.runAllowlistedCommands || !auth.allowedOperations.createDetachedWorktree) {
		throw new SdlcError('AUTHORIZATION_INVALID', 'Checkpoint hydration requires a frozen authorized plan');
	}
	const taskPlanHash = assertTaskPlanHash(plan, snapshot.taskPlanHash);
	return {
		runId: plan.runId, approvedSpecHash: snapshot.approvedSpecHash, taskPlanHash,
		baseCommitSha: auth.baseCommitSha, adapterBindingsHash: sha256(plan.adapterBindings),
		allowedPackages: [...auth.allowedPackages], allowedPathPrefixes: [...auth.allowedPathPrefixes],
	};
}

export function checkpointPreparationSelection(
	runner: HydrationRunnerFn, selection: Record<string, unknown>,
): string {
	const override = runner.checkpointHydration;
	return sha256(override ? { ...selection,
		checkpointHydration: { binding: override.binding, preparation: override.preparation } } : selection);
}

export async function hydrateCheckpointWorktree({
	worktreeDir, packages, targetPackage, binding, override, fingerprint, markerPath,
}: {
	worktreeDir: string; packages: readonly string[]; targetPackage: string | null;
	binding: CheckpointHydrationBinding; override: CheckpointHydrationOverride;
	fingerprint: string; markerPath: string;
}): Promise<{ status: 'CACHED' | 'HYDRATED'; fingerprint: string; stepsCompleted: string[] }> {
	if (sha256(binding) !== sha256(override.binding) || !packages.length ||
		packages.some(pkg => !binding.allowedPackages.includes(pkg)) ||
		(targetPackage && !packages.includes(targetPackage))) {
		throw new SdlcError('AUTHORIZATION_INVALID', 'Checkpoint hydration binding or package scope changed');
	}
	assertEvidenceDirectory(worktreeDir);
	const preparation = structuredClone(override.preparation);
	if (!preparation?.configuration || !Object.keys(preparation.configuration).length ||
		!Array.isArray(preparation.files) || !preparation.files.length ||
		new Set(preparation.files.map(file => file.path)).size !== preparation.files.length) {
		throw new SdlcError('HYDRATION_FAILED', 'Checkpoint preparation requires a frozen regular-file closure');
	}
	const preparationHash = sha256(preparation);
	const bindingHash = sha256(binding);
	const boundFingerprint = sha256({ fingerprint, bindingHash, preparationHash });
	const existing = fs.existsSync(markerPath) ? JSON.parse(fs.readFileSync(markerPath, 'utf8')) : null;
	if (existing && (existing.fingerprint !== boundFingerprint || existing.bindingHash !== bindingHash ||
		existing.preparationHash !== preparationHash)) {
		throw new SdlcError('HYDRATION_FAILED', 'Checkpoint preparation changed; refusing installation fallback');
	}
	if (!existing) await override.prepare({ worktreeDir, packages, targetPackage, binding, preparation });
	if (sha256(override.preparation) !== preparationHash || sha256(override.binding) !== bindingHash) {
		throw new SdlcError('HYDRATION_FAILED', 'Checkpoint preparation changed during hydration');
	}
	for (const file of preparation.files) {
		const actual = hashEvidenceBytes(readEvidenceFile(worktreeDir, file.path, Number.MAX_SAFE_INTEGER));
		if (!/^[a-f0-9]{64}$/.test(file.sha256) || actual !== file.sha256) {
			throw new SdlcError('HYDRATION_FAILED', 'Checkpoint preparation file changed', { path: file.path });
		}
	}
	assertEvidenceDirectory(path.join(worktreeDir, 'node_modules'));
	for (const pkg of packages) assertEvidenceDirectory(path.join(worktreeDir, pkg, 'node_modules'));
	const stepsCompleted = ['checkpoint-preparation'];
	if (!existing) {
		assertEvidenceDirectory(path.dirname(markerPath));
		fs.writeFileSync(markerPath, `${JSON.stringify({
			fingerprint: boundFingerprint, bindingHash, preparationHash, stepsCompleted,
		})}\n`, { flag: 'wx' });
	}
	return { status: existing ? 'CACHED' : 'HYDRATED', fingerprint: boundFingerprint, stepsCompleted };
}
