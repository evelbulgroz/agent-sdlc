import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { spawnEvidence } from './evidence-transport.ts';

function fakeChild() {
	const child = new EventEmitter();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.stdin = new PassThrough();
	child.kill = (signal) => { queueMicrotask(() => child.emit('close', null, signal)); return true; };
	return child;
}

const LIMITS = { timeoutMs: 500, maxReportBytes: 1024 };

test('spawn errors and later child errors fail closed and retain bounded protocol output', async () => {
	const result = await spawnEvidence(() => { throw new Error('SECRET=unsafe'); },
		['/fake'], '.', Buffer.from('{}'), LIMITS, {}, 128);
	assert.equal(result.failureReason, 'spawn-failed');
	assert.equal(result.exitCode, null);
	const child = fakeChild();
	const running = spawnEvidence(() => child, ['/fake'], '.', Buffer.from('{}'), LIMITS, {}, 128);
	child.emit('error', new Error('SECRET=unsafe'));
	const failed = await running;
	assert.equal(failed.failureReason, 'process-error');
	assert.equal(failed.signal, 'SIGKILL');
});

test('stdin transport errors stop the child before completion', async () => {
	const child = fakeChild();
	const running = spawnEvidence(() => child, ['/fake'], '.', Buffer.from('{}'), LIMITS, {}, 128);
	child.stdin.emit('error', new Error('input unavailable'));
	const result = await running;
	assert.equal(result.failureReason, 'stdin-error');
	assert.equal(result.signal, 'SIGKILL');
});

test('stderr is capped and sanitized, never appended to stdout evidence', async () => {
	const child = fakeChild();
	const diagnostics = [];
	const running = spawnEvidence(() => child, ['/fake'], '.', Buffer.from('{}'), LIMITS, {}, 128,
		(message) => diagnostics.push(message));
	child.stdout.write('{}');
	child.stderr.write('TOKEN=top-secret\nAuthorization: Bearer another-secret\nhttp://user:secret@example.test\n' + 'x'.repeat(512));
	child.emit('close', 0, null);
	const result = await running;
	assert.equal(result.stdout.toString(), '{}');
	assert.equal(result.failureReason, null);
	assert.equal(diagnostics.length, 1);
	assert.ok(Buffer.byteLength(diagnostics[0]) <= 128);
	assert.doesNotMatch(diagnostics[0], /top-secret|another-secret|user:secret/);
});

test('diagnostic callback exceptions do not turn a completed process into interrupted work', async () => {
	const child = fakeChild();
	const running = spawnEvidence(() => child, ['/fake'], '.', Buffer.from('{}'), LIMITS, {}, 128,
		() => { throw new Error('callback failed'); });
	child.stderr.write('ordinary diagnostic');
	child.emit('close', 0, null);
	const result = await running;
	assert.equal(result.exitCode, 0);
	assert.equal(result.failureReason, null);
});

test('real process timeout kills descendants that keep inherited pipes open', {
	skip: process.platform !== 'linux',
}, async () => {
	const startedAt = Date.now();
	const result = await spawnEvidence(
		(command, args, options) => spawn(command, args, options),
		['/bin/sh', '-c', 'sleep 0.6'],
		'.',
		Buffer.alloc(0),
		{ timeoutMs: 50, maxReportBytes: 1024 },
		{ PATH: process.env.PATH ?? '/usr/bin:/bin' },
		128,
	);
	assert.equal(result.failureReason, 'timeout');
	assert.equal(result.signal, 'SIGKILL');
	assert.ok(Date.now() - startedAt < 500, 'timeout completion must not wait for descendants');
});

test('early child stdin closure preserves healthy stdout and exit status', async () => {
	const result = await spawnEvidence(
		(command, args, options) => spawn(command, args, options),
		[process.execPath, '-e', "process.stdout.write('healthy'); process.exit(0)"],
		'.',
		Buffer.alloc(8 * 1024 * 1024),
		{ timeoutMs: 1000, maxReportBytes: 1024 },
		{},
		128,
	);
	assert.equal(result.stdout.toString('utf8'), 'healthy');
	assert.equal(result.exitCode, 0);
	assert.equal(result.failureReason, null);
});
