import fs from 'node:fs';
import path from 'node:path';
import { isTestFilePath } from '../policy/contracts.ts';
import { approvedAcIds, parseTestCitations } from './ac-citations.ts';
import type { GitShowFn } from './ac-worktree-coverage.ts';
import type { CompletionValidatorFn } from './minimal-verification.ts';
import { acceptRegisteredUnitArgv, createAcceptanceEvidenceValidator } from './task-acceptance-evidence.ts';
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
		.filter((authoredPath) => isTestFilePath(authoredPath))
		.filter((authoredPath) => authoredPath.startsWith(packagePrefix))
		.map((authoredPath) => authoredPath.slice(packagePrefix.length));
}

function isPackageE2ePath(testPath: string): boolean {
	return testPath.split('\\').join('/').split('/').includes('e2e');
}

function selectRunnableTests(
	packageJson: PackageJsonLike,
	testPaths: readonly string[],
): { name: string; command: string; paths: readonly string[] } | null {
	const targeted = resolveTargetedTestScript(packageJson, testPaths);
	if (!targeted) return null;
	const unitPaths = testPaths.filter((testPath) => !isPackageE2ePath(testPath));
	// Package e2e paths never stay on a unit script, including a compound `test` script.
	if (unitPaths.length === testPaths.length) {
		return { name: targeted.name, command: targeted.command, paths: testPaths };
	}
	if (unitPaths.length > 0) {
		return { name: targeted.name, command: targeted.command, paths: unitPaths };
	}
	const e2eCommand = packageJson.scripts?.['test:e2e'];
	if (typeof e2eCommand !== 'string' || !TEST_FRAMEWORK_PATTERN.test(e2eCommand)) return null;
	return { name: 'test:e2e', command: e2eCommand, paths: testPaths };
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
	const selected = selectRunnableTests(packageJson, testPaths);
	if (!selected) return null;
	if (selected.name !== 'test') {
		const packageName = packageJson.name;
		if (typeof packageName !== 'string' || packageName.length === 0) return null;
		return ['pnpm', '--filter', packageName, 'run', selected.name, ...selected.paths];
	}
	return [...verificationCommand, '--', ...selected.paths];
}

export function resolveAcceptanceEvidenceCommand(
	task: VerificationPlanTask,
	packageJson: PackageJsonLike = {},
	registeredUnitArgv?: readonly string[] | null,
): readonly string[] | null {
	if (Array.isArray(registeredUnitArgv)) return acceptRegisteredUnitArgv(registeredUnitArgv);
	const verificationCommand = resolveTaskVerificationCommand(task, packageJson);
	const repositorySuite = JSON.stringify(verificationCommand);
	if (repositorySuite === JSON.stringify(['pnpm', 'run', 'test:unit'])) {
		return verificationCommand;
	}
	const selected = selectRunnableTests(packageJson, resolveAuthoredTestPaths(task));
	const targeted = resolveTargetedVerificationCommand(task, packageJson);
	if (!targeted || !selected) return null;
	// A compound shell command must not receive a reporter or a spec path. Those
	// tokens would be forwarded past `&&` and the build fails closed instead.
	if (selected.command.includes('&&')) return verificationCommand;
	if (/\bvitest\b/.test(selected.command)) return [...targeted, '--reporter=json'];
	if (/\bjest\b/.test(selected.command)) return [...targeted, '--json'];
	if (/\bnode\s+--test\b/.test(selected.command)) return targeted;
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

function packageRelativePath(targetPackage: string, filePath: string): string {
	const prefix = `${targetPackage.replace(/\/+$/, '')}/`.split('\\').join('/');
	const normalized = filePath.split('\\').join('/');
	return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

function commandListsRelativePath(command: readonly string[], relativePath: string): boolean {
	const token = relativePath.split('\\').join('/');
	return command.some((arg) => arg.split('\\').join('/') === token);
}

function citedCriterionIds(source: string): readonly string[] {
	const ids = new Set<string>();
	for (const row of parseTestCitations(source)) {
		for (const id of row.acIds) ids.add(id);
		for (const caseId of row.caseIds) {
			const parent = caseId.slice(0, caseId.lastIndexOf('.'));
			if (parent.length > 0) ids.add(parent);
		}
	}
	return [...ids];
}

function requiredAcceptanceCriteria(
	criteria: readonly string[],
	testPaths: readonly string[],
	command: readonly string[],
	worktreeDir: string,
	targetPackage: string,
): readonly string[] {
	const rows = testPaths.map((filePath) => ({
		filePath,
		relativePath: packageRelativePath(targetPackage, filePath),
	}));
	if (!rows.some((row) => commandListsRelativePath(command, row.relativePath))) return criteria;
	const omitted = new Set(
		rows
			.filter(
				(row) =>
					isPackageE2ePath(row.relativePath) &&
					!commandListsRelativePath(command, row.relativePath),
			)
			.map((row) => row.filePath),
	);
	if (omitted.size === 0) return criteria;
	const inOmitted = new Set<string>();
	const elsewhere = new Set<string>();
	for (const row of rows) {
		const absolute = path.join(worktreeDir, row.filePath);
		if (!fs.existsSync(absolute)) continue;
		const dest = omitted.has(row.filePath) ? inOmitted : elsewhere;
		for (const id of citedCriterionIds(fs.readFileSync(absolute, 'utf8'))) dest.add(id);
	}
	return criteria.filter((entry) => {
		const id = approvedAcIds([entry])[0];
		return !id || !inOmitted.has(id) || elsewhere.has(id);
	});
}

function pathsListedOnCommand(
	testPaths: readonly string[],
	command: readonly string[],
	targetPackage: string,
): readonly string[] {
	const listed = testPaths.filter((filePath) =>
		commandListsRelativePath(command, packageRelativePath(targetPackage, filePath)),
	);
	// Untargeted commands name no spec, so coverage keeps the full authored set.
	return listed.length > 0 ? listed : testPaths;
}

function bindPartitionedValidator(
	options: Parameters<typeof createAcceptanceEvidenceValidator>[0] & {
		readonly targetPackage: string;
	},
): CompletionValidatorFn | null {
	if (!options.acceptanceEvidenceCommand) return createAcceptanceEvidenceValidator(options);
	const { targetPackage, ...validatorOptions } = options;
	const build = () => {
		const command = validatorOptions.acceptanceEvidenceCommand ?? [];
		const required = requiredAcceptanceCriteria(
			validatorOptions.acceptanceCriteria,
			validatorOptions.authoredTestPaths,
			command,
			validatorOptions.worktreeDir,
			targetPackage,
		);
		if (required.length === 0) return null;
		return createAcceptanceEvidenceValidator({
			...validatorOptions,
			authoredTestPaths: pathsListedOnCommand(
				validatorOptions.authoredTestPaths,
				command,
				targetPackage,
			),
			acceptanceCriteria: required,
			knownAcceptanceCriteria: [
				...new Set([
					...(validatorOptions.knownAcceptanceCriteria ?? []),
					...validatorOptions.acceptanceCriteria,
				]),
			],
		});
	};
	const validator: CompletionValidatorFn = (input) => build()?.(input) ?? { pass: true };
	return Object.assign(validator, { staticCheck: () => build()?.staticCheck?.() ?? null });
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
						isTestFilePath(filePath) &&
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
		isTestFilePath(filePath),
	);
	const sliceAuthoredTestPaths = [
		...new Set([...sliceCompletedTestPaths, ...authoredTestPaths]),
	];
	const completionValidator = bindPartitionedValidator({
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
		targetPackage: task.targetPackage,
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
