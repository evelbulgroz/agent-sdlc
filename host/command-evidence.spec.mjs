import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PINNED_FILE_MODIFIED, recordPins, substituteArgv, verifyPins } from './command-evidence.ts';
import { assertPinsOutsideWriteScope } from '../acceptance/command-evidence.mjs';
import { commandQualificationReceipt } from '../acceptance/command-qualification.mjs';

const fixture = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-evidence-'));
	fs.mkdirSync(path.join(root, 'app'));
	fs.writeFileSync(path.join(root, 'app/package.json'), JSON.stringify({ name: 'a', scripts: { test: 'node t.mjs' } }));
	fs.writeFileSync(path.join(root, 'app/cases.json'), '[]');
	return root;
};

test('@ac AC-04 @case AC-04.1 placeholders substitute only as a token or key=value in non-executable position', () => {
	const values = { reportPath: '/report/u.xml', baseSha: 'abc' };
	assert.deepEqual(substituteArgv(['node', '--out={reportPath}', '{baseSha}'], values), ['node', '--out=/report/u.xml', 'abc']);
	for (const bad of [['{reportPath}'], ['node', '{other}'], ['node', 'x{reportPath}'], ['node', '{reportPath}{baseSha}']]) {
		assert.throws(() => substituteArgv(bad, values), /invalid-command-placeholder/);
	}
});

test('@ac AC-06 @case AC-06.1 pins fail on whole-file or script change but ignore unrelated package.json fields', () => {
	const root = fixture();
	const pins = recordPins(root, 'app', [{ file: 'cases.json' }, { script: { file: 'package.json', name: 'test' } }]);
	const pkgPath = path.join(root, 'app/package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	fs.writeFileSync(pkgPath, JSON.stringify({ ...pkg, description: 'x', dependencies: { y: '1' } }));
	verifyPins(root, pins);
	fs.writeFileSync(pkgPath, JSON.stringify({ ...pkg, scripts: { test: 'true' } }));
	assert.throws(() => verifyPins(root, pins), new RegExp(PINNED_FILE_MODIFIED));
	fs.writeFileSync(pkgPath, JSON.stringify(pkg));
	verifyPins(root, pins);
	fs.writeFileSync(path.join(root, 'app/cases.json'), '[1]');
	assert.throws(() => verifyPins(root, pins), new RegExp(PINNED_FILE_MODIFIED));
	fs.rmSync(root, { recursive: true });
});

test('@ac AC-06 @case AC-06.2 whole-file pins inside the write scope are rejected at admission', () => {
	const regs = [{ pins: [{ kind: 'file', path: 'app/cases.json' }, { kind: 'script', file: 'app/package.json', name: 't' }] }];
	assertPinsOutsideWriteScope(regs, ['src/']);
	assert.throws(() => assertPinsOutsideWriteScope(regs, ['app/']), /write scope/);
});

test('@ac AC-10 @case AC-10.1 qualification receipt passes engine fixtures and fails a wrong sentinel', () => {
	assert.equal(commandQualificationReceipt({}).status, 'passed');
	const rows = [{ name: '@case AC-01.1 a', outcome: 'failed', message: '' }];
	assert.equal(commandQualificationReceipt({ sentinelDeclared: true, sentinel: { rows, exitCode: 1, planted: 'AC-01.1' } }).status, 'passed');
	assert.equal(commandQualificationReceipt({ sentinelDeclared: true, sentinel: { rows, exitCode: 0, planted: 'AC-01.1' } }).status, 'blocked');
	assert.equal(commandQualificationReceipt({ sentinelDeclared: true, sentinel: { rows, exitCode: 1, planted: 'AC-09.9' } }).status, 'blocked');
	assert.equal(commandQualificationReceipt({ sentinelDeclared: true }).status, 'blocked');
});
