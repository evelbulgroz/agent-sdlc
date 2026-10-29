import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { RoleRegistry } from './role-registry.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

function readRepositoryFile(relativePath) {
	return fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
}

function assertContainsAll(policy, expected, label) {
	for (const fragment of expected) {
		assert.match(policy, fragment, `${label} must retain ${fragment}`);
	}
}

const hasHostRubrics = fs.existsSync(path.join(REPOSITORY_ROOT, '.agents/review-rubrics/code.md'));

test('live role policies retain architecture prevention and independent detection', { skip: !hasHostRubrics }, () => {
	const registry = new RoleRegistry({ rootDir: REPOSITORY_ROOT });
	const implementer = registry.loadRole('implementer').promptPolicy;
	const reviewer = registry.loadRole('reviewer').promptPolicy;
	const codeRubric = readRepositoryFile('.agents/review-rubrics/code.md');

	const permanentArchitectureContracts = [
		/UI -> application use case -> port -> gateway adapter/i,
		/generated gateway client/i,
		/PWA must never import @example\/\*-service packages or service \/contracts/i,
		/controller -> application use case -> domain aggregate -> adapter/i,
		/@example\/<service>-service\/contracts/i,
	];

	assertContainsAll(implementer, permanentArchitectureContracts, 'implementer policy');
	assertContainsAll(reviewer, permanentArchitectureContracts, 'reviewer policy');
	assertContainsAll(codeRubric, permanentArchitectureContracts, 'code rubric');
});

test('@ac AC-03 @case AC-03.1 live implementer and backend-scoped reviewer policies retain the complete dual-enforcement contract', { skip: !hasHostRubrics }, () => {
	const registry = new RoleRegistry({ rootDir: REPOSITORY_ROOT });
	const implementer = registry.loadRole('implementer').promptPolicy;
	const backendReviewer = registry.loadRole('reviewer', {
		authoredPaths: ['apps/services/conditioning/src/main.ts'],
	}).promptPolicy;

	const dualEnforcementContracts = [
		/DTO setters/i,
		/entity setters/i,
		/PATCH messages/i,
		/overview\/detail projections/i,
		/property-rule matrix/i,
		/OpenAPI schemas/i,
	];

	assertContainsAll(implementer, dualEnforcementContracts, 'implementer policy');
	assertContainsAll(backendReviewer, dualEnforcementContracts, 'backend-scoped reviewer policy');
});

test('@ac AC-03 @case AC-03.1 baseline testing remains an implementer obligation and an independent QA audit', { skip: !hasHostRubrics }, () => {
	const registry = new RoleRegistry({ rootDir: REPOSITORY_ROOT });
	const implementer = registry.loadRole('implementer').promptPolicy;
	const qaRubric = readRepositoryFile('.agents/review-rubrics/qa.md');

	assert.match(implementer, /Tests Travel with Behavior/i);
	assert.match(implementer, /co-located test updates/i);
	assert.match(implementer, /@ac AC-NN/);
	assert.match(implementer, /asserting test/i);
	assert.match(implementer, /expect\(\.\.\.\).*assert/i);
	assert.match(qaRubric, /Baseline Test Obligation/i);
	assert.match(qaRubric, /without treating the hardener as the owner of baseline tests/i);
});

test('@ac AC-05 semantic review blocks grounded unrequested behavior', { skip: !hasHostRubrics }, () => {
	const reviewer = new RoleRegistry({ rootDir: REPOSITORY_ROOT }).loadRole(
		'reviewer',
	).promptPolicy;
	const codeRubric = readRepositoryFile('.agents/review-rubrics/code.md');
	for (const policy of [reviewer, codeRubric]) {
		assert.match(policy, /user-visible text/i);
		assert.match(policy, /styling/i);
		assert.match(policy, /duplicated derived state/i);
		assert.match(policy, /P1/i);
		assert.match(policy, /added diff lines/i);
	}
});

test('visible-control specs name the accessible name and the keyboard action', { skip: !hasHostRubrics }, () => {
	const specifier = new RoleRegistry({ rootDir: REPOSITORY_ROOT }).loadRole(
		'specifier',
	).promptPolicy;
	const specRubric = readRepositoryFile('.agents/review-rubrics/spec.md');
	const expected = [
		/adds or changes a visible control/i,
		/accessible name/i,
		/keyboard user completes the action/i,
		/docs\/handbook\/frontend\.md/i,
		/docs\/handbook\/frontend-pwa-react\.md/i,
		/\(Accessibility\)/i,
		/Invariants/i,
	];

	assertContainsAll(specifier, expected, 'specifier policy');
	assertContainsAll(specRubric, expected, 'spec rubric');
	assert.match(specifier, /Do not copy the client invariant list/i);
	assert.match(specRubric, /Flag a missing line or a missing pointer as P1/i);
});

test('@ac AC-03 @case AC-03.1 active built-in roles use governed model profiles with positive token limits', () => {
	const registry = new RoleRegistry({ rootDir: REPOSITORY_ROOT });

	for (const roleId of ['specifier', 'implementer', 'reviewer', 'critic-reviewer']) {
		const { role } = registry.loadRole(roleId);
		assert.notEqual(
			role.modelProfile,
			'agent-sdlc-deterministic',
			`${roleId} must use a governed model profile`,
		);
		assert.equal(role.requestedLimits.maxPromptTokens > 0, true, `${roleId} must allow prompt tokens`);
		assert.equal(
			role.requestedLimits.maxCompletionTokens > 0,
			true,
			`${roleId} must allow completion tokens`,
		);
	}
});
