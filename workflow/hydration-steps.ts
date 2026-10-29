import fs from 'node:fs';
import path from 'node:path';
import type { HostProfile } from '../host/host-profile.ts';
import { SdlcError } from '../policy/errors.ts';

type HydrationConfig = NonNullable<HostProfile['hydration']>;
type DeclarativeHydration = Exclude<HydrationConfig, readonly unknown[]>;

export const DEFAULT_INSTALL_ARGV: readonly string[] = ['pnpm', 'install', '--frozen-lockfile'];

export interface HydrationPlan {
	installArgv: readonly string[];
	untrackedCopies: NonNullable<DeclarativeHydration['untrackedCopies']>;
	conditionalBuilds: NonNullable<DeclarativeHydration['conditionalBuilds']>;
	packageArtifactCopies: NonNullable<DeclarativeHydration['packageArtifactCopies']>;
	steps: readonly (readonly string[])[];
}

export function resolveHydrationPlan(profile: Readonly<HostProfile>): HydrationPlan {
	const hydration = profile.hydration;
	if (Array.isArray(hydration)) {
		return {
			installArgv: DEFAULT_INSTALL_ARGV,
			untrackedCopies: [],
			conditionalBuilds: [],
			packageArtifactCopies: [],
			steps: hydration,
		};
	}
	const declared = (hydration ?? {}) as DeclarativeHydration;
	return {
		installArgv: declared.installArgv ?? DEFAULT_INSTALL_ARGV,
		untrackedCopies: declared.untrackedCopies ?? [],
		conditionalBuilds: declared.conditionalBuilds ?? [],
		packageArtifactCopies: declared.packageArtifactCopies ?? [],
		steps: declared.steps ?? [],
	};
}

function copyMissing(source: string, target: string): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
}

function missingSource(what: string, source: string, targetDir: string): SdlcError {
	return new SdlcError(
		'HYDRATION_FAILED',
		`Worktree hydration failed: required ${what} '${source}' is missing from the source repository`,
		{ step: 'untracked-copies', source, targetDir },
	);
}

export function copyUntrackedFiles(
	sourceRoot: string,
	targetDir: string,
	rules: HydrationPlan['untrackedCopies'],
): void {
	if (sourceRoot === targetDir) return;
	for (const rule of rules) {
		const source = path.join(sourceRoot, rule.source);
		if (!fs.existsSync(source)) {
			if (rule.required) throw missingSource('path', rule.source, targetDir);
			continue;
		}
		copyMissing(source, path.join(targetDir, rule.target ?? rule.source));
	}
}

export function copyPackageArtifacts(
	sourceRoot: string,
	targetDir: string,
	rules: HydrationPlan['packageArtifactCopies'],
): void {
	if (sourceRoot === targetDir) return;
	for (const rule of rules) {
		const rootRel = rule.packageRoot.replace(/\/+$/, '');
		const sourceRootDir = path.join(sourceRoot, rootRel);
		if (!fs.existsSync(sourceRootDir)) continue;
		const excluded = new Set(rule.excludedPackages ?? []);
		for (const entry of fs.readdirSync(sourceRootDir, { withFileTypes: true })) {
			if (!entry.isDirectory() || excluded.has(entry.name) || excluded.has(`${rootRel}/${entry.name}`)) continue;
			const artifactRel = path.join(rootRel, entry.name, rule.artifactRelativePath);
			const source = path.join(sourceRoot, artifactRel);
			if (!fs.existsSync(source)) {
				if (rule.requiredIfPresentInRoot) throw missingSource('package artifact', artifactRel, targetDir);
				continue;
			}
			if (fs.existsSync(path.join(targetDir, rootRel, entry.name))) copyMissing(source, path.join(targetDir, artifactRel));
		}
	}
}
