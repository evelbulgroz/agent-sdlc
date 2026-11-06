import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, GIT_SHA, sha256 } from '../policy/contracts/primitives.ts';
import { assertEvidenceDirectory, hashEvidenceBytes, readEvidenceFile } from './evidence-files.ts';
import type { EvidenceSourceObservation } from './evidence-types.ts';

export type EvidenceGitCli = (
	command: string, args: readonly string[], options: Record<string, unknown>,
) => string | Buffer;

export interface FrozenEvidencePreparation {
	/** Authorized hydration recipe, executable versions, environment and permitted output declaration. */
	configuration: Readonly<Record<string, unknown>>;
	/** Complete contained regular-file runtime/dependency/configuration inputs and their approved hashes. */
	files: readonly { path: string; sha256: string }[];
}

export interface EvidenceSourceOptions {
	worktreeDir: string;
	/** Frozen baseline tree; generated entries retain their baseline contents in the observed tree. */
	sourceTreeSha: string;
	/** Exact repository-relative files or directory prefixes, never globs or implicit housekeeping. */
	generatedOutputs: readonly string[];
	preparation: FrozenEvidencePreparation;
	gitCli?: EvidenceGitCli;
}

function assertRelative(value: string): void {
	if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') ||
		path.isAbsolute(value) ||
		value.split('/').some((part) => !part || part === '.' || part === '..')) {
		throw new Error('invalid-evidence-source-path');
	}
}

function within(relative: string, prefix: string): boolean {
	return relative === prefix || relative.startsWith(`${prefix}/`);
}

function assertRealParents(root: string, relative: string): void {
	let current = root;
	for (const segment of relative.split('/').slice(0, -1)) {
		current = path.join(current, segment);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('nonregular-evidence-source');
	}
}

/** Source-only tree capture never changes the real index or worktree. */
export function createEvidenceSourceObserver(options: EvidenceSourceOptions): () => Promise<EvidenceSourceObservation> {
	if (!options || !GIT_SHA.test(options.sourceTreeSha) || !Array.isArray(options.generatedOutputs) ||
		!options.preparation || !options.preparation.configuration || !Array.isArray(options.preparation.files)) {
		throw new Error('invalid-evidence-source-options');
	}
	assertEvidenceDirectory(options.worktreeDir);
	const worktreeDir = options.worktreeDir;
	const sourceTreeSha = options.sourceTreeSha;
	const generatedOutputs = [...options.generatedOutputs];
	for (const output of generatedOutputs) {
		assertRelative(output);
		if (/[*?[]/.test(output)) throw new Error('invalid-evidence-source-path');
	}
	if (new Set(generatedOutputs).size !== generatedOutputs.length) throw new Error('duplicate-generated-output');
	const preparation = JSON.parse(canonicalJson(options.preparation)) as FrozenEvidencePreparation;
	for (const file of preparation.files) {
		assertRelative(file.path);
		if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('invalid-preparation-file-hash');
	}
	if (new Set(preparation.files.map((file) => file.path)).size !== preparation.files.length) {
		throw new Error('duplicate-preparation-input');
	}
	const gitCli = options.gitCli ?? execFileSync as EvidenceGitCli;
	const git = (args: readonly string[], env?: NodeJS.ProcessEnv): Buffer => {
		const result = gitCli('git', args, {
			cwd: worktreeDir, env: env ?? process.env, encoding: 'buffer',
			stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 16 * 1024 * 1024,
		});
		return Buffer.isBuffer(result) ? result : Buffer.from(result);
	};
	const writeBlob = (bytes: Buffer, env: NodeJS.ProcessEnv): string => {
		const blob = gitCli('git', ['hash-object', '-w', '--stdin'], {
			cwd: worktreeDir, env, input: bytes, encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1024,
		}).toString().trim();
		if (!GIT_SHA.test(blob)) throw new Error('invalid-source-blob');
		return blob;
	};
	// Same object id Git assigns without filters; the repository's object format follows the tree id length.
	const gitObjectId = (bytes: Buffer): string => crypto.createHash(sourceTreeSha.length === 64 ? 'sha256' : 'sha1')
		.update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
	const writeBlobs = (relatives: readonly string[], env: NodeJS.ProcessEnv): string[] => {
		if (relatives.length === 0) return [];
		// Newline-bearing paths cannot ride the line protocol; hash those individually from their own bytes.
		if (relatives.some((relative) => relative.includes('\n'))) {
			return relatives.map((relative) => writeBlob(readEvidenceFile(worktreeDir, relative, Number.MAX_SAFE_INTEGER), env));
		}
		const output = gitCli('git', ['hash-object', '-w', '--no-filters', '--stdin-paths'], {
			cwd: worktreeDir, env, input: `${relatives.join('\n')}\n`, encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 16 * 1024 * 1024,
		}).toString().split('\n').filter(Boolean);
		if (output.length !== relatives.length || output.some((blob) => !GIT_SHA.test(blob))) {
			throw new Error('invalid-source-blob');
		}
		return output;
	};
	return async () => {
		assertEvidenceDirectory(worktreeDir);
		const baselineSymlinks = new Map<string, string>();
		for (const entry of git(['ls-tree', '-r', '-z', sourceTreeSha]).toString('utf8').split('\0').filter(Boolean)) {
			const match = /^120000 blob ([0-9a-f]{40,64})\t(.+)$/s.exec(entry);
			if (match) baselineSymlinks.set(match[2], match[1]);
		}
		const gitDir = git(['rev-parse', '--absolute-git-dir']).toString('utf8').trim();
		assertEvidenceDirectory(gitDir);
		const index = path.join(gitDir, `sdlc-evidence-${crypto.randomUUID()}.index`);
		const env = { ...process.env, GIT_INDEX_FILE: index };
		try {
			git(['read-tree', sourceTreeSha], env);
			// Enumerate without `git add`: host clean filters must never execute here.
			const manifest = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], env);
			const actualTracked = git(['ls-files', '--cached', '-z']);
			const paths = [...new Set(Buffer.concat([manifest, actualTracked]).toString('utf8').split('\0').filter(Boolean))].sort();
			const files: { path: string; mode: string; sha256: string }[] = [];
			const entries: string[] = [];
			const regular: { relative: string; mode: string; oid: string }[] = [];
			for (const relative of paths) {
				if (generatedOutputs.some((output) => within(relative, output))) continue;
				assertRelative(relative);
				let stat: fs.Stats;
				try {
					stat = fs.lstatSync(path.join(worktreeDir, relative));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
					entries.push(`0 ${'0'.repeat(40)}\t${relative}\0`);
					continue;
				}
				const baselineLink = baselineSymlinks.get(relative);
				if (stat.isSymbolicLink() && baselineLink) {
					assertRealParents(worktreeDir, relative);
					const bytes = Buffer.from(fs.readlinkSync(path.join(worktreeDir, relative)), 'utf8');
					const blob = writeBlob(bytes, env);
					// Only a baseline symlink with its exact baseline target is evidence; new or retargeted links stay rejected.
					if (blob !== baselineLink) throw new Error('nonregular-evidence-source');
					files.push({ path: relative, mode: '120000', sha256: hashEvidenceBytes(bytes) });
					entries.push(`120000 ${blob}\t${relative}\0`);
					continue;
				}
				if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('nonregular-evidence-source');
				const mode = stat.mode & 0o111 ? '100755' : '100644';
				const bytes = readEvidenceFile(worktreeDir, relative, Number.MAX_SAFE_INTEGER);
				files.push({ path: relative, mode, sha256: hashEvidenceBytes(bytes) });
				// Bind the tree to exact bytes, independent of filters, autocrlf or stale stat caches.
				regular.push({ relative, mode, oid: gitObjectId(bytes) });
			}
			for (const [index, blob] of writeBlobs(regular.map((file) => file.relative), env).entries()) {
				const file = regular[index];
				// Git re-reads each file, so an id that differs from the hashed bytes means the file changed mid-observation.
				if (!file || blob !== file.oid) throw new Error('nonregular-evidence-source');
				entries.push(`${file.mode} ${blob}\t${file.relative}\0`);
			}
			gitCli('git', ['update-index', '-z', '--index-info'], {
				cwd: worktreeDir, env, input: entries.join(''), stdio: ['pipe', 'pipe', 'pipe'],
				timeout: 30000, maxBuffer: 1024,
			});
			const treeSha = git(['write-tree'], env).toString('utf8').trim();
			if (!GIT_SHA.test(treeSha)) throw new Error('invalid-source-tree');
			const preparationFiles = preparation.files.map((file) => {
				const actual = hashEvidenceBytes(readEvidenceFile(worktreeDir, file.path, Number.MAX_SAFE_INTEGER));
				if (actual !== file.sha256) throw new Error('frozen-preparation-input-changed');
				return { path: file.path, sha256: actual };
			});
			return {
				treeSha,
				sourceHash: sha256(files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
				preparationHash: sha256({
					sourceTreeSha, generatedOutputs, configuration: preparation.configuration, files: preparationFiles,
				}),
			};
		} finally {
			fs.rmSync(index, { force: true });
			fs.rmSync(`${index}.lock`, { force: true });
		}
	};
}
