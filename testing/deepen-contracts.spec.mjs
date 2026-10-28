import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as contracts from '../policy/contracts.ts';

const FROZEN_CONTRACT_EXPORTS = [
	'ALLOWED_TOOLS',
	'ALLOWED_TRANSITIONS',
	'ARRAY_DRAFT_FIELDS',
	'AppliedSkillsRegistrySchema',
	'CLOSED_FRICTION_CATEGORIES',
	'CONTINUATION_ACTIONS',
	'CONTINUATION_REASONS',
	'DRAFT_FIELDS',
	'DagTaskSchema',
	'EVENT_TYPES',
	'FAILURE_CLASSIFICATIONS',
	'GIT_SHA',
	'HOST_APPROVAL_CHOICES',
	'HOST_FORBIDDEN_FLAGS',
	'HOST_HIGH_RISK_REVIEW_CHOICES',
	'HOST_INVOCATION_KEYS',
	'HOST_PLAN_CRITIC_CHOICES',
	'HOST_RECONCILIATION_CHOICES',
	'INSERTION_POINTS',
	'RELIABILITY_FAILURE_CATEGORIES',
	'RELIABILITY_SCHEMA_VERSION',
	'ROLE_KINDS',
	'RUNTIME_SCHEMA_VERSION',
	'RUNTIME_STATES',
	'ReconciliationRecordSchema',
	'SEVERITIES',
	'STORE_SCHEMA_VERSION',
	'SkillFindingsSyncArtifactSchema',
	'TASK_MANIFEST_DELIVERY_LAYERS',
	'TASK_MANIFEST_SCHEMA_VERSION',
	'TASK_MANIFEST_SLICE_KINDS',
	'TERMINAL_STATES',
	'TaskPlanSchema',
	'TaskStatusSchema',
	'VALID_ATTRIBUTION_PHASES',
	'VALID_FRICTION_SIGNALS',
	'VALID_PROMPT_ROLES',
	'applyPatchToContent',
	'assertTransition',
	'canonicalJson',
	'createEvent',
	'deriveEventId',
	'emptyDraft',
	'hostInvocationChangeSlots',
	'normalizeText',
	'normalizedValue',
	'resolveAggregatedAttributionLayer',
	'sha256',
	'validateAnswerDocument',
	'validateApprovalResponse',
	'validateCanaryQualification',
	'validateCompleteness',
	'validateContinuation',
	'validateCriticReviewRecord',
	'validateDagTask',
	'validateDraft',
	'validateEvent',
	'validateFailurePacket',
	'validateFalseEconomyDiagnostic',
	'validateFindingKey',
	'validateGeneration',
	'validateGitCommitRecord',
	'validateHostInvocation',
	'validateMutationAttempt',
	'validateOpaqueId',
	'validateOptionalRoleRecord',
	'validatePatch',
	'validatePreflightBinding',
	'validateProposedDiff',
	'validatePullRequestRecord',
	'validateQuestionBatch',
	'validateReconciliationRecord',
	'validateReviewFindings',
	'validateRoleDefinition',
	'validateRoleId',
	'validateRouteAttribution',
	'validateRunAuthorization',
	'validateRunId',
	'validateRuntimeState',
	'validateTaskManifest',
	'validateTaskManifestAcceptanceCriteria',
	'validateTaskPlan',
	'validateToolExecution',
	'validateVerificationAttempt',
	'validateWorkflowDefinition',
];

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = fs.existsSync(path.join(PACKAGE_ROOT, 'packages/agent-sdlc'))
	? PACKAGE_ROOT
	: path.resolve(PACKAGE_ROOT, '../../..');
const SDLC = fs.existsSync(path.join(ROOT, 'packages/agent-sdlc'))
	? path.join(ROOT, 'packages/agent-sdlc')
	: PACKAGE_ROOT;

function resolvePath(rel) {
	if (fs.existsSync(path.join(ROOT, rel))) return path.join(ROOT, rel);
	return path.join(SDLC, rel.replace(/^packages\/agent-sdlc\//, ''));
}

function measure(rel) {
	const data = fs.readFileSync(resolvePath(rel));
	let lines = 0;
	for (const byte of data) if (byte === 0x0a) lines += 1;
	return { lines, bytes: data.length };
}

function titles(rel) {
	const found = [];
	for (const line of fs.readFileSync(resolvePath(rel), 'utf8').split('\n')) {
		const match = line.match(/^test\('((?:\\'|[^'])*)'/);
		if (match) found.push(match[1]);
	}
	return found;
}

function scopePaths() {
	const contractsDir = path.join(SDLC, 'policy/contracts');
	const capabilitiesDir = path.join(SDLC, 'roles/capabilities');
	return [
		'packages/agent-sdlc/policy/contracts.ts',
		'packages/agent-sdlc/policy/contracts.spec.mjs',
		...fs.readdirSync(contractsDir).sort().map((name) => `packages/agent-sdlc/policy/contracts/${name}`),
		'packages/agent-sdlc/roles/capability-registry.ts',
		...fs.readdirSync(capabilitiesDir).sort().map((name) => `packages/agent-sdlc/roles/capabilities/${name}`),
		'packages/agent-sdlc/roles/role-registry.spec.mjs',
		'packages/agent-sdlc/roles/role-executor.spec.mjs',
		'packages/agent-sdlc/roles/role-executor-governance.spec.mjs',
	];
}

test('@ac AC-05 @case AC-05.1 in-scope contract and role files are within the ceiling', () => {
	for (const rel of scopePaths()) {
		const size = measure(rel);
		assert.ok(size.lines <= 500, `${rel} lines ${size.lines}`);
		assert.ok(size.bytes <= 20480, `${rel} bytes ${size.bytes}`);
	}
});

test('@ac AC-05 @case AC-05.2 in-scope paths are absent from the exceptions file', () => {
	const exceptions = JSON.parse(fs.readFileSync(path.join(SDLC, 'testing/navigability-exceptions.json'), 'utf8'));
	for (const rel of scopePaths()) assert.equal(Object.hasOwn(exceptions, rel), false, rel);
});

test('@ac AC-05 @case AC-05.3 moved contract and capability tests are not duplicated', () => {
	const contractTitles = new Set(titles('packages/agent-sdlc/policy/contracts.spec.mjs'));
	for (const name of fs.readdirSync(path.join(SDLC, 'policy/contracts')).filter((entry) => entry.endsWith('.spec.mjs'))) {
		for (const title of titles(`packages/agent-sdlc/policy/contracts/${name}`)) {
			assert.equal(contractTitles.has(title), false, title);
		}
	}
	const roleTitles = new Set(titles('packages/agent-sdlc/roles/role-registry.spec.mjs'));
	for (const name of fs.readdirSync(path.join(SDLC, 'roles/capabilities')).filter((entry) => entry.endsWith('.spec.mjs'))) {
		for (const title of titles(`packages/agent-sdlc/roles/capabilities/${name}`)) {
			assert.equal(roleTitles.has(title), false, title);
		}
	}
});

test('@ac AC-05 the barrel export names equal the frozen contract list', () => {
	assert.deepEqual(Object.keys(contracts).sort(), FROZEN_CONTRACT_EXPORTS);
});
