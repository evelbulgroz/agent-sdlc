import assert from 'node:assert/strict';
import { FIXTURE_MONOREPO_ROOT } from './fixture-monorepo-root.mjs';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadHostProfile } from '../host/host-profile.ts';
import { hasCapability } from '../roles/capability-registry.ts';
import { PACKAGE_ROLE_DEFAULTS_ROOT, RoleRegistry } from '../roles/role-registry.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const ROOT = fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/engine'))
	? path.join(REPOSITORY_ROOT, 'packages/engine')
	: REPOSITORY_ROOT;
const ACTIVE_ROLES = ['specifier', 'implementer', 'reviewer', 'critic-reviewer'];
const RETIRED_ROLES = ['architect', 'cleaner', 'hardener', 'repairer', 'verifier'];
const RETIRED = [
	'controlled-executor.mjs',
	'repair.mjs',
	'programmer-turn.mjs',
	'executor-progress.mjs',
	'step-canary.mjs',
	'scripts/compare-executors.mjs',
];

function productionModules(dir) {
	const found = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'testing') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...productionModules(full));
			continue;
		}
		if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts') || entry.name.endsWith('.d.ts')) continue;
		found.push(full);
	}
	return found;
}

test('@ac AC-06 @case AC-06.1 @case AC-06.2 retired executor modules are absent and unimported', () => {
	for (const relative of RETIRED) {
		assert.equal(fs.existsSync(path.join(ROOT, relative)), false, relative);
	}
	assert.equal(fs.existsSync(path.join(ROOT, 'testing/step-canary/implementer.json')), false);
	const retiredImport = /(?:controlled-executor|programmer-turn|repair|executor-progress|step-canary|compare-executors)\.(?:mjs|ts)/;
	for (const file of productionModules(ROOT)) {
		const source = fs.readFileSync(file, 'utf8');
		assert.equal(retiredImport.test(source), false, path.relative(ROOT, file));
	}
});

test('@ac AC-06 @case AC-06.5 the lean capability is a marker and the controlled loop is unregistered', () => {
	assert.equal(hasCapability('lean-tool-loop-v1'), true);
	assert.equal(hasCapability('controlled-tool-loop-v1'), false);
	const source = fs.readFileSync(path.join(ROOT, 'roles/capability-registry.ts'), 'utf8');
	assert.equal(source.includes('buildLeanPrompt'), false);
	assert.equal(source.includes('readFileActionSchema'), false);
	assert.equal(source.includes('discreteToolActionSchemas'), false);
});

test('@ac AC-01 @case AC-01.1 @case AC-01.2 inactive built-in roles and unused workflow manifests are absent from roles/defaults while active roles load cleanly', () => {
	for (const wf of ['sdlc-extended-roles.json', 'sdlc-single-worktree.json']) {
		assert.equal(fs.existsSync(path.join(PACKAGE_ROLE_DEFAULTS_ROOT, wf)), false, wf);
	}
	assert.equal(fs.existsSync(path.join(PACKAGE_ROLE_DEFAULTS_ROOT, 'specification.json')), true);

	for (const roleId of RETIRED_ROLES) {
		assert.equal(fs.existsSync(path.join(PACKAGE_ROLE_DEFAULTS_ROOT, 'roles', `${roleId}.json`)), false, `roles/${roleId}.json`);
		assert.equal(fs.existsSync(path.join(PACKAGE_ROLE_DEFAULTS_ROOT, 'protocol', `${roleId}.md`)), false, `protocol/${roleId}.md`);
		assert.equal(fs.existsSync(path.join(PACKAGE_ROLE_DEFAULTS_ROOT, 'philosophy', `${roleId}.md`)), false, `philosophy/${roleId}.md`);
	}

	const registry = new RoleRegistry({ rootDir: REPOSITORY_ROOT });
	for (const roleId of ACTIVE_ROLES) {
		assert.equal(fs.existsSync(path.join(PACKAGE_ROLE_DEFAULTS_ROOT, 'roles', `${roleId}.json`)), true, `roles/${roleId}.json`);
		assert.equal(fs.existsSync(path.join(PACKAGE_ROLE_DEFAULTS_ROOT, 'protocol', `${roleId}.md`)), true, `protocol/${roleId}.md`);
		assert.equal(fs.existsSync(path.join(PACKAGE_ROLE_DEFAULTS_ROOT, 'philosophy', `${roleId}.md`)), true, `philosophy/${roleId}.md`);
		const loaded = registry.loadRole(roleId);
		assert.equal(loaded.role.roleId, roleId);
	}

	for (const roleId of RETIRED_ROLES) {
		assert.throws(
			() => registry.loadRole(roleId),
			(err) => err.code === 'INVALID_CONTRACT',
			`loadRole(${roleId}) must throw INVALID_CONTRACT`,
		);
	}
});

test('@ac AC-02 @case AC-02.1 @case AC-02.2 inactive Layer 3 prompt files are absent from .agents/workflows/prompts and .agents/sdlc-host.json scopes pathScopedRules to active roles', () => {
	const promptsDir = path.join(REPOSITORY_ROOT, '.agents/workflows/prompts');
	for (const roleId of RETIRED_ROLES) {
		assert.equal(fs.existsSync(path.join(promptsDir, `${roleId}.md`)), false, `${roleId}.md must be absent`);
	}
	for (const roleId of ACTIVE_ROLES) {
		assert.equal(fs.existsSync(path.join(promptsDir, `${roleId}.md`)), true, `${roleId}.md must exist`);
	}

	const profile = loadHostProfile(FIXTURE_MONOREPO_ROOT);
	const rules = profile.prompts?.pathScopedRules ?? [];
	assert.equal(rules.length, 2);
	for (const rule of rules) {
		assert.deepEqual(rule.roles, ['specifier', 'implementer', 'reviewer']);
	}
});
