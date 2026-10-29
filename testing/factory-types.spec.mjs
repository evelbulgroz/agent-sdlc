import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { listBoundedPlanningFiles } from '../policy/canary-planning-files.ts';
import { currentCanaryBindings } from '../policy/reliability/canary.ts';

const FACTORY_ROOT = fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/engine'))
	? path.join(REPOSITORY_ROOT, 'packages/engine')
	: REPOSITORY_ROOT;
const MODEL_USAGE_ROOT = path.join(REPOSITORY_ROOT, 'packages/model-usage');

const CAPABILITY_AND_SCRIPT_FOLDERS = Object.freeze([
	'adapters',
	'cli',
	'execution',
	'persistence',
	'policy',
	'review',
	'roles',
	'scripts',
	'workflow',
]);

function walkFiles(dir, predicate) {
	const results = [];
	const walk = (current) => {
		if (!fs.existsSync(current)) return;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
				walk(full);
				continue;
			}
			if (entry.isFile() && predicate(full, entry.name)) {
				results.push(full);
			}
		}
	};
	walk(dir);
	return results.sort();
}

function collectSpecifierStrings(tsFilePath) {
	const source = fs.readFileSync(tsFilePath, 'utf8');
	const sourceFile = ts.createSourceFile(
		tsFilePath,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const specifiers = [];
	const visit = (node) => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			specifiers.push(node.moduleSpecifier.text);
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length > 0 &&
			ts.isStringLiteral(node.arguments[0])
		) {
			specifiers.push(node.arguments[0].text);
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return specifiers;
}

test('@ac AC-05 @case AC-05.1 cli/cli.ts exists, cli/cli.mjs is absent, and every production module in the eight capability folders and scripts/ is .ts with .spec.mjs remaining JavaScript', () => {
	assert.equal(fs.existsSync(path.join(FACTORY_ROOT, 'cli/cli.ts')), true);
	assert.equal(fs.existsSync(path.join(FACTORY_ROOT, 'cli/cli.mjs')), false);

	for (const folder of CAPABILITY_AND_SCRIPT_FOLDERS) {
		const folderPath = path.join(FACTORY_ROOT, folder);
		const tsFiles = walkFiles(
			folderPath,
			(_full, name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
		);
		assert.ok(tsFiles.length > 0, `expected .ts production modules in ${folder}/`);

		const nonSpecMjsFiles = walkFiles(
			folderPath,
			(_full, name) => name.endsWith('.mjs') && !name.endsWith('.spec.mjs'),
		);
		assert.deepEqual(
			nonSpecMjsFiles.map((f) => path.relative(REPOSITORY_ROOT, f)),
			[],
			`expected no production .mjs shims in ${folder}/`,
		);

		const specTsFiles = walkFiles(folderPath, (_full, name) => name.endsWith('.spec.ts'));
		assert.deepEqual(specTsFiles, [], `expected no .spec.ts files in ${folder}/`);
	}
});

test('@ac AC-05 @case AC-05.2 agent-sdlc help exits 0 and prints usage text', () => {
	const result = spawnSync(process.execPath, [path.join(FACTORY_ROOT, 'cli/cli.ts'), 'help'], {
		cwd: REPOSITORY_ROOT,
		encoding: 'utf8',
		timeout: 30_000,
	});
	const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
	assert.equal(result.status, 0, output);
	assert.match(output, /Usage:\s*agent-sdlc <command> \[options\]/);
});

test('@ac AC-05 @case AC-05.3 every boundedPlanningFiles path ends in .ts and canary-qualification.json is not mutated', () => {
	const qualificationPath = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc/canary-qualification.json',
	);
	const beforeBytes = fs.existsSync(qualificationPath)
		? fs.readFileSync(qualificationPath, 'utf8')
		: null;

	const bounded = listBoundedPlanningFiles(REPOSITORY_ROOT);
	assert.ok(bounded.length > 0);
	for (const relPath of bounded) {
		assert.equal(
			relPath.endsWith('.ts'),
			true,
			`expected bounded planning file to end with .ts: ${relPath}`,
		);
		assert.equal(
			fs.existsSync(path.join(REPOSITORY_ROOT, relPath.replace(/^packages\/engine\//, ''))),
			true,
			`missing bounded planning file: ${relPath}`,
		);
	}

	const bindings = currentCanaryBindings(REPOSITORY_ROOT);
	assert.match(bindings.boundedPlanningHash, /^[a-f0-9]{64}$/);

	const afterBytes = fs.existsSync(qualificationPath)
		? fs.readFileSync(qualificationPath, 'utf8')
		: null;
	assert.equal(afterBytes, beforeBytes);
});

test('@ac AC-05 @case AC-05.4 tsconfig sets allowJs to false and pnpm run typecheck exits 0', () => {
	const tsconfigPaths = fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/engine/tsconfig.json'))
		? ['packages/engine/tsconfig.json', 'packages/model-usage/tsconfig.json'].filter((p) =>
				fs.existsSync(path.join(REPOSITORY_ROOT, p)),
			)
		: ['tsconfig.json'];
	for (const rel of tsconfigPaths) {
		const tsconfig = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, rel), 'utf8'));
		assert.equal(tsconfig.compilerOptions?.allowJs, false, rel);
	}

	const typecheck = spawnSync('pnpm', ['run', 'typecheck'], {
		cwd: REPOSITORY_ROOT,
		encoding: 'utf8',
		timeout: 60_000,
	});
	const output = `${typecheck.stdout ?? ''}\n${resultOutput(typecheck)}`;
	assert.equal(typecheck.status, 0, output);
});

function resultOutput(res) {
	return `${res.stderr ?? ''}`;
}

test('@ac AC-05 @case AC-05.5 no factory .ts file imports any .mjs path and every relative import ends in .ts', () => {
	const allTsFiles = [
		...walkFiles(FACTORY_ROOT, (_full, name) => name.endsWith('.ts')),
		...(fs.existsSync(MODEL_USAGE_ROOT)
			? walkFiles(MODEL_USAGE_ROOT, (_full, name) => name.endsWith('.ts'))
			: []),
	];
	for (const tsFile of allTsFiles) {
		const relTs = path.relative(REPOSITORY_ROOT, tsFile).split(path.sep).join('/');
		for (const specifier of collectSpecifierStrings(tsFile)) {
			if (!specifier.startsWith('.')) continue;
			assert.equal(
				specifier.endsWith('.mjs'),
				false,
				`${relTs} must not import .mjs module '${specifier}'`,
			);
			assert.equal(
				specifier.endsWith('.ts'),
				true,
				`${relTs} relative factory import '${specifier}' must end in .ts`,
			);
		}
	}
});
