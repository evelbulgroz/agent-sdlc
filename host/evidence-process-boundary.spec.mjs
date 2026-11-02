import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { spawnEvidence } from './evidence-transport.ts';

function alive(pid) {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
		return !/^\d+ \(.*\) Z /.test(stat);
	} catch { return false; }
}

for (const timeout of [false, true]) {
	test(`real ${timeout ? 'timeout' : 'success'} kills explicit child and grandchild before returning`, {
		skip: process.platform !== 'linux',
	}, async () => {
		const grandchild = 'setInterval(() => {}, 1000)';
		const child = `
			const {spawn}=require('node:child_process');
			const grandchild=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});
			process.stdout.write(JSON.stringify([process.pid,grandchild.pid])+'\\n');
			setInterval(()=>{},1000);
		`;
		const parent = `
			const {spawn}=require('node:child_process');
			const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','pipe','ignore']});
			child.stdout.once('data',data=>{
				process.stdout.write(data,()=>{${timeout ? '' : 'process.exit(0)'}});
			});
			setInterval(()=>{},1000);
		`;
		let pids = [];
		try {
			const result = await spawnEvidence(spawn, [process.execPath, '-e', parent], '.',
				Buffer.alloc(0), { timeoutMs: 1000, maxReportBytes: 1024 }, {}, 0);
			pids = JSON.parse(result.stdout.toString());
			assert.equal(pids.length, 2);
			assert.equal(result.failureReason, timeout ? 'timeout' : null);
			assert.equal(result.exitCode, timeout ? null : 0);
			assert.deepEqual(pids.filter(alive), [], 'descendants must be stopped before source observation');
		} finally {
			for (const pid of pids.filter(alive)) process.kill(pid, 'SIGKILL');
		}
	});
}

test('rejects relative, missing and empty executable names without spawning', async () => {
	for (const argv of [['node'], ['./node'], [], ['']]) {
		let spawns = 0;
		const result = await spawnEvidence(() => { spawns++; throw Error('unexpected'); },
			argv, '.', Buffer.alloc(0), { timeoutMs: 100, maxReportBytes: 1024 }, {}, 0);
		assert.equal(spawns, 0);
		assert.equal(result.failureReason, 'spawn-failed');
	}
});
