import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const AGENT_SDLC_ROOT = fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/agent-sdlc'))
	? path.join(REPOSITORY_ROOT, 'packages/agent-sdlc')
	: REPOSITORY_ROOT;
const MODEL_USAGE_ROOT = path.join(REPOSITORY_ROOT, 'packages/model-usage');
const IS_MONOREPO = fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/agent-sdlc'));
const LEARN_FILENAME = `${'learn'}.${'mjs'}`;

function walkCodeFiles(dir) {
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
			if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs'))) {
				results.push(full);
			}
		}
	};
	walk(dir);
	return results.sort();
}

function collectSpecifiers(filePath) {
	const source = fs.readFileSync(filePath, 'utf8');
	const sourceFile = ts.createSourceFile(
		filePath,
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
			specifiers.push({ text: node.moduleSpecifier.text, dynamic: false });
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length > 0 &&
			ts.isStringLiteral(node.arguments[0])
		) {
			specifiers.push({ text: node.arguments[0].text, dynamic: true });
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return specifiers;
}

test('@ac AC-03 @case AC-03.1 no file under agent-sdlc resolves an import outside its package root', () => {
	const allowedOutsideRel = 'packages/agent-sdlc/host/legacy-learnings.ts';
	const expectedDynamicTarget = path
		.resolve(REPOSITORY_ROOT, `tools/lib/${LEARN_FILENAME}`)
		.split(path.sep)
		.join('/');

	const roots = [AGENT_SDLC_ROOT, MODEL_USAGE_ROOT].filter((r) => fs.existsSync(r));
	for (const pkgRoot of roots) {
		const pkgPrefix = `${pkgRoot.split(path.sep).join('/')}/`;
		for (const file of walkCodeFiles(pkgRoot)) {
			const relFile = path.relative(REPOSITORY_ROOT, file).split(path.sep).join('/');
			for (const { text, dynamic } of collectSpecifiers(file)) {
				if (!text.startsWith('.')) continue;
				const resolved = path.resolve(path.dirname(file), text).split(path.sep).join('/');
				if (!resolved.startsWith(pkgPrefix)) {
					if (IS_MONOREPO) {
						assert.equal(
							relFile === allowedOutsideRel && dynamic && resolved === expectedDynamicTarget,
							true,
							`Disallowed cross-boundary relative import in ${relFile}: '${text}' -> '${resolved}'`,
						);
					} else {
						assert.fail(
							`Disallowed cross-boundary relative import in ${relFile}: '${text}' -> '${resolved}'`,
						);
					}
				}
			}
		}
	}
});

test('@ac AC-03 @case AC-03.2 searching agent-sdlc for legacy learnings module filename', () => {
	const matches = [];
	const roots = [AGENT_SDLC_ROOT, MODEL_USAGE_ROOT].filter((r) => fs.existsSync(r));
	for (const pkgRoot of roots) {
		for (const file of walkCodeFiles(pkgRoot)) {
			const content = fs.readFileSync(file, 'utf8');
			if (content.includes(LEARN_FILENAME)) {
				matches.push(path.relative(REPOSITORY_ROOT, file).split(path.sep).join('/'));
			}
		}
	}
	if (IS_MONOREPO) {
		assert.deepEqual(matches, ['packages/agent-sdlc/host/legacy-learnings.ts']);
	} else {
		assert.deepEqual(matches, []);
	}

	const scriptContent = fs.readFileSync(path.join(AGENT_SDLC_ROOT, 'host/script.ts'), 'utf8');
	assert.equal(scriptContent.includes(LEARN_FILENAME), false);
});

test('@ac AC-03 @case AC-03.3 importing cli/cli.ts succeeds in a subprocess when the learnings module is shadowed or absent', () => {
	const loaderCode = [
		`const blocked = ${JSON.stringify(LEARN_FILENAME)};`,
		'export async function resolve(specifier, context, nextResolve) {',
		'  if (specifier.endsWith(blocked)) {',
		'    throw new Error("Blocked learnings module during import test");',
		'  }',
		'  return nextResolve(specifier, context);',
		'}',
	].join('\n');
	const loaderDataUrl = `data:text/javascript;base64,${Buffer.from(loaderCode, 'utf8').toString('base64')}`;
	const cliRel = IS_MONOREPO ? './packages/agent-sdlc/cli/cli.ts' : './cli/cli.ts';
	const evalScript = [
		'import { register } from "node:module";',
		`register(${JSON.stringify(loaderDataUrl)});`,
		`await import(${JSON.stringify(cliRel)});`,
		'console.log(JSON.stringify({ loaded: true }));',
	].join('\n');

	const result = spawnSync(process.execPath, ['--input-type=module', '-e', evalScript], {
		cwd: REPOSITORY_ROOT,
		encoding: 'utf8',
		timeout: 30_000,
	});
	const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
	assert.equal(result.status, 0, output);
	const parsed = JSON.parse((result.stdout ?? '').trim());
	assert.deepEqual(parsed, { loaded: true });
});

test('@ac AC-03 @case AC-03.4 neither packages/agent-sdlc nor packages/model-usage imports from @langchain/core/runnables', () => {
	const roots = [AGENT_SDLC_ROOT, MODEL_USAGE_ROOT].filter((r) => fs.existsSync(r));
	for (const pkgRoot of roots) {
		for (const file of walkCodeFiles(pkgRoot)) {
			const relFile = path.relative(REPOSITORY_ROOT, file).split(path.sep).join('/');
			for (const { text } of collectSpecifiers(file)) {
				assert.notEqual(
					text,
					'@langchain/core/runnables',
					`${relFile} must not import @langchain/core/runnables`,
				);
			}
		}
	}
});

test('@ac AC-04 @case AC-04.1 @case AC-04.2 @case AC-04.3 @case AC-04.4 shared helpers live inside the packages', () => {
	if (IS_MONOREPO) {
		for (const rel of [
			'packages/model-usage/atomic-file-state.ts',
			'packages/model-usage/sanitize-failure-text.ts',
			'packages/agent-sdlc/agent-status-validate.ts',
		]) {
			assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, rel)), true, rel);
		}

		const forbiddenToolPaths = [
			'tools/lib/atomic-file-state.mjs',
			'tools/ci/sanitize-failure-text.mjs',
			'tools/agent-status-validate.mjs',
			'atomic-file-state.mjs',
			'sanitize-failure-text.mjs',
			'agent-status-validate.mjs',
		];

		for (const pkgRoot of [AGENT_SDLC_ROOT, MODEL_USAGE_ROOT]) {
			for (const file of walkCodeFiles(pkgRoot)) {
				const relFile = path.relative(REPOSITORY_ROOT, file).split(path.sep).join('/');
				for (const { text } of collectSpecifiers(file)) {
					for (const forbidden of forbiddenToolPaths) {
						assert.equal(
							text.endsWith(forbidden),
							false,
							`${relFile} must not import '${text}'`,
						);
					}
					assert.equal(
						text.includes('model-usage/') && text.startsWith('.'),
						false,
						`${relFile} must not use relative cross-package import '${text}'`,
					);
				}
			}
		}

		for (const shimRel of [
			'tools/lib/atomic-file-state.mjs',
			'tools/ci/sanitize-failure-text.mjs',
			'tools/agent-status-validate.mjs',
		]) {
			const content = fs.readFileSync(path.join(REPOSITORY_ROOT, shimRel), 'utf8').trim();
			const lines = content.split(/\r?\n/);
			assert.equal(lines.length, 1, `${shimRel} must be a 1-line re-export shim`);
			assert.match(lines[0], /^export \* from ['"].+['"];$/);
		}
	} else {
		assert.equal(
			fs.existsSync(path.join(AGENT_SDLC_ROOT, 'agent-status-validate.ts')),
			true,
			'agent-status-validate.ts must exist',
		);
	}
});
