import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import { commandEntry, dispatchCommand, exitCodeForCommand } from './index.ts';

const CLI_DIR = path.join(REPOSITORY_ROOT, 'cli');

function resolvesToCliEntry(fromFile, specifier) {
	if (!specifier.startsWith('.')) return false;
	const resolved = path.normalize(path.join(path.dirname(fromFile), specifier));
	return resolved === path.join(CLI_DIR, 'cli.ts');
}

test('@ac AC-02 @case AC-02.2 check-spec exits 0 when ready and 2 when not', () => {
	assert.equal(exitCodeForCommand('check-spec', { ready: true }), 0);
	assert.equal(exitCodeForCommand('check-spec', { ready: false }), 2);
	assert.equal(exitCodeForCommand('check-spec', {}), 2);
});

test('@ac AC-02 @case AC-02.3 canary check and qualify keep their exit codes', () => {
	assert.equal(exitCodeForCommand('canary check', { eligible: true }), 0);
	assert.equal(exitCodeForCommand('canary check', { eligible: false }), 2);
	assert.equal(exitCodeForCommand('canary qualify', { status: 'PASSED' }), 0);
	assert.equal(exitCodeForCommand('canary qualify', { status: 'INCONCLUSIVE' }), 2);
	assert.equal(exitCodeForCommand('canary qualify', { status: 'FAILED' }), 3);
});

test('@ac AC-02 @case AC-02.4 reliability replay and report keep their exit codes', () => {
	assert.equal(exitCodeForCommand('reliability replay', { status: 'PASSED' }), 0);
	assert.equal(exitCodeForCommand('reliability replay', { status: 'FAILED' }), 3);
	assert.equal(exitCodeForCommand('reliability report', { status: 'INCOMPLETE' }), 2);
	assert.equal(exitCodeForCommand('reliability report', { state: 'HELP' }), 0);
	assert.equal(exitCodeForCommand('status', { state: 'DONE' }), 0);
});

test('@ac AC-03 @case AC-03.1 command and leaf modules do not import cli.mjs', () => {
	const files = [
		...fs.readdirSync(path.join(CLI_DIR, 'commands')).filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts')).map((name) => path.join(CLI_DIR, 'commands', name)),
		path.join(CLI_DIR, 'arguments.ts'),
		path.join(CLI_DIR, 'run-context.ts'),
		path.join(CLI_DIR, 'human-result.ts'),
		path.join(CLI_DIR, 'exit-codes.ts'),
	];
	const hits = [];
	for (const file of files) {
		const source = fs.readFileSync(file, 'utf8');
		for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
			if (resolvesToCliEntry(file, match[1])) hits.push(path.relative(REPOSITORY_ROOT, file));
		}
	}
	assert.deepEqual(hits, []);
});

test('@ac AC-03 @case AC-03.3 shell status invokes the injected runCliFn with a status argv', async () => {
	const calls = [];
	const runCliFn = async (args) => {
		calls.push(args);
		return { result: { ok: true, state: 'DONE' } };
	};
	await dispatchCommand(
		{
			command: 'shell status',
			values: new Map([['--run', 'run-1']]),
			booleans: new Set(),
		},
		{ rootDir: REPOSITORY_ROOT, streams: { stdout: { write() {} }, stderr: { write() {} } } },
		runCliFn,
	);
	assert.deepEqual(calls, [['status', '--run', 'run-1', '--json']]);
});

test('an unlisted command throws the unknown-command error', () => {
	assert.throws(
		() => commandEntry('missing'),
		(error) => error.code === 'INVALID_INPUT' && error.message === "Unknown command 'missing'",
	);
});

test('a command without an exit rule falls back to exitCodeForResult', () => {
	assert.equal(exitCodeForCommand('list', null), 0);
	assert.equal(exitCodeForCommand('list', { state: 'FAILED' }), 3);
});

test('shell status without runCliFn rejects before the driver', async () => {
	await assert.rejects(
		() => dispatchCommand(
			{ command: 'shell status', values: new Map([['--run', 'run-1']]), booleans: new Set() },
			{ rootDir: REPOSITORY_ROOT, streams: {} },
			undefined,
		),
		(error) => error.code === 'INVALID_INPUT' && /runCliFn/.test(error.message),
	);
});
