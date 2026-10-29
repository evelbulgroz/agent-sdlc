import fs from 'node:fs';
import path from 'node:path';
import type { GitShowFn } from './ac-worktree-coverage.ts';
import type { CompletionValidatorFn } from './minimal-verification.ts';
import { createAcceptanceEvidenceValidator } from './task-acceptance-evidence.ts';
import {
	type TaskScopePlanLike,
	type TaskScopeTaskLike,
	scopeSpecSummaryForTask,
	taskAuthoredWritePaths,
} from './task-scope.ts';

export interface PackageJsonLike {
	readonly name?: string;
	readonly scripts?: Readonly<Record<string, string | undefined>>;
	readonly devDependencies?: Readonly<Record<string, string | undefined>>;
	readonly [key: string]: unknown;
}

export interface VerificationPlanTask extends TaskScopeTaskLike {
	readonly taskId: string;
	readonly targetPackage: string;
	readonly baseCommitSha?: string | null;
	status?: string;
	readonly verificationCommand?: readonly string[] | null;
	readonly generatorCommand?: readonly string[] | null;
	readonly pathPrefixes: readonly string[];
}

export interface TaskPromptContextLike {
	readonly acceptanceCriteria?: readonly string[];
	readonly contractVerificationCommands?: readonly (readonly string[])[];
	readonly generatorCommand?: readonly string[] | null;
	readonly verificationCommand?: readonly string[] | null;
	readonly targetedVerificationCommand?: readonly string[] | null;
	readonly acceptanceEvidenceCommand?: readonly string[] | null;
	readonly testFrameworkGuidance?: string | null;
}

function sameVerificationCommand(left: unknown, right: unknown): boolean {
	return (
		Array.isArray(left) &&
		Array.isArray(right) &&
		left.length === right.length &&
		left.every((part, index) => part === right[index])
	);
}

// Hydration rejects a dependency-closure filter. The package build is the typecheck tests skip.
function packageBuildCommand(packageJson: PackageJsonLike | null | undefined): string[] | null {
	if (typeof packageJson?.name !== 'string' || packageJson.name.length === 0) return null;
	if (typeof packageJson.scripts?.build !== 'string') return null;
	return ['pnpm', '--filter', packageJson.name, 'run', 'build'];
}

// The generator regenerates declared outputs. Tests alone do not catch type errors.
export function resolveTaskVerificationSequence(
	task: VerificationPlanTask,
	packageJson: PackageJsonLike = {},
): Array<readonly string[]> {
	const verification = resolveTaskVerificationCommand(task, packageJson);
	const commands: Array<readonly string[]> = [
		...(task.generatorCommand?.length ? [task.generatorCommand] : []),
		...(verification ? [verification] : []),
	];
	const build = packageBuildCommand(packageJson);
	if (build && !commands.some((command) => sameVerificationCommand(command, build))) {
		commands.push(build);
	}
	return commands;
}

export function withContractPreservationCommands(
	commands: readonly (readonly string[])[],
	taskPromptContext: TaskPromptContextLike | null | undefined,
): Array<readonly string[]> {
	const extra = taskPromptContext?.contractVerificationCommands;
	if (!Array.isArray(extra) || extra.length === 0) return [...commands];
	const merged: Array<readonly string[]> = [...commands];
	for (const command of extra) {
		if (!Array.isArray(command) || command.length === 0) continue;
		if (merged.some((existing) => sameVerificationCommand(existing, command))) continue;
		merged.push(command);
	}
	return merged;
}

export function resolveTaskVerificationCommand(
	task: VerificationPlanTask,
	packageJson: PackageJsonLike = {},
): readonly string[] | null {
	return (
		task.verificationCommand ??
		(packageJson.scripts?.test && packageJson.name
			? ['pnpm', '--filter', packageJson.name, 'test']
			: null)
	);
}

const TEST_FRAMEWORK_PATTERN = /\b(?:vitest|jest)\b|\bnode\s+--test\b/;
const TARGETED_TEST_SCRIPT_NAMES: ReadonlySet<string> = new Set([
	'test:unit',
	'test:integration',
	'test:e2e',
]);

function resolveAuthoredTestPaths(task: VerificationPlanTask): string[] {
	const packagePrefix = `${task.targetPackage.replace(/\/+$/, '')}/`;
	return (task.authoredPaths ?? [])
		.filter((authoredPath) => /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(authoredPath))
		.filter((authoredPath) => authoredPath.startsWith(packagePrefix))
		.map((authoredPath) => authoredPath.slice(packagePrefix.length));
}

function resolveTargetedTestScript(
	packageJson: PackageJsonLike,
	testPaths: readonly string[],
): { name: string; command: string } | null {
	const scripts = packageJson.scripts ?? {};
	const testScript = scripts.test;
	if (typeof testScript !== 'string') return null;
	if (TEST_FRAMEWORK_PATTERN.test(testScript)) {
		return { name: 'test', command: testScript };
	}
	const referencedNames = Array.from(
		testScript.matchAll(/\bpnpm\s+run\s+([a-zA-Z0-9:_-]+)/g),
		(match) => match[1] ?? '',
	);
	const preferredName = testPaths.some(
		(testPath) =>
			testPath.includes('/integration/') ||
			testPath.includes('/boundary/') ||
			/\.integration\.spec\.[cm]?[jt]sx?$/.test(testPath),
	)
		? 'test:integration'
		: testPaths.some((testPath) => /\.e2e-spec\.[cm]?[jt]sx?$/.test(testPath))
			? 'test:e2e'
			: 'test:unit';
	const candidates = [
		preferredName,
		...referencedNames.filter((name) => name !== preferredName),
	].filter((name) => TARGETED_TEST_SCRIPT_NAMES.has(name));
	for (const name of candidates) {
		const command = scripts[name];
		if (typeof command === 'string' && TEST_FRAMEWORK_PATTERN.test(command)) {
			return { name, command };
		}
	}
	return null;
}

export function resolveTargetedVerificationCommand(
	task: VerificationPlanTask,
	packageJson: PackageJsonLike = {},
): string[] | null {
	const verificationCommand = resolveTaskVerificationCommand(task, packageJson);
	if (
		!Array.isArray(verificationCommand) ||
		verificationCommand[0] !== 'pnpm' ||
		!verificationCommand.some((arg) => arg === 'test' || arg.startsWith('test:'))
	) {
		return null;
	}
	const testPaths = resolveAuthoredTestPaths(task);
	if (testPaths.length === 0) return null;
	const targetedScript = resolveTargetedTestScript(packageJson, testPaths);
	if (!targetedScript) return null;
	if (targetedScript.name !== 'test') {
		const packageName = packageJson.name;
		if (typeof packageName !== 'string' || packageName.length === 0) return null;
		return [
			'pnpm',
			'--filter',
			packageName,
			'run',
			targetedScript.name,
			...testPaths,
		];
	}
	return [...verificationCommand, '--', ...testPaths];
}

export function resolveAcceptanceEvidenceCommand(
	task: VerificationPlanTask,
	packageJson: PackageJsonLike = {},
): readonly string[] | null {
	const verificationCommand = resolveTaskVerificationCommand(task, packageJson);
	const repositorySuite = JSON.stringify(verificationCommand);
	if (
		repositorySuite === JSON.stringify(['pnpm', 'run', 'agent:test-sdlc']) ||
		repositorySuite === JSON.stringify(['pnpm', 'run', 'test:unit'])
	) {
		return verificationCommand;
	}
	const targeted = resolveTargetedVerificationCommand(task, packageJson);
	const targetedScript = resolveTargetedTestScript(
		packageJson,
		resolveAuthoredTestPaths(task),
	)?.command;
	if (!targeted || typeof targetedScript !== 'string') return null;
	if (/\bvitest\b/.test(targetedScript)) return [...targeted, '--reporter=json'];
	if (/\bjest\b/.test(targetedScript)) return [...targeted, '--json'];
	if (/\bnode\s+--test\b/.test(targetedScript)) return targeted;
	return null;
}

export function resolveTestFrameworkGuidance(
	testScript: string | null | undefined,
	packageJson: PackageJsonLike | null = null,
): string | null {
	const lines: string[] = [];
	if (/\bvitest\b/.test(testScript ?? '')) {
		lines.push(
			"Vitest globals are disabled. Every authored Vitest spec must explicitly import the APIs it uses, for example: import { describe, expect, it } from 'vitest';",
		);
	}
	if (packageJson?.devDependencies) {
		const testLibs = Object.keys(packageJson.devDependencies).filter(
			(pkg) =>
				pkg.includes('testing-library') ||
				pkg.includes('vitest') ||
				pkg.includes('jest') ||
				pkg.includes('axe'),
		);
		if (testLibs.length > 0) {
			lines.push(
				`Installed testing libraries in package: ${testLibs.join(', ')}. Only import installed libraries.`,
			);
		}
		if (
			Object.keys(packageJson.devDependencies).some((pkg) =>
				pkg.startsWith('@testing-library/'),
			)
		) {
			lines.push(
				'A spec that renders with Testing Library under the node Vitest environment must start with the docblock `/** @vitest-environment jsdom */`.',
			);
		}
	}
	return lines.length > 0 ? lines.join(' ') : null;
}

export function resolveTaskVerificationContext({
	task,
	taskPlan,
	worktreeDir,
	taskPromptContext = null,
	acceptanceCriteria = [],
	specSummary = '',
	gitCli,
}: {
	task: VerificationPlanTask;
	taskPlan?: (TaskScopePlanLike & { readonly tasks?: readonly VerificationPlanTask[] }) | null;
	worktreeDir: string;
	taskPromptContext?: TaskPromptContextLike | null;
	acceptanceCriteria?: readonly string[];
	specSummary?: string;
	gitCli?: GitShowFn | null;
}): {
	packageJson: PackageJsonLike;
	allowedCommandPackages: string[];
	acceptanceEvidenceCommand: readonly string[] | null;
	authoredTestPaths: string[];
	effectiveTaskPromptContext: TaskPromptContextLike;
	completionValidator: CompletionValidatorFn | null;
	scopedSpecSummary: string;
} {
	const packageJsonPath = path.join(worktreeDir, task.targetPackage, 'package.json');
	let packageJson: PackageJsonLike = {};
	if (fs.existsSync(packageJsonPath)) {
		packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJsonLike;
	}
	const verificationCommand = resolveTaskVerificationCommand(task, packageJson);
	const commandPackage =
		verificationCommand?.[0] === 'pnpm' && verificationCommand?.[1] === '--filter'
			? verificationCommand[2]
			: null;
	const allowedCommandPackages = [
		...new Set(
			[task.targetPackage, packageJson.name, commandPackage].filter(
				(value): value is string => typeof value === 'string' && value.length > 0,
			),
		),
	];
	const targetedVerificationCommand = resolveTargetedVerificationCommand(task, packageJson);
	const sliceCompletedSiblings = task.sliceId
		? (taskPlan?.tasks ?? []).filter(
				(candidate) =>
					candidate.sliceId === task.sliceId &&
					candidate.targetPackage === task.targetPackage &&
					candidate.taskId !== task.taskId &&
					candidate.status === 'completed',
			)
		: [];
	const sliceCompletedTestPaths = [
		...new Set(
			sliceCompletedSiblings
				.flatMap((candidate) => taskAuthoredWritePaths(candidate))
				.filter(
					(filePath) =>
						/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(filePath) &&
						(!worktreeDir || fs.existsSync(path.join(worktreeDir, filePath))),
				),
		),
	];
	const sliceEvidenceTask: VerificationPlanTask =
		sliceCompletedTestPaths.length > 0
			? {
					...task,
					authoredPaths: [
						...new Set([...sliceCompletedTestPaths, ...(task.authoredPaths ?? [])]),
					],
					pathPrefixes: [
						...new Set([
							...sliceCompletedSiblings.flatMap((candidate) => candidate.pathPrefixes ?? []),
							...(task.pathPrefixes ?? []),
						]),
					],
				}
			: task;
	const acceptanceEvidenceCommand = resolveAcceptanceEvidenceCommand(
		sliceEvidenceTask,
		packageJson,
	);
	const effectiveTaskPromptContext: TaskPromptContextLike = {
		...(taskPromptContext ?? {}),
		verificationCommand,
		targetedVerificationCommand,
		acceptanceEvidenceCommand,
		testFrameworkGuidance: resolveTestFrameworkGuidance(
			resolveTargetedTestScript(packageJson, resolveAuthoredTestPaths(task))?.command ??
				packageJson.scripts?.test,
			packageJson,
		),
		generatorCommand: taskPromptContext?.generatorCommand ?? task.generatorCommand ?? null,
	};
	const authoredTestPaths = taskAuthoredWritePaths(task).filter((filePath) =>
		/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(filePath),
	);
	const sliceAuthoredTestPaths = [
		...new Set([...sliceCompletedTestPaths, ...authoredTestPaths]),
	];
	const completionValidator = createAcceptanceEvidenceValidator({
		acceptanceCriteria: effectiveTaskPromptContext.acceptanceCriteria ?? acceptanceCriteria,
		knownAcceptanceCriteria:
			acceptanceCriteria?.length > 0
				? acceptanceCriteria
				: (effectiveTaskPromptContext.acceptanceCriteria ?? []),
		baseCommitSha: task.baseCommitSha,
		gitCli,
		worktreeDir,
		authoredTestPaths: sliceAuthoredTestPaths,
		allowedPathPrefixes: sliceEvidenceTask.pathPrefixes,
		acceptanceEvidenceCommand,
	});
	const scopedSpecSummary = scopeSpecSummaryForTask({
		specSummary,
		task,
		siblingTestPaths: sliceCompletedTestPaths,
	});
	return {
		packageJson,
		allowedCommandPackages,
		acceptanceEvidenceCommand,
		authoredTestPaths,
		effectiveTaskPromptContext,
		completionValidator,
		scopedSpecSummary,
	};
}
