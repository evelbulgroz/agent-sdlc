// Shared fixture: a two-package workspace whose consumer imports the compiled base entrypoint.
// Builds really compile src → dist; only the allowlisted `pnpm --filter <pkg> build` argv is mapped
// to the package's own build script, so consumers observe real compiled behavior.
import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSyntheticHostProfile } from './cli-test-support.ts';

export const COMPILE = `import fs from 'node:fs';
const src = fs.readFileSync('src/index.mjs', 'utf8');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.mjs', '// compiled\\n' + src);
`;
export const BUILDS = [
	{ id: 'build-base', targetPackages: ['packages/consumer'], packagePath: 'packages/base', argv: ['pnpm', '--filter', '@fx/base', 'build'], outputPathPrefixes: ['dist'] },
	{ id: 'build-consumer', targetPackages: ['packages/consumer'], packagePath: 'packages/consumer', argv: ['pnpm', '--filter', '@fx/consumer', 'build'], outputPathPrefixes: ['dist'], dependsOn: ['build-base'] },
];
export const TASKS = [{ taskId: 'task-1', targetPackage: 'packages/consumer' }];

export function writeFile(root: string, rel: string, text: string): void {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), text);
}

/** Two-package workspace whose consumer test imports the compiled base entrypoint. Base dist starts stale. */
/** Runs `fn(root)`; cleanup waits for a returned promise so async callbacks keep their fixture. */
export function withFixture<T>(fn: (root: string) => T, { builds = BUILDS }: { builds?: typeof BUILDS | null } = {}): T | Promise<Awaited<T>> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-prep-exec-'));
	const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
	let result: T;
	try {
		for (const name of ['base', 'consumer']) {
			writeFile(root, `packages/${name}/package.json`, JSON.stringify({ name: `@fx/${name}`, scripts: { build: 'node build.mjs', test: 'node test.mjs' } }));
			writeFile(root, `packages/${name}/build.mjs`, COMPILE);
		}
		writeFile(root, 'packages/base/src/index.mjs', "export const greet = () => 'old';\n");
		writeFile(root, 'packages/consumer/src/index.mjs', "export { greet } from '../../base/dist/index.mjs';\n");
		writeFile(root, 'packages/consumer/test.mjs', "import { greet } from '../base/dist/index.mjs';\nif (greet() !== process.env.EXPECT) { console.error('saw ' + greet()); process.exit(1); }\n");
		execFileSync('node', ['build.mjs'], { cwd: path.join(root, 'packages/base') });
		writeSyntheticHostProfile(root, builds ? { verificationPreparation: { builds } } : {});
		result = fn(root);
	} catch (error) {
		cleanup();
		throw error;
	}
	if (result instanceof Promise) return result.finally(cleanup) as Promise<Awaited<T>>;
	cleanup();
	return result;
}

/** Real process runner; maps the allowlisted `pnpm --filter <pkg> build` argv to that package's build script. */
export function packageRunner(root: string, calls: string[] = []) {
	return (cmd: string, args: string[], options?: ExecFileSyncOptions) => {
		calls.push([cmd, ...args].join(' '));
		const pkg = (args[1] ?? '').replace('@fx/', '');
		return execFileSync('node', ['build.mjs'], { ...options, cwd: path.join(root, 'packages', pkg) });
	};
}

export function consumerSees(root: string, expected: string): boolean {
	try {
		execFileSync('node', ['test.mjs'], { cwd: path.join(root, 'packages/consumer'), env: { ...process.env, EXPECT: expected }, stdio: 'pipe' });
		return true;
	} catch {
		return false;
	}
}
