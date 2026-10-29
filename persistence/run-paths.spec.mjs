import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HOST_PROFILE_RELATIVE_PATH } from '../host/host-profile.ts';
import {
	REPOSITORY_ROOT,
	archiveRoot,
	archivedRunRelativePath,
	createRuntimeDirectory,
	listRunDatabases,
	liveRunRoot,
	resolveExportPath,
	resolveRepositoryRoot,
	resolveRunPaths,
	runsRootDir,
} from './run-paths.ts';

test('run paths reject malformed IDs, missing runs, nested paths, and symlink escapes', () => {
	assert.throws(() => resolveRunPaths('../escape', REPOSITORY_ROOT), /YYYY-MM-DD/);
	assert.throws(
		() => resolveRunPaths('2026-09-04-missing-run', REPOSITORY_ROOT),
		(error) => error.code === 'RUN_NOT_FOUND',
	);
	const suffix = crypto.randomUUID().slice(0, 8);
	const runId = `${new Date().toISOString().slice(0, 10)}-symlink-${suffix}`;
	const target = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `outside-${suffix}`);
	const runLink = path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId);
	const runtimeDir = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId);
	fs.mkdirSync(target, { recursive: true });
	fs.mkdirSync(runtimeDir, { recursive: true });
	fs.symlinkSync(target, runLink, 'dir');
	try {
		assert.throws(
			() => resolveRunPaths(runId, REPOSITORY_ROOT),
			(error) => error.code === 'PATH_OUTSIDE_ROOT',
		);
	} finally {
		fs.unlinkSync(runLink);
		fs.rmSync(target, { recursive: true, force: true });
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	}
});

test('runtime directory acquisition is exclusive and export containment rejects traversal', () => {
	const suffix = crypto.randomUUID().slice(0, 8);
	const runId = `${new Date().toISOString().slice(0, 10)}-paths-${suffix}`;
	const runtimeDir = createRuntimeDirectory(runId, REPOSITORY_ROOT);
	try {
		assert.throws(
			() => createRuntimeDirectory(runId, REPOSITORY_ROOT),
			(error) => error.code === 'RUN_ALREADY_EXISTS',
		);
		const outside = path.join('..', `outside-${suffix}`, 'export.json');
		assert.throws(
			() => resolveExportPath(outside, runId, REPOSITORY_ROOT),
			(error) => error.code === 'PATH_OUTSIDE_ROOT',
		);
		assert.equal(
			fs.existsSync(path.resolve(REPOSITORY_ROOT, outside)),
			false,
			'rejected traversal must not create directories',
		);
	} finally {
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	}
});

test('export containment rejects symlink components before creating outside directories', () => {
	const suffix = crypto.randomUUID().slice(0, 8);
	const runId = `${new Date().toISOString().slice(0, 10)}-export-link-${suffix}`;
	const runtimeDir = createRuntimeDirectory(runId, REPOSITORY_ROOT);
	const outside = path.join(REPOSITORY_ROOT, `.agent-sdlc-export-outside-${suffix}`);
	const link = path.join(runtimeDir, 'escape');
	fs.mkdirSync(outside, { mode: 0o700 });
	fs.symlinkSync(outside, link, 'dir');
	try {
		assert.throws(
			() =>
				resolveExportPath(
					`tools/.agent-sdlc/${runId}/escape/new/export.json`,
					runId,
					REPOSITORY_ROOT,
				),
			(error) => error.code === 'PATH_OUTSIDE_ROOT',
		);
		assert.equal(fs.existsSync(path.join(outside, 'new')), false);
	} finally {
		fs.unlinkSync(link);
		fs.rmSync(outside, { recursive: true, force: true });
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	}
});

test('liveRunRoot, archiveRoot, and listRunDatabases discover live and archived run databases', () => {
	const root = fs.mkdtempSync(path.join(REPOSITORY_ROOT, '.agent-sdlc-run-paths-'));
	try {
		assert.equal(liveRunRoot(root), path.join(root, '.agent-sdlc'));
		assert.equal(archiveRoot(root), path.join(root, '.agent-sdlc/.archive'));
		assert.equal(
			archivedRunRelativePath('2026-10-01-sample', root),
			'.agent-sdlc/.archive/2026-10-01-sample',
		);
		assert.deepEqual(listRunDatabases(root), []);

		const liveDir = path.join(liveRunRoot(root), '2026-10-01-live');
		const archivedDir = path.join(archiveRoot(root), '2026-09-15-archived');
		const partialDir = path.join(archiveRoot(root), '2026-09-16-partial.partial');
		const fixturesDir = path.join(liveRunRoot(root), 'test-fixtures');
		fs.mkdirSync(liveDir, { recursive: true });
		fs.mkdirSync(archivedDir, { recursive: true });
		fs.mkdirSync(partialDir, { recursive: true });
		fs.mkdirSync(fixturesDir, { recursive: true });
		fs.writeFileSync(path.join(liveDir, 'runtime.sqlite'), 'live');
		fs.writeFileSync(path.join(archivedDir, 'runtime.sqlite'), 'archived');
		fs.writeFileSync(path.join(partialDir, 'runtime.sqlite'), 'partial');
		fs.writeFileSync(path.join(fixturesDir, 'runtime.sqlite'), 'fixture');

		const dbs = listRunDatabases(root);
		assert.deepEqual(
			dbs.map((item) => ({ runId: item.runId, archived: item.archived })),
			[
				{ runId: '2026-10-01-live', archived: false },
				{ runId: '2026-09-15-archived', archived: true },
			],
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function writeHostProfile(rootDir, payload) {
	const profilePath = path.join(rootDir, HOST_PROFILE_RELATIVE_PATH);
	fs.mkdirSync(path.dirname(profilePath), { recursive: true });
	fs.writeFileSync(profilePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

test('@ac AC-02 @case AC-02.1 omitting runsDir in a 1.3.0 host profile co-locates runsRootDir with liveRunRoot and resolves runDir === runtimeDir', () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-run-paths-13-'));
	try {
		writeHostProfile(rootDir, {
			schemaVersion: '1.3.0',
			profileId: 'acme-client',
			repositoryId: 'acme-client',
			adapter: 'script',
			hydration: [['pnpm', 'install']],
			commands: [['pnpm', 'test']],
			workspace: { directories: ['.'] },
			verify: {
				argv: ['pnpm', 'run', 'verify', '--', '{baseSha}'],
				resultPath: '.agent-sdlc/verify.json',
				require: { status: 'OK', canonical: true },
				headField: 'gitHeadSha',
			},
		});
		fs.mkdirSync(path.join(rootDir, '.agent-sdlc'), { recursive: true });
		assert.equal(runsRootDir(rootDir), liveRunRoot(rootDir));
		assert.equal(runsRootDir(rootDir), path.join(rootDir, '.agent-sdlc'));

		const runId = '2026-10-26-colocated-sample';
		const resolved = resolveRunPaths(runId, rootDir, { mustExist: false });
		assert.equal(resolved.runDir, resolved.runtimeDir);
		assert.equal(resolved.runDir, path.join(fs.realpathSync(path.join(rootDir, '.agent-sdlc')), runId));
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-02 @case AC-02.2 schemaVersion 1.2.0 host profile preserves docs/specs/runs for runsRootDir', () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-run-paths-12-'));
	try {
		writeHostProfile(rootDir, {
			schemaVersion: '1.2.0',
			profileId: 'legacy-client',
			repositoryId: 'legacy-client',
			adapter: 'script',
			stateDir: 'var/.sdlc',
			reviewDir: 'var/.review',
			specDraftDir: 'docs/specs/drafts',
			hydration: [['pnpm', 'install']],
			commands: [['pnpm', 'test']],
			workspace: { directories: ['.'] },
			verify: {
				argv: ['pnpm', 'run', 'verify', '--', '{baseSha}'],
				resultPath: 'var/.sdlc/verify.json',
				require: { status: 'OK', canonical: true },
				headField: 'gitHeadSha',
			},
		});
		assert.equal(runsRootDir(rootDir), path.join(rootDir, 'docs/specs/runs'));
		assert.notEqual(runsRootDir(rootDir), liveRunRoot(rootDir));
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-02 @case AC-02.3 resolveRunPaths throws RUN_NOT_FOUND without creating runsRoot when configured runsDir does not exist on disk', () => {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-run-paths-no-side-effect-'));
	try {
		writeHostProfile(rootDir, {
			schemaVersion: '1.3.0',
			profileId: 'custom-runs-client',
			repositoryId: 'custom-runs-client',
			adapter: 'script',
			runsDir: 'custom/runs',
			hydration: [['pnpm', 'install']],
			commands: [['pnpm', 'test']],
			workspace: { directories: ['.'] },
			verify: {
				argv: ['pnpm', 'run', 'verify', '--', '{baseSha}'],
				resultPath: '.agent-sdlc/verify.json',
				require: { status: 'OK', canonical: true },
				headField: 'gitHeadSha',
			},
		});
		const customRunsPath = path.join(rootDir, 'custom/runs');
		assert.throws(
			() => resolveRunPaths('2026-10-26-missing-root', rootDir, { mustExist: false }),
			(error) => error?.code === 'RUN_NOT_FOUND',
		);
		assert.equal(fs.existsSync(customRunsPath), false);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.1 resolveRepositoryRoot honors AGENT_SDLC_REPO_ROOT, strips node_modules paths, and no .ts file contains ../../..', () => {
	const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-repo-root-'));
	try {
		assert.equal(
			resolveRepositoryRoot('/some/other/dir', { AGENT_SDLC_REPO_ROOT: tempHost }),
			tempHost,
		);
		const nestedNodeModules = path.join(tempHost, 'node_modules/@evelbulgroz/agent-sdlc/dist');
		const resolved = resolveRepositoryRoot(nestedNodeModules, {});
		assert.equal(resolved, tempHost);
		assert.equal(resolved.includes('node_modules'), false);
	} finally {
		fs.rmSync(tempHost, { recursive: true, force: true });
	}

	const pkgRoot = path.resolve(import.meta.dirname, '..');
	function walkTs(dir) {
		const found = [];
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) found.push(...walkTs(full));
			else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.push(full);
		}
		return found;
	}
	for (const file of walkTs(pkgRoot)) {
		const src = fs.readFileSync(file, 'utf8');
		assert.equal(src.includes('../../..'), false, `${path.relative(pkgRoot, file)} contains ../../..`);
	}
});
