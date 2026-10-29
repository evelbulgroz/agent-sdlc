import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadHostProfileOrFallback } from '../host/host-profile.ts';
import { type DependencyMutation, canonicalJson, sha256 } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import type { GitCliFn } from './git-manager.ts';
import { copyPackageArtifacts, copyUntrackedFiles, resolveHydrationPlan } from './hydration-steps.ts';

export type HydrationRunnerFn = (
	command: string,
	args: readonly string[],
	options?: Record<string, unknown>,
) => unknown;

function gitText(gitCli: GitCliFn, args: readonly string[], options: Record<string, unknown>): string {
	const result = gitCli('git', args, options);
	return typeof result === 'string' ? result : result.toString('utf8');
}

function errnoCode(error: unknown): string | undefined {
	if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
	return undefined;
}

export function getHydrationMarkerPath(worktreeDir: string, metadataDir: string | null = null): string {
	const dirName = metadataDir ?? path.dirname(worktreeDir);
	return path.basename(worktreeDir) === 'worktree'
		? path.join(dirName, 'hydration.json')
		: path.join(dirName, `hydration-${path.basename(worktreeDir)}.json`);
}

export function computeHydrationFingerprint(
	worktreeDir: string,
	allowedPackages: string | readonly string[] | null | undefined,
): string {
	const lockfilePath = path.join(worktreeDir, 'pnpm-lock.yaml');
	const lockfileHash = fs.existsSync(lockfilePath) ? sha256(fs.readFileSync(lockfilePath, 'utf8')) : '';
	const packages = Array.isArray(allowedPackages) ? allowedPackages : allowedPackages ? [allowedPackages] : [];
	const orderedPackages = [...packages].sort();
	const packageJsonHashes = orderedPackages.map((pkg) => {
		const manifestPath = path.join(worktreeDir, pkg, 'package.json');
		return fs.existsSync(manifestPath) ? sha256(fs.readFileSync(manifestPath, 'utf8')) : '';
	});
	return sha256({ lockfileHash, packageJsonHashes, allowedPackages: orderedPackages });
}

export function isWorktreeHydrated(
	worktreeDir: string,
	allowedPackages: string | readonly string[] | null | undefined,
	metadataDir: string | null = null,
): boolean {
	const markerPath = getHydrationMarkerPath(worktreeDir, metadataDir);
	if (!fs.existsSync(markerPath) || !fs.existsSync(path.join(worktreeDir, 'node_modules'))) return false;
	try {
		const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { fingerprint?: string };
		return marker?.fingerprint === computeHydrationFingerprint(worktreeDir, allowedPackages);
	} catch {
		return false;
	}
}

function extractRunnerFailureText(error: unknown): string {
	const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
	const message = error instanceof Error ? error.message : String(error);
	const parts = [record.stderr, record.stdout]
		.filter(Boolean)
		.map((s) => String(s).trim())
		.filter(Boolean);
	if (parts.length > 0) {
		return `${message}\n${parts.join('\n')}`;
	}
	return message;
}

export function invalidateHydrationMarker(
	worktreeDir: string,
	metadataDir: string | null = null,
): void {
	const markerPath = getHydrationMarkerPath(worktreeDir, metadataDir);
	for (const marker of [markerPath, path.join(worktreeDir, '.hydration-fingerprint.json')]) {
		if (!fs.existsSync(marker)) continue;
		try {
			fs.unlinkSync(marker);
		} catch (error: unknown) {
			if (errnoCode(error) !== 'ENOENT') throw error;
		}
	}
}

export const ABSENT_DEPENDENCY_RANGE = 'absent';

export function actualDependencyRange(value: unknown): string {
	return typeof value === 'string' && value.length > 0 ? value : ABSENT_DEPENDENCY_RANGE;
}

const DEPENDENCY_SECTIONS = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
] as const;

export function porcelainPaths(statusOut: unknown): string[] {
	return String(statusOut ?? '')
		.split('\n')
		.filter(Boolean)
		.map((line) => line.slice(3).trim().replace(/^.*->\s*/, ''));
}

export function collectDependencyMutations({
	worktreeDir,
	manifestPaths,
	treeIsh,
	gitCli = execFileSync as GitCliFn,
}: {
	worktreeDir: string;
	manifestPaths: readonly string[];
	treeIsh: string;
	gitCli?: GitCliFn;
}): DependencyMutation[] {
	const actual: DependencyMutation[] = [];
	for (const manifestPath of manifestPaths) {
		const previousText = gitText(gitCli, ['show', `${treeIsh}:${manifestPath}`], {
			cwd: worktreeDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const previous = JSON.parse(previousText) as Record<string, Record<string, unknown>>;
		const current = JSON.parse(
			fs.readFileSync(path.join(worktreeDir, manifestPath), 'utf8'),
		) as Record<string, Record<string, unknown>>;
		for (const section of DEPENDENCY_SECTIONS) {
			const before = previous[section] ?? {};
			const after = current[section] ?? {};
			for (const dependencyName of new Set([...Object.keys(before), ...Object.keys(after)])) {
				const fromRange = actualDependencyRange(before[dependencyName]);
				const toRange = actualDependencyRange(after[dependencyName]);
				if (fromRange === toRange) continue;
				actual.push({ manifestPath, dependencyName, fromRange, toRange });
			}
		}
	}
	return actual;
}

export function dependencyMutationsMatch(
	actual: readonly DependencyMutation[],
	declared: readonly DependencyMutation[],
): boolean {
	return (
		actual.length === declared.length &&
		actual.every((candidate) =>
			declared.some(
				(expected) =>
					expected.manifestPath === candidate.manifestPath &&
					expected.dependencyName === candidate.dependencyName &&
					expected.fromRange === candidate.fromRange &&
					expected.toRange === candidate.toRange,
			),
		)
	);
}

export async function installMatchedDependencyMutations({
	worktreeDir, dependencyMutations = [], treeIsh = 'HEAD',
	execCli = execFileSync as HydrationRunnerFn, gitCli = execFileSync as GitCliFn,
	fingerprints = new Map<string, string>(),
}: {
	worktreeDir?: string; dependencyMutations?: readonly DependencyMutation[]; treeIsh?: string;
	execCli?: HydrationRunnerFn; gitCli?: GitCliFn; fingerprints?: Map<string, string>;
} = {}): Promise<boolean> {
	if (!worktreeDir || dependencyMutations.length === 0) return false;
	const modifiedFiles = porcelainPaths(
		gitCli('git', ['status', '--porcelain'], {
			cwd: worktreeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
		}),
	);
	const manifestPaths = [
		...new Set(
			dependencyMutations
				.map((mutation) => mutation.manifestPath)
				.filter((manifestPath) => modifiedFiles.includes(manifestPath)),
		),
	];
	if (manifestPaths.length === 0) return false;
	const actual = collectDependencyMutations({ worktreeDir, manifestPaths, treeIsh, gitCli });
	if (!dependencyMutationsMatch(actual, dependencyMutations)) return false;
	const fingerprint = sha256(
		manifestPaths.map((manifestPath) => fs.readFileSync(path.join(worktreeDir, manifestPath), 'utf8')),
	);
	if (fingerprints.get(worktreeDir) === fingerprint) return false;
	await refreshLockfile({ worktreeDir, runner: execCli });
	gitCli('git', ['add', 'pnpm-lock.yaml'], { cwd: worktreeDir, stdio: ['ignore', 'pipe', 'pipe'] });
	fingerprints.set(worktreeDir, fingerprint);
	return true;
}

export async function refreshLockfile({
	worktreeDir, runner = execFileSync as HydrationRunnerFn, metadataDir = null,
}: {
	worktreeDir: string; runner?: HydrationRunnerFn; metadataDir?: string | null;
}): Promise<void> {
	try {
		await Promise.resolve(
			runner('pnpm', ['install'], { cwd: worktreeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
		);
	} catch (error: unknown) {
		const failureText = extractRunnerFailureText(error);
		throw new SdlcError(
			'HYDRATION_FAILED', `Lockfile refresh failed at 'pnpm install': ${failureText}`,
			{ step: 'refresh-lockfile', worktreeDir, output: failureText }, { cause: error },
		);
	}
	invalidateHydrationMarker(worktreeDir, metadataDir);
	try {
		await Promise.resolve(
			runner('pnpm', ['install', '--frozen-lockfile'], {
				cwd: worktreeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
			}),
		);
	} catch (error: unknown) {
		const failureText = extractRunnerFailureText(error);
		throw new SdlcError(
			'HYDRATION_FAILED', `Frozen lockfile verification failed after refresh: ${failureText}`,
			{ step: 'verify-frozen-lockfile', worktreeDir, output: failureText }, { cause: error },
		);
	}
}

export async function hydrateWorktree({
	worktreeDir, allowedPackages = null, targetPackage = null, metadataDir = null,
	runner = execFileSync as HydrationRunnerFn, now = new Date(),
}: {
	worktreeDir: string; allowedPackages?: string | readonly string[] | null;
	targetPackage?: string | null; metadataDir?: string | null;
	runner?: HydrationRunnerFn; now?: Date;
}): Promise<{ status: 'CACHED' | 'HYDRATED'; fingerprint: string; stepsCompleted: string[] }> {
	const rawPackages = [
		...(targetPackage ? [targetPackage] : []),
		...(allowedPackages
			? Array.isArray(allowedPackages)
				? allowedPackages
				: [allowedPackages]
			: []),
	];
	const packages = Array.from(new Set(rawPackages));

	const fingerprint = computeHydrationFingerprint(worktreeDir, packages);

	if (isWorktreeHydrated(worktreeDir, packages, metadataDir)) {
		return {
			status: 'CACHED',
			fingerprint,
			stepsCompleted: ['install', 'impact-build'],
		};
	}

	const stepsCompleted: string[] = [];
	const resolvedProfile = loadHostProfileOrFallback(worktreeDir);
	const plan = resolveHydrationPlan(resolvedProfile);
	const runArgv = (argv: readonly string[]) =>
		Promise.resolve(
			runner(argv[0] as string, argv.slice(1), { cwd: worktreeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
		);
	const runPnpm = (args: readonly string[]) => runArgv(['pnpm', ...args]);
	const fail = (step: string, error: unknown): never => {
		const failureText = extractRunnerFailureText(error);
		throw new SdlcError(
			'HYDRATION_FAILED',
			`Worktree hydration failed at step '${step}': ${failureText}`,
			{ step, worktreeDir, output: failureText },
			{ cause: error },
		);
	};

	try {
		await runArgv(plan.installArgv);
		stepsCompleted.push('install');
	} catch (error: unknown) {
		fail('install', error);
	}

	if (plan.untrackedCopies.length > 0 || plan.packageArtifactCopies.length > 0) {
		try {
			copyUntrackedFiles(REPOSITORY_ROOT, worktreeDir, plan.untrackedCopies);
			copyPackageArtifacts(REPOSITORY_ROOT, worktreeDir, plan.packageArtifactCopies);
			stepsCompleted.push('untracked-copies');
		} catch (error: unknown) {
			if (error instanceof SdlcError) throw error;
			fail('untracked-copies', error);
		}
	}

	for (const build of plan.conditionalBuilds) {
		if (fs.existsSync(path.join(worktreeDir, build.skipIfExists))) continue;
		try {
			await runArgv(build.argv);
			stepsCompleted.push('workspace-build');
		} catch (error: unknown) {
			fail('workspace-build', error);
		}
	}

	for (const argv of plan.steps) {
		try {
			await runArgv(argv);
			stepsCompleted.push('host-step');
		} catch (error: unknown) {
			fail('host-step', error);
		}
	}

	const impactPackages = targetPackage ? [targetPackage] : packages;
	for (const pkgPath of impactPackages) {
		const pkgJsonPath = path.join(worktreeDir, pkgPath, 'package.json');
		if (!fs.existsSync(pkgJsonPath)) continue;

		let pkgName: string | undefined;
		try {
			const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
				name?: string;
				scripts?: Record<string, string>;
			};
			pkgName = pkgJson.name;
			if (pkgName && pkgJson.scripts?.build) {
				await runPnpm(['--filter', `${pkgName}...`, 'run', 'build']);
			}
		} catch (error: unknown) {
			if (targetPackage && packages.length > 1 && pkgName) {
				try {
					await runPnpm(['--filter', `${pkgName}^...`, 'run', 'build']);
					continue;
				} catch (fallbackError: unknown) {
					const failureText = extractRunnerFailureText(fallbackError);
					throw new SdlcError(
						'HYDRATION_FAILED',
						`Worktree hydration failed at step 'impact-build' for ${pkgPath}: ${failureText}`,
						{ step: 'impact-build', pkgPath, worktreeDir, output: failureText },
						{ cause: fallbackError },
					);
				}
			}
			const failureText = extractRunnerFailureText(error);
			throw new SdlcError(
				'HYDRATION_FAILED',
				`Worktree hydration failed at step 'impact-build' for ${pkgPath}: ${failureText}`,
				{ step: 'impact-build', pkgPath, worktreeDir, output: failureText },
				{ cause: error },
			);
		}
	}
	stepsCompleted.push('impact-build');

	const legacyMarker = path.join(worktreeDir, '.hydration-fingerprint.json');
	if (fs.existsSync(legacyMarker)) {
		try {
			fs.unlinkSync(legacyMarker);
		} catch (error: unknown) {
			if (errnoCode(error) !== 'ENOENT') throw error;
		}
	}
	const markerPath = getHydrationMarkerPath(worktreeDir, metadataDir);
	fs.mkdirSync(path.dirname(markerPath), { recursive: true });
	fs.writeFileSync(
		markerPath,
		canonicalJson({
			fingerprint,
			stepsCompleted,
			completedAt: now.toISOString(),
		}),
		'utf8',
	);

	return {
		status: 'HYDRATED',
		fingerprint,
		stepsCompleted,
	};
}
