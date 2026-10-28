import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

export const NON_NULL_ASSERTION_CAP = 0;

export const EXTERNAL_DECLARATION_PATHS = Object.freeze([
	'tools/ci/sanitize-failure-text.d.mts',
	'tools/lib/learn.d.mts',
	'tools/lib/atomic-file-state.d.mts',
	'tools/agent-status-validate.d.mts',
]);

function lineAt(sourceFile, position) {
	return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

export function scanTypeEscapeSource(source, filePath = 'fixture.ts') {
	const sourceFile = ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	const violations = [];
	const nonNullLocations = [];
	const doubleAssertionLines = new Set();

	const visit = (node) => {
		if (node.kind === ts.SyntaxKind.AnyKeyword) {
			violations.push({
				file: filePath,
				line: lineAt(sourceFile, node.getStart(sourceFile)),
				rule: 'explicit-any',
				message: 'Explicit any is forbidden in factory TypeScript',
			});
		}
		if (
			ts.isAsExpression(node) &&
			ts.isAsExpression(node.expression) &&
			node.expression.type.kind === ts.SyntaxKind.UnknownKeyword
		) {
			const line = lineAt(sourceFile, node.getStart(sourceFile));
			doubleAssertionLines.add(line);
			violations.push({
				file: filePath,
				line,
				rule: 'as-unknown-as',
				message: 'Double assertion via as unknown as is forbidden',
			});
		}
		if (ts.isNonNullExpression(node)) {
			nonNullLocations.push({
				file: filePath,
				line: lineAt(sourceFile, node.getStart(sourceFile)),
				rule: 'non-null-assertion',
				message: 'Non-null assertion (!) is forbidden above the frozen cap',
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);

	const lines = source.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const lineNumber = index + 1;
		if (/(?:\/\/|\/\*).*@ts-ignore\b/.test(line)) {
			violations.push({
				file: filePath,
				line: lineNumber,
				rule: 'ts-ignore',
				message: '@ts-ignore is forbidden in factory TypeScript',
			});
		}
		if (/(?:\/\/|\/\*).*@ts-nocheck\b/.test(line)) {
			violations.push({
				file: filePath,
				line: lineNumber,
				rule: 'ts-nocheck',
				message: '@ts-nocheck is forbidden in factory TypeScript',
			});
		}
		const expectErrorMatch = line.match(/(?:\/\/|\/\*)\s*@ts-expect-error\b(.*)$/);
		if (expectErrorMatch) {
			const reason = expectErrorMatch[1].replace(/\*\/.*$/, '').trim();
			if (reason.length === 0) {
				violations.push({
					file: filePath,
					line: lineNumber,
					rule: 'reasonless-ts-expect-error',
					message: '@ts-expect-error requires a reason comment on the same line',
				});
			}
		}
		if (!doubleAssertionLines.has(lineNumber) && /\bas\s+unknown\s+as\b/.test(line)) {
			violations.push({
				file: filePath,
				line: lineNumber,
				rule: 'as-unknown-as',
				message: 'Double assertion via as unknown as is forbidden',
			});
		}
	}

	return {
		violations,
		nonNullLocations,
	};
}

function collectTsFiles(rootDir) {
	const collected = [];
	const walk = (currentDir) => {
		if (!fs.existsSync(currentDir)) return;
		for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
				walk(fullPath);
				continue;
			}
			if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.d.mts'))) {
				collected.push(fullPath);
			}
		}
	};
	walk(rootDir);
	return collected.sort();
}

export function scanFactoryTypeEscapes(
	rootDir = null,
	cap = NON_NULL_ASSERTION_CAP,
) {
	const isDefaultRepoScan = rootDir === null;
	const baseDir = rootDir ?? REPOSITORY_ROOT;
	const files = isDefaultRepoScan
		? [
				...collectTsFiles(path.join(REPOSITORY_ROOT, 'packages/agent-sdlc')),
				...collectTsFiles(path.join(REPOSITORY_ROOT, 'packages/model-usage')),
				...EXTERNAL_DECLARATION_PATHS.map((rel) => path.join(REPOSITORY_ROOT, rel)),
			].sort()
		: collectTsFiles(rootDir);
	const violations = [];
	const nonNullLocations = [];
	for (const fullPath of files) {
		const relPath = path.relative(baseDir, fullPath).split(path.sep).join('/');
		const source = fs.readFileSync(fullPath, 'utf8');
		const scanned = scanTypeEscapeSource(source, relPath);
		violations.push(...scanned.violations);
		nonNullLocations.push(...scanned.nonNullLocations);
	}
	if (nonNullLocations.length > cap) {
		violations.push(...nonNullLocations);
	}
	return {
		files: files.map((fullPath) => path.relative(baseDir, fullPath).split(path.sep).join('/')),
		violations,
		nonNullCount: nonNullLocations.length,
	};
}

function withTempTsFixture(fileName, content, callback) {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-escape-scan-'));
	try {
		const filePath = path.join(tempDir, fileName);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, content);
		return callback(tempDir);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

test('@ac AC-02 @case AC-02.1 @ac AC-03 @case AC-03.1 a temporary .ts file containing : any is reported', () => {
	const result = withTempTsFixture(
		'bad-any.ts',
		'export function acceptAny(input: any): string {\n\treturn String(input);\n}\n',
		(tempDir) => scanFactoryTypeEscapes(tempDir),
	);
	assert.equal(result.violations.length, 1);
	assert.equal(result.violations[0].file, 'bad-any.ts');
	assert.equal(result.violations[0].rule, 'explicit-any');
});

test('@ac AC-02 @case AC-02.2 @ac AC-03 @case AC-03.2 a temporary file with @ts-expect-error and no reason is reported', () => {
	const result = withTempTsFixture(
		'bad-expect-error.ts',
		'// @ts-expect-error\nexport const broken: number = "not-a-number";\n',
		(tempDir) => scanFactoryTypeEscapes(tempDir),
	);
	assert.equal(result.violations.length, 1);
	assert.equal(result.violations[0].file, 'bad-expect-error.ts');
	assert.equal(result.violations[0].rule, 'reasonless-ts-expect-error');

	const withReason = withTempTsFixture(
		'explained-expect-error.ts',
		'// @ts-expect-error intentional type mismatch for negative test\nexport const explained: number = "text";\n',
		(tempDir) => scanFactoryTypeEscapes(tempDir),
	);
	assert.deepEqual(withReason.violations, []);
});

test('@ac AC-02 @ac AC-03 @case AC-03.3 a temporary file with as unknown as is reported', () => {
	const result = withTempTsFixture(
		'bad-double-assert.ts',
		'export function coerce(value: string): number {\n\treturn value as unknown as number;\n}\n',
		(tempDir) => scanFactoryTypeEscapes(tempDir),
	);
	assert.equal(result.violations.length, 1);
	assert.equal(result.violations[0].file, 'bad-double-assert.ts');
	assert.equal(result.violations[0].rule, 'as-unknown-as');
});

test('@ac AC-02 @case AC-02.3 @case AC-02.4 @ac AC-03 @case AC-03.4 the repository scan reports zero violations and zero non-null assertions across packages/agent-sdlc, packages/model-usage, and the four external .d.mts declarations', () => {
	const result = scanFactoryTypeEscapes();
	assert.ok(result.files.length > 0, 'expected .ts files under packages/agent-sdlc and packages/model-usage');
	assert.equal(result.files.includes('packages/agent-sdlc/testing/erasable-probe.ts'), true);
	assert.equal(result.files.includes('packages/model-usage/governor.ts'), true);
	for (const declPath of EXTERNAL_DECLARATION_PATHS) {
		assert.equal(result.files.includes(declPath), true, `expected scanner to include ${declPath}`);
	}
	assert.deepEqual(result.violations, []);
	assert.equal(result.nonNullCount, 0);
	assert.ok(result.nonNullCount <= NON_NULL_ASSERTION_CAP);
});
