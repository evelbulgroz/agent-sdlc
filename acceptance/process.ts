import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fail } from './primitives.ts';
import type { OwnedOptions, OwnedResult, SandboxMount, SupervisedLaunch } from './types.ts';

const errorCode = (error: unknown): unknown => (error as NodeJS.ErrnoException).code;

function processGroupId(pid: number | string): number | null {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
		return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
	} catch (error) {
		if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ESRCH') return null;
		throw error;
	}
}

// Own the whole process group, including descendants surviving a successful parent.
export function executeOwned(argv: readonly string[], {
	cwd, env = {}, timeoutMs, maxBytes = 1048576, ownerGroupId = null,
}: OwnedOptions = {}): Promise<OwnedResult> {
	if (!Array.isArray(argv) || !path.isAbsolute(argv[0] as string) || typeof timeoutMs !== 'number'
		|| !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('unbounded/non-absolute execution');
	if (ownerGroupId !== null && (ownerGroupId !== process.pid
		|| processGroupId(process.pid) !== process.pid)) fail('adapter must own its process group');
	return new Promise((resolve, reject) => {
		const child = spawn(argv[0] as string, argv.slice(1), {
			env, ...(cwd === undefined ? {} : { cwd }), detached: ownerGroupId === null, stdio: ['ignore', 'pipe', 'pipe'],
		});
		const output = { stdout: '', stderr: '' };
		let settled = false;
		let terminalError: unknown = null;
		let timer: NodeJS.Timeout | undefined;
		let drainTimer: NodeJS.Timeout | undefined;
		const killGroup = () => {
			if (!child.pid) return;
			try {
				if (ownerGroupId === null) process.kill(-child.pid, 'SIGKILL');
				else {
					for (const entry of fs.readdirSync('/proc')) {
						const pid = Number(entry);
						if (pid > 0 && pid !== ownerGroupId && processGroupId(pid) === ownerGroupId) {
							try { process.kill(pid, 'SIGKILL'); }
							catch (error) { if (errorCode(error) !== 'ESRCH') throw error; }
						}
					}
				}
			}
			catch (error) { if (errorCode(error) !== 'ESRCH') terminalError ??= error; }
		};
		const finish = (code: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(drainTimer);
			child.stdout.destroy();
			child.stderr.destroy();
			if (terminalError) reject(terminalError);
			else resolve({ ...output, code });
		};
		for (const name of ['stdout', 'stderr'] as const) {
			child[name].on('data', (data: Buffer) => {
				output[name] += data.toString();
				if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > maxBytes) {
					terminalError ??= new Error('EvidenceOutputLimit');
					killGroup();
				}
			});
		}
		child.on('error', (error) => { terminalError ??= error; finish(null); });
		child.on('exit', (code) => {
			killGroup();
			drainTimer = setTimeout(() => finish(code), 100);
		});
		child.on('close', (code) => finish(code));
		timer = setTimeout(() => {
			terminalError ??= new Error('EvidenceTimeout');
			killGroup();
			drainTimer = setTimeout(() => finish(null), 100);
		}, timeoutMs);
	});
}

export async function launchSupervised({
	argv, cwd, deadline, readOnly = [], writable = [], symlinks = [], env = {}, privateEnv = {},
	now = Date.now, maxBytes = 1048576,
	isolateNetwork = false,
}: SupervisedLaunch): Promise<OwnedResult> {
	const remaining = deadline - now();
	if (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 5400000
		|| !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !readOnly.length
		|| typeof isolateNetwork !== 'boolean') fail('invalid launcher deadline/closure');
	if (!Array.isArray(argv) || !argv.length || !path.isAbsolute(argv[0] as string)
		|| argv.some((part) => typeof part !== 'string' || part.includes('\0'))
		|| !path.isAbsolute(cwd)) fail('invalid supervised command');
	if (!privateEnv || typeof privateEnv !== 'object' || Array.isArray(privateEnv)
		|| Object.entries(privateEnv).some(([key, value]) =>
			!/^[A-Z][A-Z_0-9]*_(API_KEY|API_TOKEN|AUTH_TOKEN|BEARER_TOKEN|BROKER_TOKEN)$/.test(key)
			|| typeof value !== 'string' || !value || value.includes('\0')
			|| Buffer.byteLength(value) > 65536 || Object.hasOwn(env, key))) fail('invalid private environment');
	const args = ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-ipc',
		'--unshare-uts', '--die-with-parent', '--new-session', '--tmpfs', '/'];
	if (isolateNetwork) args.push('--unshare-net');
	const destinations = new Set();
	for (const link of symlinks) {
		if (!link || typeof link.target !== 'string' || !link.target || link.target.includes('\0')
			|| !path.isAbsolute(link.destination) || path.resolve(link.destination) !== link.destination
			|| link.destination === '/' || destinations.has(link.destination)
			|| ['/proc', '/dev', '/tmp'].some((prefix) =>
				link.destination === prefix || link.destination.startsWith(`${prefix}/`))) fail('unsafe launcher symlink');
		destinations.add(link.destination);
		args.push('--symlink', link.target, link.destination);
	}
	const mountSets: [string, readonly SandboxMount[]][] = [['--ro-bind', readOnly], ['--bind', writable]];
	for (const [mode, mounts] of mountSets) {
		for (const mount of mounts) {
			if (!mount || !path.isAbsolute(mount.source) || !path.isAbsolute(mount.destination)
				|| mount.source === '/' || mount.destination === '/'
				|| path.resolve(mount.source) !== mount.source || path.resolve(mount.destination) !== mount.destination
				|| fs.realpathSync(mount.source) !== mount.source || destinations.has(mount.destination)
				|| ['/proc', '/dev', '/tmp'].some((prefix) =>
					mount.destination === prefix || mount.destination.startsWith(`${prefix}/`))) fail('unsafe launcher mount');
			destinations.add(mount.destination);
			args.push(mode, mount.source, mount.destination);
		}
	}
	args.push('--proc', '/proc', '--dev', '/dev', '--size', String(16 * 1024 * 1024), '--tmpfs', '/dev/shm',
		'--remount-ro', '/dev', '--size', String(128 * 1024 * 1024), '--tmpfs', '/tmp',
		'--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp',
		'--setenv', 'PATH', '/nonexistent', '--setenv', 'LANG', 'C.UTF-8');
	for (const [key, value] of Object.entries(env)) {
		if (!/^[A-Z_][A-Z_0-9]*$/.test(key) || typeof value !== 'string' || value.includes('\0')
			|| /SECRET|PASSWORD|TOKEN|API_KEY|CREDENTIAL|AUTHORIZATION|COOKIE/.test(key)) fail('invalid launcher environment');
		args.push('--setenv', key, value);
	}
	args.push('--chdir', cwd, '--remount-ro', '/', '--', ...argv);
	const timeoutMs = Math.min(remaining, deadline - now());
	if (timeoutMs <= 0) fail('launcher deadline elapsed during preparation');
	return executeOwned(args, { timeoutMs, maxBytes, env: privateEnv });
}
