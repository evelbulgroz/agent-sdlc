import fs from 'node:fs';
import path from 'node:path';
import { fail, relativePath } from './primitives.mjs';

// A bind source must be a repository-relative name whose real path stays under its base directory.
function containedSource(base, name) {
	const source = path.join(base, relativePath(name));
	if (!fs.existsSync(source)) return null;
	const realBase = fs.realpathSync(base);
	const real = fs.realpathSync(source);
	if (!real.startsWith(`${realBase}${path.sep}`)) fail(`bind escapes its base: ${name}`);
	return source;
}

// `command` adds what a host command needs: a /bin link into the closure, a fixed PATH, single-file binaries,
// a package cwd, and the report directory mounted at /report. Everything else stays as for adapters.
function commandMounts(args, root, { binaries = [], report, cwd }) {
	args.push('--symlink', 'usr/bin', '/bin');
	for (const { source, destination } of binaries) {
		if (!path.isAbsolute(source) || !path.isAbsolute(destination) || path.resolve(destination) !== destination
			|| ['/proc', '/dev', '/tmp', '/report'].some((prefix) => destination === prefix || destination.startsWith(`${prefix}/`))
			|| !fs.statSync(source).isFile()) fail(`unsafe command binary: ${destination}`);
		args.push('--ro-bind', source, destination);
	}
	if (report) {
		if (!path.isAbsolute(report) || fs.realpathSync(report) !== report) fail('unsafe report directory');
		args.push('--bind', report, '/report');
	}
	if (cwd) {
		const source = path.join(root, relativePath(cwd));
		if (fs.realpathSync(source) !== source) fail('unsafe command cwd');
		args.push('--ro-bind', source, source);
	}
}

export const COMMAND_PATH = '/bin:/opt/sdlc/bin';

export function namespaceArgv(config, argv, { writable = [], readOnly = [], env = {}, command } = {}) {
	const resolved = fs.realpathSync(config.root);
	const directory = path.resolve(resolved, relativePath(config.runtime));
	const sysroot = path.join(directory, 'sysroot');
	const args = ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-ipc',
		'--unshare-uts', '--unshare-net', '--die-with-parent', '--new-session', '--tmpfs', '/'];
	for (const name of ['usr', 'lib64', 'etc', 'home']) {
		const source = path.join(sysroot, name);
		if (fs.existsSync(source)) args.push('--ro-bind', source, `/${name}`);
	}
	args.push('--ro-bind', path.join(sysroot, 'usr/lib'), '/lib',
		'--proc', '/proc', '--dev', '/dev', '--size', String(16 * 1024 * 1024), '--tmpfs', '/dev/shm',
		'--remount-ro', '/dev', '--size', String(128 * 1024 * 1024), '--tmpfs', '/tmp');
	if (command) commandMounts(args, resolved, command);
	// The pinned runtime (tool entries, browser binaries) is readable in every namespace, so a host needs no helpers mount.
	args.push('--ro-bind', directory, directory);
	if (config.helpers) {
		const helpers = path.join(resolved, relativePath(config.helpers));
		args.push('--ro-bind', helpers, helpers);
	}
	if (config.openApiPath) {
		const openapi = containedSource(resolved, config.openApiPath);
		if (openapi) args.push('--ro-bind', openapi, openapi);
	}
	const packageRoot = path.join(resolved, relativePath(config.packageRoot));
	for (const name of config.readOnlyBinds) {
		const source = containedSource(packageRoot, name);
		if (source) args.push('--ro-bind', source, source);
	}
	args.push('--ro-bind', path.join(directory, 'node_modules'), path.join(packageRoot, 'node_modules'));
	args.push('--ro-bind', path.join(resolved, 'package.json'), path.join(resolved, 'package.json'));
	for (const relative of [...writable, ...readOnly]) {
		relativePath(relative);
		if (!relative.startsWith(`${config.output}/`)) fail('writable namespace path outside owned output');
		const target = path.join(resolved, relative);
		if (!fs.statSync(target).isDirectory() || fs.realpathSync(target) !== target) fail('unsafe writable output');
		args.push(writable.includes(relative) ? '--bind' : '--ro-bind', target, target);
	}
	args.push('--remount-ro', '/', '--clearenv', '--setenv', 'HOME', '/tmp',
		'--setenv', 'TMPDIR', '/tmp', '--setenv', 'PATH', command ? COMMAND_PATH : '/nonexistent',
		'--setenv', 'LANG', 'C.UTF-8', '--chdir', command?.cwd ? path.join(resolved, command.cwd) : packageRoot);
	for (const [key, value] of Object.entries(env)) {
		if (!/^[A-Z_][A-Z_0-9]*$/.test(key) || typeof value !== 'string'
			|| /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/.test(key)) fail(`unsafe namespace environment: ${key}`);
		args.push('--setenv', key, value);
	}
	if (!Array.isArray(argv) || !path.isAbsolute(argv[0])) fail('non-absolute namespace command');
	return [...args, '--', ...argv];
}
