import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createEvidenceSourceObserver } from './evidence-source.ts';
import { hashEvidenceBytes } from './evidence-files.ts';
import { defaultEvidenceSpawn } from './evidence-runtime.ts';
import { spawnEvidence } from './evidence-transport.ts';

async function fixture(fn) {
	const root = path.resolve(`.evidence-source-fixture-${crypto.randomUUID()}`);
	fs.mkdirSync(root);
	const git = (args, options = {}) => execFileSync('git', args, {
		cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options,
	});
	git(['init', '--quiet']);
	fs.mkdirSync(path.join(root, 'src'));
	fs.mkdirSync(path.join(root, 'generated'));
	fs.writeFileSync(path.join(root, 'src/code.ts'), 'export const value = 1;\r\n');
	fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
	fs.writeFileSync(path.join(root, 'generated/built.js'), 'old generated\n');
	fs.writeFileSync(path.join(root, 'runtime.json'), '{"runtime":"node-22"}\n');
	git(['add', '.']);
	const sourceTreeSha = git(['write-tree']).trim();
	const preparation = {
		configuration: { runtime: process.version, argv: ['node'], hydration: 'frozen', permittedOutputs: ['generated'] },
		files: [{ path: 'runtime.json', sha256: hashEvidenceBytes(fs.readFileSync(path.join(root, 'runtime.json'))) }],
	};
	const options = { worktreeDir: root, sourceTreeSha, generatedOutputs: ['generated'], preparation };
	try { await fn({ root, git, sourceTreeSha, preparation, options }); }
	finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('captures exact raw source bytes in actual Git tree without changing the real index', async () => {
	await fixture(async (f) => {
		f.git(['config', 'core.autocrlf', 'true']);
		const beforeIndex = fs.readFileSync(path.join(f.root, '.git/index'));
		const observer = createEvidenceSourceObserver(f.options);
		const first = await observer();
		assert.equal(f.git(['cat-file', 'blob', `${first.treeSha}:src/code.ts`]), 'export const value = 1;\r\n');
		assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), beforeIndex);
		assert.deepEqual(await observer(), first);
		fs.writeFileSync(path.join(f.root, 'src/code.ts'), 'export const value = 1;\n');
		const second = await observer();
		assert.notEqual(second.treeSha, first.treeSha);
		assert.notEqual(second.sourceHash, first.sourceHash);
		assert.equal(second.preparationHash, first.preparationHash);
		assert.equal(f.git(['cat-file', 'blob', `${second.treeSha}:src/code.ts`]), 'export const value = 1;\n');
		assert.deepEqual(fs.readFileSync(path.join(f.root, '.git/index')), beforeIndex);
		assert.equal(fs.readdirSync(path.join(f.root, '.git')).some((name) => name.startsWith('sdlc-evidence-')), false);
	});
});

test('captures nonignored untracked source anywhere, deletion and rename without broad housekeeping skips', async () => {
	await fixture(async (f) => {
		const observer = createEvidenceSourceObserver(f.options);
		const first = await observer();
		fs.mkdirSync(path.join(f.root, '.agents'));
		fs.writeFileSync(path.join(f.root, '.agents/hidden.ts'), 'new source\n');
		fs.writeFileSync(path.join(f.root, 'build.tsbuildinfo'), 'not implicitly generated\n');
		const second = await observer();
		assert.notEqual(second.sourceHash, first.sourceHash);
		assert.match(f.git(['ls-tree', '-r', '--name-only', second.treeSha]), /\.agents\/hidden.ts/);
		assert.match(f.git(['ls-tree', '-r', '--name-only', second.treeSha]), /build.tsbuildinfo/);
		fs.renameSync(path.join(f.root, 'src/code.ts'), path.join(f.root, 'src/renamed.ts'));
		const third = await observer();
		assert.notEqual(third.treeSha, second.treeSha);
		const names = f.git(['ls-tree', '-r', '--name-only', third.treeSha]);
		assert.doesNotMatch(names, /src\/code.ts/);
		assert.match(names, /src\/renamed.ts/);
	});
});

test('only explicit generated prefixes and Git-ignored untracked files may vary without source invalidation', async () => {
	await fixture(async (f) => {
		const observer = createEvidenceSourceObserver(f.options);
		const first = await observer();
		fs.writeFileSync(path.join(f.root, 'generated/built.js'), 'new generated\n');
		fs.writeFileSync(path.join(f.root, 'generated/new.js'), 'another output\n');
		fs.mkdirSync(path.join(f.root, 'ignored'));
		fs.writeFileSync(path.join(f.root, 'ignored/cache.bin'), 'ignored\n');
		assert.deepEqual(await observer(), first);
		assert.equal(f.git(['cat-file', 'blob', `${first.treeSha}:generated/built.js`]), 'old generated\n');
		fs.writeFileSync(path.join(f.root, 'generated-other.js'), 'must be source\n');
		assert.notEqual((await observer()).sourceHash, first.sourceHash);
	});
});

test('tracked ignored files are still bound and an empty generated list excludes nothing', async () => {
	await fixture(async (f) => {
		f.options.generatedOutputs = [];
		fs.appendFileSync(path.join(f.root, '.gitignore'), 'generated/\n');
		const observer = createEvidenceSourceObserver(f.options);
		const first = await observer();
		fs.writeFileSync(path.join(f.root, 'generated/built.js'), 'changed\n');
		assert.notEqual((await observer()).sourceHash, first.sourceHash);
	});
});

test('never executes host clean filters or trusts a filemode-disabled real index', async () => {
	await fixture(async (f) => {
		fs.writeFileSync(path.join(f.root, '.gitattributes'), '*.ts filter=unapproved\n');
		f.git(['config', 'filter.unapproved.clean', 'false']);
		f.git(['config', 'filter.unapproved.required', 'true']);
		f.git(['config', 'core.filemode', 'false']);
		const observer = createEvidenceSourceObserver(f.options);
		const first = await observer();
		fs.chmodSync(path.join(f.root, 'src/code.ts'), 0o755);
		const second = await observer();
		assert.notEqual(second.sourceHash, first.sourceHash);
		assert.notEqual(second.treeSha, first.treeSha);
		assert.match(f.git(['ls-tree', second.treeSha, 'src/code.ts']), /^100755 /);
	});
});

test('preparation provenance is independently frozen and byte-checked on every observation', async () => {
	await fixture(async (f) => {
		const observer = createEvidenceSourceObserver(f.options);
		const first = await observer();
		f.preparation.configuration.runtime = 'mutated caller object';
		assert.equal((await observer()).preparationHash, first.preparationHash);
		const different = createEvidenceSourceObserver(f.options);
		assert.notEqual((await different()).preparationHash, first.preparationHash);
		fs.appendFileSync(path.join(f.root, 'runtime.json'), ' ');
		await assert.rejects(observer(), /frozen-preparation-input-changed/);
	});
});

test('rejects source symlinks, symlinked preparation inputs and unsupported Git links', async () => {
	await fixture(async (f) => {
		const observer = createEvidenceSourceObserver(f.options);
		fs.symlinkSync('src/code.ts', path.join(f.root, 'link.ts'));
		await assert.rejects(observer(), /nonregular-evidence-source/);
		fs.unlinkSync(path.join(f.root, 'link.ts'));
		fs.unlinkSync(path.join(f.root, 'runtime.json'));
		fs.symlinkSync('src/code.ts', path.join(f.root, 'runtime.json'));
		await assert.rejects(observer(), /nonregular-evidence-source|unsafe-file-path/);
	});
});

test('validates nil, empty and traversal configuration and cleans failed index captures', async () => {
	for (const options of [null, {}, { sourceTreeSha: null }, { sourceTreeSha: '' }]) {
		assert.throws(() => createEvidenceSourceObserver(options), /invalid-evidence-source-options/);
	}
	await fixture(async (f) => {
		for (const generatedOutputs of [null, [''], ['../source'], ['src/*'], ['.'], ['generated', 'generated']]) {
			assert.throws(() => createEvidenceSourceObserver({ ...f.options, generatedOutputs }));
		}
		const observer = createEvidenceSourceObserver({
			...f.options,
			gitCli(command, args, options) {
				if (args[0] === 'write-tree') throw new Error('injected-git-failure');
				return execFileSync(command, args, options);
			},
		});
		await assert.rejects(observer(), /injected-git-failure/);
		assert.equal(fs.readdirSync(path.join(f.root, '.git')).some((name) => name.startsWith('sdlc-evidence-')), false);
	});
});

test('default runtime spawn is asynchronous with stdin report transport, never an execCli wrapper', async () => {
	const result = await spawnEvidence(defaultEvidenceSpawn,
		[process.execPath, '-e', 'let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(input))));'],
		process.cwd(), Buffer.from('{"schemaVersion":"1.0.0"}'), { timeoutMs: 2000, maxReportBytes: 1024 }, {}, 0);
	assert.equal(result.exitCode, 0);
	assert.equal(result.failureReason, null);
	assert.equal(result.stdout.toString(), '{"schemaVersion":"1.0.0"}');
});
