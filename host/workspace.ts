import fs from 'node:fs';
import path from 'node:path';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import {
	type PackageJsonMetadata,
	type WorkspacePackagesScan,
	scanWorkspacePackages,
} from '../policy/task-planner/workspace-packages.ts';
import {
	HOST_PROFILE_RELATIVE_PATH,
	loadHostProfile,
	type HostProfile,
} from './host-profile.ts';

export interface WorkspaceDiscoveryResult extends WorkspacePackagesScan {
	readonly directories: string[];
	readonly roots: string[];
}

function parsePnpmWorkspaceLiteralEntries(rootDir: string): string[] {
	const workspaceYamlPath = path.join(rootDir, 'pnpm-workspace.yaml');
	if (!fs.existsSync(workspaceYamlPath)) {
		return [];
	}
	const text = fs.readFileSync(workspaceYamlPath, 'utf8');
	const entries: string[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (!trimmed.startsWith('-')) continue;
		const value = trimmed
			.slice(1)
			.trim()
			.replace(/^['"]|['"]$/g, '')
			.replace(/\/+$/, '');
		if (value.length > 0 && !value.includes('*') && !value.startsWith('!')) {
			entries.push(value);
		}
	}
	return entries;
}

function resolveProfileForWorkspace(
	rootDir: string,
	profile?: HostProfile | null,
): HostProfile | { adapter: 'fitness-app' } {
	if (profile) {
		return profile;
	}
	if (fs.existsSync(path.join(rootDir, HOST_PROFILE_RELATIVE_PATH))) {
		return loadHostProfile(rootDir);
	}
	return { adapter: 'fitness-app' };
}

export function discoverWorkspace(
	rootDir: string = REPOSITORY_ROOT,
	profile?: HostProfile | null,
): WorkspaceDiscoveryResult {
	const resolved = resolveProfileForWorkspace(rootDir, profile);
	if (resolved.adapter === 'script' && (resolved.workspace.directories?.length ?? 0) > 0) {
		const directories = [...(resolved.workspace.directories ?? [])];
		const packageMap = new Map<string, { packagePath: string; pkgJson: PackageJsonMetadata }>();
		const pathToPackage = new Map<string, string>();
		for (const dir of directories) {
			packageMap.set(dir, { packagePath: dir, pkgJson: { name: dir } });
			pathToPackage.set(dir, dir);
		}
		return {
			directories,
			roots: directories,
			packageMap,
			pathToPackage,
		};
	}

	const { packageMap, pathToPackage } = scanWorkspacePackages(rootDir);
	for (const entry of parsePnpmWorkspaceLiteralEntries(rootDir)) {
		if (!pathToPackage.has(entry)) {
			pathToPackage.set(entry, entry);
			if (!packageMap.has(entry)) {
				packageMap.set(entry, { packagePath: entry, pkgJson: { name: entry } });
			}
		}
	}
	const directories = [...pathToPackage.keys()];
	return {
		directories,
		roots: directories,
		packageMap,
		pathToPackage,
	};
}
