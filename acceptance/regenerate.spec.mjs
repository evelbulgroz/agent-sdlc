import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { approveAdmission, assertPreflightCurrent, pinnedReferences, regenerateAdmission, runIdFor, stalePins } from './regenerate.ts';
import { bytesHash } from './primitives.ts';

const config = { output: 'ev/c1', slug: 'canary-run', preflightResult: 'pre.json', preflightCommand: ['run', 'preflight'], canary: { spec: 's.md', tasks: 't.json' } };

function repo(t) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-regenerate-')));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
	git('init', '-q');
	fs.writeFileSync(path.join(root, 'a.txt'), 'a');
	git('add', '.');
	git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
	return { root, head: git('rev-parse', 'HEAD') };
}

test('pinned references skip sandbox mounts, absolute executables and report missing or changed files', (t) => {
	const { root } = repo(t);
	const good = bytesHash(Buffer.from('a'));
	const value = { x: [{ path: 'a.txt', sha256: good }, { path: 'gone.txt', sha256: good }, { path: 'a.txt', sha256: 'b'.repeat(64) },
		{ path: '@worktree/skip.js', sha256: good }, { path: '/opt/node/bin/node', sha256: good }], note: { path: 'no-hash' } };
	assert.equal(pinnedReferences(value).length, 3);
	assert.deepEqual(stalePins(root, 'r', value), ['r: missing gone.txt', 'r: changed a.txt']);
});

test('the run id is the UTC date plus the profile slug', () => {
	assert.equal(runIdFor(config, new Date('2026-11-07T23:30:00+01:00')), '2026-11-07-canary-run');
});

test('regeneration refuses a dirty host and a preflight for another commit', async (t) => {
	const { root, head } = repo(t);
	const cwd = process.cwd();
	t.after(() => process.chdir(cwd));
	process.chdir(root);
	fs.writeFileSync(path.join(root, 'pre.json'), JSON.stringify({ gitHeadSha: head, status: 'OK', canonical: true }));
	await assert.rejects(regenerateAdmission({ root, config, engine: 'e', run: async () => {} }), /host worktree is dirty/);
	assert.throws(() => assertPreflightCurrent(root, config, '0'.repeat(40)), /not a canonical OK for HEAD/);
	await assert.rejects(regenerateAdmission({ root, config, engine: '', run: async () => {} }), /AGENT_SDLC_PATH is required/);
});

test('approval writes both receipts bound to HEAD, the approved manifest and the envelope, then verifies', async (t) => {
	const { root, head } = repo(t);
	const dir = `ev/c1/h${head.slice(0, 8)}`;
	fs.mkdirSync(path.join(root, dir, 'first-run'), { recursive: true });
	fs.mkdirSync(path.join(root, 'ev/c1/responses'), { recursive: true });
	fs.writeFileSync(path.join(root, dir, 'admission.json'), JSON.stringify({ admission: 'BLOCKED' }));
	fs.writeFileSync(path.join(root, dir, 'first-run/run-authorizations.json'), JSON.stringify({ authorizations: [{ runId: 'r1' }] }));
	fs.writeFileSync(path.join(root, 'ev/c1/responses/envelope.json'), '{"old":true}');
	const verified = [];
	const done = await approveAdmission({ root, config, now: new Date('2026-11-07T00:00:00Z'), verify: async (manifest) => { verified.push(manifest); },
		approval: { approvedBy: 'op', text: 'said yes', implementationScope: 'impl', liveScope: 'live' } });
	const approved = JSON.parse(fs.readFileSync(path.join(root, done.manifest), 'utf8'));
	assert.equal(approved.admission, 'APPROVED');
	const receipt = JSON.parse(fs.readFileSync(path.join(root, approved.liveApprovalReceipt.path), 'utf8'));
	assert.deepEqual([receipt.baseCommitSha, receipt.approval, receipt.scope], [head, 'said yes', 'live']);
	assert.equal(approved.liveApprovalReceipt.sha256, bytesHash(fs.readFileSync(path.join(root, approved.liveApprovalReceipt.path))));
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'ev/c1/responses/envelope.json'), 'utf8')), { runId: 'r1' });
	assert.deepEqual(verified, [done.manifest]);
});
