import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { summarizeProbePath } from './erasable-probe.ts';

const IS_STANDALONE = !fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/agent-sdlc'));
const FACTORY_ROOT = IS_STANDALONE ? REPOSITORY_ROOT : path.join(REPOSITORY_ROOT, 'packages/agent-sdlc');
const MODEL_USAGE_ROOT = path.join(REPOSITORY_ROOT, 'packages/model-usage');
const TSCONFIG_PATH = path.join(FACTORY_ROOT, 'tsconfig.json');
const MODEL_USAGE_TSCONFIG_PATH = path.join(MODEL_USAGE_ROOT, 'tsconfig.json');
const PACKAGE_JSON_PATH = path.join(FACTORY_ROOT, 'package.json');
const MODEL_USAGE_PACKAGE_JSON_PATH = path.join(MODEL_USAGE_ROOT, 'package.json');
const TSC_BIN = path.join(FACTORY_ROOT, 'node_modules/.bin/tsc');

function runTsc(projectArg, cwd = FACTORY_ROOT) {
	return spawnSync(TSC_BIN, ['--noEmit', '-p', projectArg], {
		cwd,
		encoding: 'utf8',
		timeout: 60_000,
	});
}

function runTscInTempFixture(fileName, sourceText) {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-type-gate-'));
	try {
		fs.copyFileSync(PACKAGE_JSON_PATH, path.join(tempDir, 'package.json'));
		const baseConfig = JSON.parse(fs.readFileSync(TSCONFIG_PATH, 'utf8'));
		const fixtureConfig = {
			...baseConfig,
			compilerOptions: {
				...baseConfig.compilerOptions,
				typeRoots: [path.join(FACTORY_ROOT, 'node_modules/@types')],
			},
			include: [fileName],
		};
		fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), `${JSON.stringify(fixtureConfig, null, 2)}\n`);
		fs.writeFileSync(path.join(tempDir, fileName), sourceText);
		return runTsc(tempDir, FACTORY_ROOT);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

test('@ac AC-01 @case AC-01.1 pnpm --filter @evelbulgroz/agent-sdlc run typecheck exits 0 and runs the committed erasable probe', () => {
	assert.equal(process.features.typescript, 'strip');
	const summary = summarizeProbePath('tools//agent-sdlc/testing/erasable-probe.ts');
	assert.deepEqual(summary, {
		normalizedPath: 'tools/agent-sdlc/testing/erasable-probe.ts',
		segmentCount: 4,
	});
	const result = spawnSync(
		'pnpm',
		IS_STANDALONE ? ['run', 'typecheck'] : ['--filter', '@evelbulgroz/agent-sdlc', 'run', 'typecheck'],
		{
			cwd: FACTORY_ROOT,
			encoding: 'utf8',
			timeout: 60_000,
		},
	);
	const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
	assert.equal(result.status, 0, output);
});

test('@ac AC-01 @case AC-01.2 a temporary file that declares an enum fails tsc under erasableSyntaxOnly', () => {
	const result = runTscInTempFixture(
		'enum-fixture.ts',
		"export enum NonErasableKind {\n\tAlpha = 'alpha',\n}\n",
	);
	const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
	assert.notEqual(result.status, 0, output);
	assert.match(output, /TS1294/);
});

test('@ac AC-01 @case AC-01.3 a temporary file with an untyped function parameter fails tsc under strict mode', () => {
	const result = runTscInTempFixture(
		'implicit-any-fixture.ts',
		'export function echoUntyped(value) {\n\treturn value;\n}\n',
	);
	const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
	assert.notEqual(result.status, 0, output);
	assert.match(output, /TS7006/);
});

test('@ac AC-01 @case AC-01.4 both tsconfig files set strict, noImplicitOverride, noEmit, erasableSyntaxOnly, verbatimModuleSyntax, and allowJs false with checkJs false', () => {
	const configs = [TSCONFIG_PATH];
	if (!IS_STANDALONE && fs.existsSync(MODEL_USAGE_TSCONFIG_PATH)) {
		configs.push(MODEL_USAGE_TSCONFIG_PATH);
	}
	for (const configPath of configs) {
		const tsconfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
		const options = tsconfig.compilerOptions ?? {};
		assert.equal(options.strict, true, configPath);
		assert.equal(options.noImplicitOverride, true, configPath);
		assert.equal(options.noEmit, true, configPath);
		assert.equal(options.erasableSyntaxOnly, true, configPath);
		assert.equal(options.verbatimModuleSyntax, true, configPath);
		assert.equal(options.allowJs, false, configPath);
		assert.equal(options.checkJs, false, configPath);
		assert.equal(options.module, 'NodeNext', configPath);
		assert.equal(options.moduleResolution, 'NodeNext', configPath);
		assert.equal(options.allowImportingTsExtensions, true, configPath);
		assert.deepEqual(options.types, ['node'], configPath);
		assert.deepEqual(tsconfig.include, ['**/*.ts'], configPath);
	}
});

test('@ac AC-01 @case AC-01.5 both package.json files set type to module and packages/agent-sdlc defines scripts.typecheck', () => {
	const pkgPaths = [PACKAGE_JSON_PATH];
	if (!IS_STANDALONE && fs.existsSync(MODEL_USAGE_PACKAGE_JSON_PATH)) {
		pkgPaths.push(MODEL_USAGE_PACKAGE_JSON_PATH);
	}
	for (const pkgPath of pkgPaths) {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
		assert.equal(pkg.type, 'module', pkgPath);
	}
	const sdlcPkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
	assert.equal(sdlcPkg.scripts?.typecheck, 'tsc --noEmit -p tsconfig.json');
	assert.equal(process.features.typescript, 'strip');
});
