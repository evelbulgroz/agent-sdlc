import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256 } from '../policy/contracts/primitives.ts';
import { CommandRegistrationSchema } from '../policy/contracts/quality-evidence-schema.ts';
import { commandRegistrationFixture } from '../testing/command-registration-fixture.ts';
import {
	commandBindingHash, commandScope, evidenceRegistrationFiles, recordPins, resolveExecutable, verifyCommandRegistration,
} from './command-evidence.ts';

test('omitted command scope preserves the old hash and parsed registration projection', () => {
	const legacy = commandRegistrationFixture();
	assert.deepEqual(CommandRegistrationSchema.parse(legacy), legacy);
	assert.equal(commandScope(legacy), undefined);
	assert.equal(legacy.commandSha256, sha256({
		argv: legacy.argv, executableSha256: legacy.executable.sha256, pins: legacy.pins,
	}));
	const pretest = [{ id: 'setup', argv: legacy.argv, cwd: 'src', timeoutMs: 1000, executable: legacy.executable, pins: [] }];
	assert.equal(commandBindingHash(legacy.argv, legacy.executable.sha256, [], pretest),
		sha256({ argv: legacy.argv, executableSha256: legacy.executable.sha256, pins: [], pretest }));
});

test('explicit scope freezes root, cwd and identity without weakening pin verification', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-scope-'));
	t.after(() => fs.rmSync(root, { recursive: true }));
	fs.mkdirSync(path.join(root, 'packages/app/sub'), { recursive: true });
	fs.writeFileSync(path.join(root, 'packages/app/pin.txt'), 'frozen');
	const executable = resolveExecutable(process.execPath, process.env.PATH ?? '');
	const pins = recordPins(root, 'packages/app', [{ file: 'pin.txt' }]);
	const argv = [process.execPath, 'pin.txt', '{reportPath}'];
	const scope = { cwd: 'packages/app', packageRoot: 'packages', caseIdentity: 'case-file-criterion' };
	const registration = CommandRegistrationSchema.parse(commandRegistrationFixture({
		argv, executable, pins, ...scope, commandSha256: commandBindingHash(argv, executable.sha256, pins, [], scope),
	}));
	verifyCommandRegistration(root, registration);
	assert.ok(evidenceRegistrationFiles(registration).some((item) => item.path === 'packages'));
	for (const override of [
		{ packageRoot: 'packages/app' }, { cwd: 'packages/app/sub' }, { caseIdentity: 'case' },
		{ packageRoot: undefined }, { caseIdentity: undefined },
	]) {
		assert.throws(() => verifyCommandRegistration(root, { ...registration, ...override }), /frozen-adapter-file-changed/);
	}
	fs.writeFileSync(path.join(root, 'packages/app/pin.txt'), 'changed');
	assert.throws(() => verifyCommandRegistration(root, registration), /PINNED_FILE_MODIFIED/);
});

test('scoped registrations reject escaped cwd and symlinked roots', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-root-'));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'command-root-outside-'));
	t.after(() => { fs.rmSync(root, { recursive: true }); fs.rmSync(outside, { recursive: true }); });
	fs.symlinkSync(outside, path.join(root, 'src'));
	const executable = resolveExecutable(process.execPath, process.env.PATH ?? '');
	const scope = { cwd: 'src', packageRoot: 'src', caseIdentity: 'case-file-criterion' };
	const legacy = commandRegistrationFixture({ executable });
	const registration = CommandRegistrationSchema.parse({
		...legacy, ...scope, commandSha256: commandBindingHash(legacy.argv, executable.sha256, [], [], scope),
	});
	assert.throws(() => verifyCommandRegistration(root, registration), /unsafe-directory/);
	for (const override of [{ cwd: 'src-other' }, { packageRoot: '../src' }, { packageRoot: null }, { caseIdentity: 'unknown' }]) {
		assert.equal(CommandRegistrationSchema.safeParse({ ...registration, ...override }).success, false);
	}
});
