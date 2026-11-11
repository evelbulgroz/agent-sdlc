import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SdlcError } from '../policy/errors.ts';
import { runApprovedQualityCorrection } from '../workflow/quality-correction-runner.ts';
import {
	proveReferences,
	removePrivateMethod,
	requireDeletionProof,
	requireStoredProof,
} from './reference-proof.ts';

function tree(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-proof-'));
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
	}
	return root;
}

test('@ac AC-03 @case AC-03.1 zero static importers accepts a file deletion', () => {
	const root = tree({
		'pkg/src/keep.ts': 'export const kept = 1;\n',
	});
	try {
		const proof = proveReferences({
			rootDir: root,
			roots: ['pkg'],
			deletedPaths: ['pkg/src/orphan.ts'],
		});
		assert.equal(proof.pass, true);
		assert.deepEqual(proof.reasons, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.2 one importer outside the file rejects it', () => {
	const root = tree({
		'pkg/src/keep.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const proof = proveReferences({ rootDir: root, roots: ['pkg'], deletedPaths: ['pkg/src/orphan.ts'] });
		assert.equal(proof.pass, false);
		assert.equal(proof.reasons.some((reason) => reason.includes('keep.ts')), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.3 a non-literal dynamic import rejects it', () => {
	const root = tree({
		'pkg/src/keep.ts': 'export const value = import(name);\n',
	});
	try {
		const proof = proveReferences({ rootDir: root, roots: ['pkg'], deletedPaths: ['pkg/src/orphan.ts'] });
		assert.equal(proof.pass, false);
		assert.equal(proof.reasons.some((reason) => reason.startsWith('non_literal')), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.4 a private method that still has a reference is rejected', () => {
	const root = tree({
		'pkg/src/route.ts': 'export class Route { private retire() { return 1; } call() { return this.retire(); } }\n',
	});
	try {
		const source = fs.readFileSync(path.join(root, 'pkg/src/route.ts'), 'utf8');
		fs.writeFileSync(path.join(root, 'pkg/src/route.ts'), removePrivateMethod(source, 'retire'));
		const proof = proveReferences({
			rootDir: root,
			roots: ['pkg'],
			methodRemovals: [{ file: 'pkg/src/route.ts', name: 'retire' }],
		});
		assert.equal(proof.pass, false);
		assert.equal(proof.reasons.some((reason) => reason.includes('retire')), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a node import and a package subpath do not fail a deletion, and a bare walked specifier does', () => {
	const ignored = tree({
		'pkg/src/keep.ts': "import fs from 'node:fs';\nimport { X } from '@nestjs/common/interfaces';\n",
	});
	const named = tree({
		'pkg/src/keep.ts': "import orphan from 'pkg/src/orphan';\n",
	});
	try {
		const nodeImport = proveReferences({ rootDir: ignored, roots: ['pkg'], deletedPaths: ['pkg/src/orphan.ts'] });
		assert.equal(nodeImport.pass, true);
		const bare = proveReferences({ rootDir: named, roots: ['pkg'], deletedPaths: ['pkg/src/orphan.ts'] });
		assert.equal(bare.pass, false);
		assert.equal(bare.reasons.some((reason) => reason.startsWith('non_relative')), true);
	} finally {
		fs.rmSync(ignored, { recursive: true, force: true });
		fs.rmSync(named, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.5 a preflight pass without the proof artifact rejects the revision', () => {
	assert.throws(() => requireStoredProof(null), (error) => error instanceof SdlcError && error.code === 'INVALID_CONTRACT');
	assert.throws(() => requireStoredProof(''), (error) => error instanceof SdlcError);
});

test('a null root and an empty deletion list stay closed', () => {
	assert.equal(proveReferences({ rootDir: null, deletedPaths: ['pkg/src/orphan.ts'] }).pass, false);
	const root = tree({ 'pkg/src/keep.ts': 'export const kept = 1;\n' });
	try {
		assert.equal(proveReferences({ rootDir: root, roots: [], deletedPaths: [] }).pass, true);
		assert.equal(proveReferences({ rootDir: root, roots: ['pkg'], deletedPaths: [] }).pass, true);
		const missing = proveReferences({ rootDir: path.join(root, 'missing'), roots: ['pkg'], deletedPaths: ['pkg/a.ts'] });
		assert.equal(missing.pass, false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a string token, a decorator, and an exported name fail the proof', () => {
	const root = tree({
		'pkg/src/keep.ts': "export const token = 'pkg/src/orphan.ts';\nexport const decorated = '@Orphan()';\n",
		'pkg/src/route.ts': 'export class Route { private retire() { return 1; } }\n',
	});
	try {
		const token = proveReferences({ rootDir: root, roots: ['pkg'], deletedPaths: ['pkg/src/orphan.ts'] });
		assert.equal(token.pass, false);
		const decorated = proveReferences({
			rootDir: root,
			roots: ['pkg'],
			deletedPaths: ['pkg/src/orphan.ts'],
		});
		assert.equal(decorated.reasons.some((reason) => reason.startsWith('string token') || reason.startsWith('decorator')), true);
		fs.writeFileSync(path.join(root, 'pkg/src/keep.ts'), 'export const kept = 1;\n');
		fs.writeFileSync(path.join(root, 'pkg/src/use.ts'), '@Orphan()\nexport const used = 1;\n');
		const decorator = proveReferences({ rootDir: root, roots: ['pkg'], deletedPaths: ['pkg/src/orphan.ts'] });
		assert.equal(decorator.reasons.some((reason) => reason.startsWith('decorator')), true);
		const exported = proveReferences({
			rootDir: root,
			roots: ['pkg'],
			methodRemovals: [{ file: 'pkg/src/route.ts', name: 'retire' }],
		});
		assert.equal(exported.pass, false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a private method with zero references passes', () => {
	const root = tree({
		'pkg/src/route.ts': 'export class Route { private retire() { return 1; } }\n',
	});
	try {
		const source = fs.readFileSync(path.join(root, 'pkg/src/route.ts'), 'utf8');
		fs.writeFileSync(path.join(root, 'pkg/src/route.ts'), removePrivateMethod(source, 'retire'));
		const proof = proveReferences({
			rootDir: root,
			roots: ['pkg'],
			methodRemovals: [{ file: 'pkg/src/route.ts', name: 'retire' }],
		});
		assert.equal(proof.pass, true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-05 @case AC-05.6 a bound checkpoint correction uses the same proof', () => {
	const root = tree({ 'pkg/src/keep.ts': "import { orphan } from './orphan.ts';\n" });
	try {
		assert.equal(runApprovedQualityCorrection.toString().includes('requireDeletionProof'), true);
		assert.throws(
			() => requireDeletionProof({ rootDir: root, roots: ['pkg'], deletedPaths: ['pkg/src/orphan.ts'] }),
			(error) => error instanceof SdlcError && error.code === 'POLICY_VIOLATION',
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
