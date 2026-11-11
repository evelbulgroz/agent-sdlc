import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readStaticImportGraph, resolvedImporters, staticImportScanCount } from './static-import-graph.ts';

function tempTree(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-graph-'));
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
	}
	return root;
}

test('resolves relative import, export-from, and literal dynamic import', () => {
	const root = tempTree({
		'pkg/src/retire.ts': "import { orphan } from './orphan.ts';\nexport { kept } from './kept.ts';\nexport const loaded = import('./lazy.ts');\n",
		'pkg/src/orphan.ts': 'export const orphan = 1;\n',
		'pkg/src/kept.ts': 'export const kept = 2;\n',
		'pkg/src/lazy.ts': 'export const lazy = 3;\n',
	});
	try {
		const graph = readStaticImportGraph({ rootDir: root, roots: ['pkg'] });
		assert.deepEqual(resolvedImporters(graph, 'pkg/src/orphan.ts'), ['pkg/src/retire.ts']);
		assert.deepEqual(resolvedImporters(graph, 'pkg/src/kept.ts'), ['pkg/src/retire.ts']);
		assert.deepEqual(resolvedImporters(graph, 'pkg/src/lazy.ts'), ['pkg/src/retire.ts']);
		assert.equal(graph.unresolved.length, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('missing roots and empty directories add no edges', () => {
	const before = staticImportScanCount();
	const missing = readStaticImportGraph({ rootDir: os.tmpdir(), roots: ['does-not-exist-retirement'] });
	assert.deepEqual(missing.files, []);
	assert.deepEqual(missing.imports, []);
	assert.equal(staticImportScanCount(), before + 1);
	const root = tempTree({});
	try {
		const empty = readStaticImportGraph({ rootDir: root, roots: [] });
		assert.deepEqual(empty.files, []);
		assert.equal(empty.unresolved.length, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('non-literal dynamic import and non-relative specifier stay unresolved', () => {
	const root = tempTree({
		'pkg/src/retire.ts': "import { Injectable } from '@nestjs/common';\nimport name from 'pkg/src/orphan';\nexport const value = import(name);\n",
		'pkg/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const graph = readStaticImportGraph({ rootDir: root, roots: ['pkg'] });
		assert.equal(graph.imports.length, 0);
		assert.equal(graph.unresolved.some((hit) => hit.reason === 'non_literal'), true);
		assert.equal(graph.unresolved.some((hit) => hit.reason === 'non_relative' && hit.specifier === 'pkg/src/orphan'), true);
		assert.equal(graph.unresolved.some((hit) => hit.specifier === '@nestjs/common'), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-02 @case AC-02.4 node:fs and @nestjs/common/interfaces add no blocker and no path', () => {
	const root = tempTree({
		'pkg/src/retire.ts': "import fs from 'node:fs';\nimport { X } from '@nestjs/common/interfaces';\nimport get from 'lodash/get';\n",
	});
	try {
		const graph = readStaticImportGraph({ rootDir: root, roots: ['pkg'] });
		assert.equal(graph.unresolved.length, 0);
		assert.equal(graph.imports.length, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-02 @case AC-02.5 a bare specifier that names a walked file is a non_relative P1 and adds no path', () => {
	const root = tempTree({
		'pkg/src/retire.ts': "import orphan from 'pkg/src/orphan';\n",
		'pkg/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const graph = readStaticImportGraph({ rootDir: root, roots: ['pkg'] });
		assert.equal(graph.imports.length, 0);
		assert.equal(graph.unresolved.some((hit) => hit.reason === 'non_relative' && hit.specifier === 'pkg/src/orphan'), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a comment that mentions import is not an edge', () => {
	const root = tempTree({
		'pkg/src/retire.ts': "// import { orphan } from './orphan.ts';\nexport const retired = 1;\n",
		'pkg/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const graph = readStaticImportGraph({ rootDir: root, roots: ['pkg'] });
		assert.deepEqual(resolvedImporters(graph, 'pkg/src/orphan.ts'), []);
		assert.equal(graph.unresolved.length, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
