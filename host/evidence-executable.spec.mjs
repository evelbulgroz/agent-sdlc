import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { AdapterRegistrationSchema, sha256 } from '../policy/contracts.ts';
import { hashEvidenceBytes, verifyEvidenceRegistration } from './evidence-files.ts';
import { spawnEvidence } from './evidence-transport.ts';

function fixture(t) {
	const root = path.resolve(`.evidence-executable-${crypto.randomUUID()}`);
	fs.mkdirSync(root);
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const command = path.join(root, 'adapter');
	const bytes = Buffer.from('#!/bin/sh\nprintf "{}"\n');
	fs.writeFileSync(command, bytes, { mode: 0o755 });
	const registration = {
		adapterId: 'executable-fixture', protocolVersion: '1.0.0',
		bundleFiles: [{ path: 'adapter', sha256: hashEvidenceBytes(bytes) }],
		dependencyFiles: [], configurationFiles: [], argv: [command],
		executableSha256: hashEvidenceBytes(bytes),
		profiles: [{ profileId: 'unit', layers: ['unit'], capabilities: [] }],
		qualificationArtifactHash: 'a'.repeat(64),
		limits: { timeoutMs: 1000, maxReportBytes: 1000, maxArtifactBytes: 1000, maxArtifacts: 1 },
	};
	return { root, command, registration, verify: () =>
		verifyEvidenceRegistration(root, registration, () => {}) };
}

test('frozen absolute executable bytes are bound with adapter files and canonical argv', t => {
	const f = fixture(t);
	assert.doesNotThrow(f.verify);
	const frozenHash = sha256(f.registration);
	f.registration.executableSha256 = 'b'.repeat(64);
	assert.notEqual(sha256(f.registration), frozenHash);
	assert.throws(f.verify, /frozen-adapter-file-changed/);
});

test('historical structural registrations remain readable but unqualified executables cannot run', t => {
	const f = fixture(t);
	for (const command of ['node', './adapter', '', null]) {
		f.registration.argv = [command];
		assert.throws(f.verify, /unqualified-evidence-executable/);
	}
	f.registration.argv = ['historical-fake'];
	delete f.registration.executableSha256;
	const historical = AdapterRegistrationSchema.parse(f.registration);
	assert.equal(Object.hasOwn(historical, 'executableSha256'), false);
	assert.equal(sha256(historical), sha256(f.registration));
	f.registration.argv = [f.command];
	assert.throws(f.verify, /unqualified-evidence-executable/);
});

test('replacement, nonexecutable files and symlink aliases invalidate frozen executable qualification', t => {
	const f = fixture(t);
	fs.chmodSync(f.command, 0o644);
	assert.throws(f.verify, /frozen-adapter-file-changed/);
	fs.chmodSync(f.command, 0o755);
	const alias = path.join(f.root, 'alias');
	fs.symlinkSync('adapter', alias);
	f.registration.argv = [alias];
	assert.throws(f.verify, /unsafe-file-path/);
	f.registration.argv = [f.command];
	fs.writeFileSync(f.command, '#!/bin/sh\nexit 0\n');
	assert.throws(f.verify, /frozen-adapter-file-changed/);
});

test('a planted executable on PATH is never discovered or invoked', async t => {
	const f = fixture(t);
	const marker = path.join(f.root, 'executed');
	fs.writeFileSync(path.join(f.root, 'node'), '#!/bin/sh\nprintf compromised > "$1"\n', { mode: 0o755 });
	const result = await spawnEvidence(spawn, ['node', marker], f.root, Buffer.alloc(0),
		{ timeoutMs: 1000, maxReportBytes: 1024 }, { PATH: f.root }, 0);
	assert.equal(result.failureReason, 'spawn-failed');
	assert.equal(fs.existsSync(marker), false);
});
