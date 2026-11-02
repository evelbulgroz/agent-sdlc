import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy } from '@evelbulgroz/model-usage-govenor/policy';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { SdlcError } from '../policy/errors.ts';

export const DEFAULT_EXECUTOR_STEP_CEILING = 80;
const ABSOLUTE_EXECUTOR_STEP_CEILING = 100;
const STEPS_PER_FILE = 2;
const VERIFICATION_ALLOWANCE = 4;

export interface StepCapacityOptions {
	readonly stepsPerFile?: number;
	readonly verificationAllowance?: number;
	readonly defaultCeiling?: number;
	readonly absoluteCeiling?: number;
	readonly detailed?: boolean;
}
export interface DetailedStepCapacity {
	readonly requiredSteps: number;
	readonly stepCeiling: number;
	readonly allowedSteps: number;
}
export function calculateTaskStepCapacity(
	pathsOrCount: readonly unknown[] | number,
	options: StepCapacityOptions & { readonly detailed: true },
): DetailedStepCapacity;
export function calculateTaskStepCapacity(
	pathsOrCount: readonly unknown[] | number,
	options?: StepCapacityOptions & { readonly detailed?: false },
): number;
export function calculateTaskStepCapacity(
	pathsOrCount: readonly unknown[] | number,
	options: StepCapacityOptions = {},
): number | DetailedStepCapacity {
	const {
		stepsPerFile = STEPS_PER_FILE,
		verificationAllowance = VERIFICATION_ALLOWANCE,
		defaultCeiling = DEFAULT_EXECUTOR_STEP_CEILING,
		absoluteCeiling = ABSOLUTE_EXECUTOR_STEP_CEILING,
		detailed = false,
	} = options;
	const pathCount = Array.isArray(pathsOrCount)
		? pathsOrCount.length
		: typeof pathsOrCount === 'number' && Number.isFinite(pathsOrCount)
			? Math.max(0, Math.floor(pathsOrCount))
			: 0;
	const requiredSteps = pathCount * stepsPerFile + verificationAllowance;
	if (requiredSteps > absoluteCeiling) {
		throw new SdlcError('CAPACITY_LIMIT_EXCEEDED',
			`Task requires at least ${requiredSteps} steps, which exceeds the absolute step ceiling of ${absoluteCeiling}`,
			{ requiredSteps, allowedSteps: absoluteCeiling, pathCount });
	}
	const stepCeiling = Math.min(absoluteCeiling, Math.max(requiredSteps, defaultCeiling));
	return detailed ? { requiredSteps, stepCeiling, allowedSteps: absoluteCeiling } : stepCeiling;
}

export function resolveRunMaxPhysicalCalls({
	rootDir = REPOSITORY_ROOT,
	modelProfile = 'agent-sdlc-default',
	readFile = (filePath: string) => fs.readFileSync(filePath, 'utf8'),
}: { rootDir?: string; modelProfile?: string; readFile?: (filePath: string) => string } = {}): number {
	if (process.env.AGENT_SDLC_RUN_MAX_PHYSICAL_CALLS) {
		const envLimit = Number.parseInt(process.env.AGENT_SDLC_RUN_MAX_PHYSICAL_CALLS, 10);
		if (Number.isSafeInteger(envLimit) && envLimit > 0) return envLimit;
	}
	try {
		const hostPath = path.join(rootDir ?? REPOSITORY_ROOT, '.agents/model-usage-policy.json');
		const policyPath = fs.existsSync(hostPath) ? hostPath : loadPolicy.DEFAULT_BUNDLED_POLICY_PATH;
		const policy = JSON.parse(readFile(policyPath)) as {
			profiles?: Readonly<Record<string, { limits?: { runMaxPhysicalCalls?: unknown } } | undefined>>;
		};
		const limit = policy.profiles?.[modelProfile]?.limits?.runMaxPhysicalCalls;
		if (typeof limit === 'number' && limit > 0) return limit;
	} catch {
		// Preserve the legacy conservative fallback.
	}
	return 250;
}
