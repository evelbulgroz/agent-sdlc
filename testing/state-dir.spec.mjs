import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	REPOSITORY_ROOT,
	archiveRoot,
	liveRunRoot,
} from '../persistence/run-paths.ts';

function withTempDir(fn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-state-dir-'));
	return Promise.resolve()
		.then(() => fn(dir))
		.finally(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});
}

test('@ac AC-05 @case AC-05.1 liveRunRoot and archiveRoot resolve custom stateDir from .agents/sdlc-host.json', async () => {
	await withTempDir(async (dir) => {
		fs.mkdirSync(path.join(dir, '.agents'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.agents/sdlc-host.json'),
			JSON.stringify(
				{
					schemaVersion: '1.2.0',
					profileId: 'custom-state-host',
					repositoryId: 'custom-state-host',
					adapter: 'script',
					stateDir: 'var/.sdlc',
					reviewDir: 'tools/.review',
					specDraftDir: 'docs/specs/drafts',
					verify: {
						argv: ['node', 'verify.mjs', '{baseSha}'],
						resultPath: 'tools/.verify/last.json',
						headField: 'head',
						require: { status: 'OK', canonical: true },
					},
					commands: [['node', '--test']],
					hydration: [],
					workspace: { directories: ['.'] },
				},
				null,
				2,
			),
			'utf8',
		);

		assert.equal(liveRunRoot(dir), path.join(dir, 'var/.sdlc'));
		assert.equal(archiveRoot(dir), path.join(dir, 'var/.sdlc/.archive'));
	});
});

test('@ac AC-05 @case AC-05.2 liveRunRoot(REPOSITORY_ROOT) returns tools/.agent-sdlc', () => {
	assert.equal(
		liveRunRoot(REPOSITORY_ROOT),
		path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc'),
	);
});

test('@ac AC-05 @case AC-05.3 liveRunRoot falls back to .agent-sdlc when .agents/sdlc-host.json is absent', async () => {
	await withTempDir(async (dir) => {
		assert.equal(liveRunRoot(dir), path.join(dir, '.agent-sdlc'));
		assert.equal(archiveRoot(dir), path.join(dir, '.agent-sdlc/.archive'));
	});
});

test('a custom stateDir is honoured by run paths, archive paths, and the PR-body message', async () => {
	const { writeSyntheticHostProfile } = await import('./cli-test-support.mjs');
	const { stateDirRelative, archivedRunRelativePath } = await import('../persistence/run-paths.ts');
	const { humanResult } = await import('../cli/human-result.ts');
	await withTempDir(async (dir) => {
		assert.equal(stateDirRelative(dir), '.agent-sdlc');
		writeSyntheticHostProfile(dir, { stateDir: 'var/sdlc-state' });
		assert.equal(liveRunRoot(dir), path.join(dir, 'var/sdlc-state'));
		assert.equal(archivedRunRelativePath('r1', dir), 'var/sdlc-state/.archive/r1');
		const text = humanResult('pr', { runId: 'r1' }, dir);
		assert.match(text, /var\/sdlc-state\/r1\/artifacts\/pr-body\.md/);
		assert.doesNotMatch(text, /tools\/\.agent-sdlc/);
	});
});
