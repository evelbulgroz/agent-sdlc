import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadHostProfile } from './host-profile.ts';
import { assertProfileVersionGates } from './profile-version-gates.ts';
import { ProductEvidenceSchema, productEvidenceContainmentPaths } from './product-evidence-schema.ts';

const command = {
	argv: ['node', '{reportPath}'],
	cwd: 'pkg',
	layer: 'unit',
	pins: [{ file: 'pin.txt' }],
};

test('productEvidence is accepted only at host schema 1.7.0', () => {
	assert.doesNotThrow(() => assertProfileVersionGates({ schemaVersion: '1.7.0', productEvidence: { commands: {} } }));
	assert.throws(
		() => assertProfileVersionGates({ schemaVersion: '1.6.0', productEvidence: { commands: {} } }),
		/productEvidence/,
	);
});

test('ProductEvidenceSchema requires the report path and a cwd inside packageRoot', () => {
	assert.equal(ProductEvidenceSchema.safeParse({ packageRoot: 'pkg', commands: { unit: command } }).success, true);
	assert.equal(ProductEvidenceSchema.safeParse({
		packageRoot: 'pkg', commands: { unit: { ...command, cwd: 'other' } },
	}).success, false);
	assert.equal(ProductEvidenceSchema.safeParse({
		packageRoot: 'pkg', commands: { unit: { ...command, argv: ['node', 'run'] } },
	}).success, false);
	assert.equal(ProductEvidenceSchema.safeParse({
		packageRoot: 'pkg', commands: { unit: command }, extra: true,
	}).success, false);
});

test('loadHostProfile keeps a productEvidence block on schema 1.7.0', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-profile-'));
	try {
		fs.mkdirSync(path.join(root, '.agents'));
		const profile = {
			schemaVersion: '1.7.0', profileId: 'demo', repositoryId: 'demo', adapter: 'default',
			productEvidence: { packageRoot: 'pkg', commands: { unit: command } },
		};
		fs.writeFileSync(path.join(root, '.agents', 'sdlc-host.json'), JSON.stringify(profile));
		const loaded = loadHostProfile(root);
		assert.equal(loaded.productEvidence.commands.unit.layer, 'unit');
		fs.writeFileSync(path.join(root, '.agents', 'sdlc-host.json'), JSON.stringify({
			...profile, productEvidence: { ...profile.productEvidence, extra: true },
		}));
		assert.throws(() => loadHostProfile(root), /HOST_PROFILE_INVALID/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('product commands can override the default root without changing legacy command projections', () => {
	const legacy = ProductEvidenceSchema.parse({ packageRoot: 'pkg', commands: { unit: command } });
	assert.deepEqual(legacy.commands.unit, command);
	const scoped = { ...command, cwd: 'sibling/src', packageRoot: 'sibling', caseIdentity: 'case-file-criterion' };
	const parsed = ProductEvidenceSchema.parse({ packageRoot: 'pkg', commands: { unit: command, node: scoped } });
	assert.deepEqual(parsed.commands.node, scoped);
	assert.ok(productEvidenceContainmentPaths(parsed).some(([file, field]) =>
		file === 'sibling' && field === 'productEvidence.commands.node.packageRoot'));
	for (const overrides of [
		{ packageRoot: null }, { packageRoot: '' }, { packageRoot: '.' }, { packageRoot: '../sibling' },
		{ packageRoot: '/sibling' }, { cwd: 'sibling-other' }, { caseIdentity: null },
		{ caseIdentity: '' }, { caseIdentity: 'unknown' }, { unexpected: true },
	]) {
		assert.equal(ProductEvidenceSchema.safeParse({
			packageRoot: 'pkg', commands: { node: { ...scoped, ...overrides } },
		}).success, false, JSON.stringify(overrides));
	}
});

test('host loading rejects an explicitly scoped root that resolves outside the repository', (t) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-root-'));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'product-outside-'));
	t.after(() => { fs.rmSync(root, { recursive: true }); fs.rmSync(outside, { recursive: true }); });
	fs.mkdirSync(path.join(root, '.agents'));
	fs.mkdirSync(path.join(root, 'pkg'));
	fs.symlinkSync(outside, path.join(root, 'sibling'));
	fs.writeFileSync(path.join(root, '.agents/sdlc-host.json'), JSON.stringify({
		schemaVersion: '1.7.0', profileId: 'demo', repositoryId: 'demo', adapter: 'default',
		productEvidence: { packageRoot: 'pkg', commands: {
			node: { ...command, cwd: 'sibling', packageRoot: 'sibling', caseIdentity: 'case-file-criterion' },
		} },
	}));
	assert.throws(() => loadHostProfile(root), /HOST_PROFILE_INVALID/);
});
