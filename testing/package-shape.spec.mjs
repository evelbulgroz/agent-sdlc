import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const PACKAGE_ROOT = fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/engine'))
	? path.join(REPOSITORY_ROOT, 'packages/engine')
	: REPOSITORY_ROOT;
const MODEL_USAGE_ROOT = path.join(REPOSITORY_ROOT, 'packages/model-usage');

function readPackageJson() {
	return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
}

test('@ac AC-01 @case AC-01.1 @ac AC-03 @case AC-03.1 package.json build emits dist/ and bin declares all five CLI entrypoints with shebangs', () => {
	const buildRes = spawnSync('pnpm', ['run', 'build'], {
		cwd: PACKAGE_ROOT,
		encoding: 'utf8',
		timeout: 60_000,
	});
	assert.equal(buildRes.status, 0, `${buildRes.stdout ?? ''}\n${buildRes.stderr ?? ''}`);

	const pkg = readPackageJson();
	assert.deepEqual(pkg.bin, {
		'agent-sdlc': './dist/cli/cli.js',
		'agent-review': './dist/review/agent-review.js',
		'agent-sdlc-trace': './dist/scripts/trace-summary.js',
		'agent-sdlc-trends': './dist/scripts/aggregate-critic-trends.js',
		'agent-sdlc-auto-prune': './dist/cli/auto-prune.js',
	});
	for (const [, relPath] of Object.entries(pkg.bin)) {
		const absPath = path.join(PACKAGE_ROOT, relPath);
		assert.equal(fs.existsSync(absPath), true, `Missing bin target: ${relPath}`);
		const firstLine = fs.readFileSync(absPath, 'utf8').split('\n')[0];
		assert.equal(firstLine, '#!/usr/bin/env node', `${relPath} must start with #!/usr/bin/env node`);
	}

	assert.equal(
		fs.existsSync(path.join(PACKAGE_ROOT, 'dist/roles/defaults/roles/implementer.json')),
		true,
	);
	assert.equal(
		fs.existsSync(path.join(PACKAGE_ROOT, 'dist/review/defaults/protocol/code.md')),
		true,
	);
	assert.equal(
		fs.existsSync(path.join(PACKAGE_ROOT, 'dist/review/defaults/philosophy/code.md')),
		true,
	);

	function walkDistJs(dir) {
		const results = [];
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) results.push(...walkDistJs(full));
			else if (entry.name.endsWith('.js')) results.push(full);
		}
		return results;
	}
	const distJs = walkDistJs(path.join(PACKAGE_ROOT, 'dist'));
	assert.ok(distJs.length > 0);
	for (const jsFile of distJs) {
		const src = fs.readFileSync(jsFile, 'utf8');
		assert.equal(
			/(?:from|import)\s+['"]\.[^'"]*\.ts['"]/.test(src),
			false,
			`${path.relative(PACKAGE_ROOT, jsFile)} still contains .ts relative specifier`,
		);
	}

	const res = spawnSync('pnpm', ['run', 'typecheck'], {
		cwd: PACKAGE_ROOT,
		encoding: 'utf8',
		timeout: 30_000,
	});
	assert.equal(res.status, 0, `${res.stdout ?? ''}\n${res.stderr ?? ''}`);
});

test('@ac AC-01 @case AC-01.2 package.json declares package-local scripts, build, conditional exports, and publishConfig', () => {
	const pkg = readPackageJson();
	assert.equal(pkg.name, '@evelbulgroz/agent-sdlc');
	assert.equal(pkg.version, '1.0.0');
	assert.equal(pkg.private, false);
	assert.equal(pkg.type, 'module');
	assert.deepEqual(pkg.files, ['dist', 'testing/reliability-corpus']);
	assert.deepEqual(pkg.publishConfig, { registry: 'https://npm.pkg.github.com/' });
	assert.deepEqual(pkg.exports, {
		'./agent-status-validate': {
			types: './dist/agent-status-validate.d.ts',
			default: './dist/agent-status-validate.js',
		},
		'./auto-prune': {
			types: './dist/cli/auto-prune.d.ts',
			default: './dist/cli/auto-prune.js',
		},
	});
	assert.equal(pkg.scripts?.sdlc, 'node ./cli/cli.ts');
	assert.equal(pkg.scripts?.review, 'node ./review/agent-review.ts');
	assert.equal(pkg.scripts?.trace, 'node ./scripts/trace-summary.ts');
	assert.equal(pkg.scripts?.trends, 'node ./scripts/aggregate-critic-trends.ts');
	assert.equal(pkg.scripts?.skills, 'node ./cli/cli.ts skills');
	assert.equal(pkg.scripts?.typecheck, 'tsc --noEmit -p tsconfig.json');
	assert.equal(pkg.scripts?.['test:unit'], "node --test --test-concurrency=1 '**/*.spec.mjs'");
	assert.equal(pkg.scripts?.['test:unit'].includes('cd ../..'), false);
	assert.equal(typeof pkg.scripts?.build, 'string');
	assert.equal(pkg.scripts?.test, undefined);
	assert.equal(pkg.dependencies?.['@evelbulgroz/model-usage-govenor'], '1.1.0');
	assert.equal(pkg.dependencies?.['@langchain/langgraph'], '1.4.13');
	assert.equal(pkg.dependencies?.['@langchain/langgraph-checkpoint'], '1.1.5');
	assert.equal(pkg.dependencies?.zod, '4.5.4');
});

test('@ac AC-02 @case AC-02.1 packages/engine CLI entrypoint help exits 0', () => {
	const res = spawnSync(process.execPath, [path.join(PACKAGE_ROOT, 'cli/cli.ts'), 'help'], {
		cwd: REPOSITORY_ROOT,
		encoding: 'utf8',
		timeout: 30_000,
	});
	assert.equal(res.status, 0, `${res.stdout ?? ''}\n${res.stderr ?? ''}`);
});

test('@ac AC-03 @case AC-03.2 dist/cli/cli.js help and dist/review/agent-review.js --help execute from a simulated node_modules directory without ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING', () => {
	const tempHost = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-nm-exec-'));
	const sdlcNm = path.join(tempHost, 'node_modules/@evelbulgroz/agent-sdlc');
	try {
		fs.mkdirSync(sdlcNm, { recursive: true });
		fs.copyFileSync(path.join(PACKAGE_ROOT, 'package.json'), path.join(sdlcNm, 'package.json'));
		fs.cpSync(path.join(PACKAGE_ROOT, 'dist'), path.join(sdlcNm, 'dist'), { recursive: true });
		fs.cpSync(
			path.join(PACKAGE_ROOT, 'testing/reliability-corpus'),
			path.join(sdlcNm, 'testing/reliability-corpus'),
			{ recursive: true },
		);

		const muDep = path.join(PACKAGE_ROOT, 'node_modules/@evelbulgroz/model-usage-govenor');
		if (fs.existsSync(muDep)) {
			fs.symlinkSync(muDep, path.join(tempHost, 'node_modules/@evelbulgroz/model-usage-govenor'), 'dir');
		}

		for (const dep of ['@langchain', '@swc', 'zod']) {
			const srcDep = path.join(REPOSITORY_ROOT, 'node_modules', dep);
			const pkgDep = path.join(PACKAGE_ROOT, 'node_modules', dep);
			const targetSource = fs.existsSync(pkgDep) ? pkgDep : srcDep;
			if (fs.existsSync(targetSource)) {
				fs.symlinkSync(targetSource, path.join(tempHost, 'node_modules', dep), 'dir');
			}
		}

		const cliRes = spawnSync(
			process.execPath,
			[path.join(sdlcNm, 'dist/cli/cli.js'), 'help'],
			{ cwd: tempHost, encoding: 'utf8', timeout: 30_000 },
		);
		assert.equal(cliRes.status, 0, `${cliRes.stdout ?? ''}\n${cliRes.stderr ?? ''}`);
		assert.match(cliRes.stdout, /Usage:/);

		const reviewRes = spawnSync(
			process.execPath,
			[path.join(sdlcNm, 'dist/review/agent-review.js'), '--help'],
			{ cwd: tempHost, encoding: 'utf8', timeout: 30_000 },
		);
		assert.equal(reviewRes.status, 0, `${reviewRes.stdout ?? ''}\n${reviewRes.stderr ?? ''}`);
	} finally {
		fs.rmSync(tempHost, { recursive: true, force: true });
	}
});
