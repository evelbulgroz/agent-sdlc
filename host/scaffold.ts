import fs from 'node:fs';
import path from 'node:path';
import { SdlcError } from '../policy/errors.ts';
import { HOST_PROFILE_RELATIVE_PATH, HOST_PROFILE_SCHEMA_VERSION, HostProfileSchema } from './host-profile.ts';

export interface ScaffoldOptions {
	rootDir: string;
	packageRoot: string;
	profileId?: string;
	overwrite?: boolean;
	dryRun?: boolean;
}

export interface ScaffoldResult {
	profileId: string;
	files: string[];
	written: boolean;
}

const EVIDENCE_DIR = 'tools/acceptance-evidence';

function defaultProfileId(rootDir: string): string {
	const slug = path.basename(path.resolve(rootDir)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return slug || 'host';
}

// Top-level node:test files are what a plain `node --test` run discovers, so the draft binds and pins exactly those.
function discoverTestFiles(rootDir: string, packageRoot: string): string[] {
	return fs.readdirSync(path.join(rootDir, packageRoot), { withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.test\.(mjs|cjs|js)$/.test(entry.name))
		.map((entry) => entry.name)
		.sort();
}

function draftFiles(profileId: string, packageRoot: string, testFiles: string[]): Record<string, unknown> {
	const profile = {
		schemaVersion: HOST_PROFILE_SCHEMA_VERSION,
		profileId,
		repositoryId: profileId,
		adapter: 'default',
		stateDir: 'tools/.agent-sdlc',
		reviewDir: 'tools/.review',
		specDraftDir: 'docs/specs/drafts',
		hydration: [],
		workspace: { directories: [packageRoot] },
		acceptanceEvidence: {
			canaryId: 'canary-v1',
			slug: `${profileId}-canary`,
			evidenceDir: 'tools/.acceptance-evidence/canary-v1',
			runtimeDir: `${EVIDENCE_DIR}/runtime`,
			caseManifest: `${EVIDENCE_DIR}/corpus.json`,
			runtimeSources: `${EVIDENCE_DIR}/runtime.sources.json`,
			package: { root: packageRoot },
			sandbox: { readOnlyBinds: testFiles },
			commands: {
				unit: {
					argv: ['node', '--test', '--test-reporter=junit', '--test-reporter-destination={reportPath}', ...testFiles],
					pins: testFiles.map((file) => ({ file })),
				},
			},
		},
	};
	HostProfileSchema.parse(profile);
	return {
		[HOST_PROFILE_RELATIVE_PATH]: profile,
		[`${EVIDENCE_DIR}/corpus.json`]: { schemaVersion: '1.0.0', cases: [] },
		// Source paths are specific to the host's machine and toolchain, so they are left for the host to fill in.
		[`${EVIDENCE_DIR}/runtime.sources.json`]: {
			schemaVersion: '1.0.0',
			packageRoot,
			includeNativeDependencies: false,
			generatedFiles: [
				{ path: 'sysroot/etc/hosts', contents: '127.0.0.1 localhost\n::1 localhost\n' },
				{ path: 'sysroot/etc/nsswitch.conf', contents: 'hosts: files\n' },
			],
			allowedSourceRoots: [],
			entries: [],
		},
	};
}

/**
 * Proposes the data a Tier A host owns: one profile, an empty case corpus and a runtime-sources skeleton.
 * It writes drafts for the host to complete and never overwrites existing files without `overwrite`.
 */
export function scaffoldHost(options: ScaffoldOptions): ScaffoldResult {
	const root = path.resolve(options.rootDir);
	const packageRoot = options.packageRoot.replace(/\/+$/, '');
	if (!packageRoot || path.isAbsolute(packageRoot) || packageRoot.split('/').includes('..')) {
		throw new SdlcError('INVALID_INPUT', '--package must be a repository-relative directory');
	}
	if (!fs.statSync(path.join(root, packageRoot), { throwIfNoEntry: false })?.isDirectory()) {
		throw new SdlcError('INVALID_INPUT', `--package directory does not exist: ${packageRoot}`);
	}
	const profileId = options.profileId ?? defaultProfileId(root);
	let files: Record<string, unknown>;
	try {
		files = draftFiles(profileId, packageRoot, discoverTestFiles(root, packageRoot));
	} catch (error) {
		throw new SdlcError('INVALID_INPUT', `cannot scaffold profile '${profileId}': ${error instanceof Error ? error.message : String(error)}`);
	}
	const names = Object.keys(files);
	const existing = names.filter((name) => fs.existsSync(path.join(root, name)));
	if (existing.length > 0 && !options.overwrite) {
		throw new SdlcError('INVALID_INPUT', `refusing to overwrite: ${existing.join(', ')} (pass --overwrite)`);
	}
	if (options.dryRun) return { profileId, files: names, written: false };
	for (const name of names) {
		const target = path.join(root, name);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, `${JSON.stringify(files[name], null, '\t')}\n`);
	}
	return { profileId, files: names, written: true };
}
