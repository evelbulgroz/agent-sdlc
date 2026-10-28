import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as contracts from './contracts.ts';
import { TERMINAL_STATES as transitionTerminalStates } from './contracts/runtime-transitions.ts';

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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDLC_ROOT = path.resolve(HERE, '..');
const CONTRACTS_DIR = path.join(HERE, 'contracts');
const PRIVATE_HELPERS = [
	'failContract',
	'assertContractObject',
	'assertClosedContract',
	'contractNonEmptyString',
	'contractOptionalHash',
	'contractStringArray',
	'HASH_PATTERN',
	'IDENTIFIER_PATTERN',
	'RUN_ID_PATTERN',
	'DRAFT_RESPONSE_KINDS',
];
const DEAD_EXPORTS = [
	'validateCandidateLearningsBatch',
	'TASK_STATUSES',
	'PromptFrictionFindingSchema',
];
const ALLOWED = {
	'draft-schema.ts': ['primitives.ts'],
	'role-schema.ts': ['primitives.ts'],
	'skill-learning-schema.ts': ['primitives.ts'],
	'runtime-vocabulary.ts': ['primitives.ts', 'draft-schema.ts'],
	'runtime-transitions.ts': ['primitives.ts', 'runtime-vocabulary.ts'],
	'planning-schema.ts': ['primitives.ts'],
	'dag-schema.ts': ['primitives.ts', 'planning-schema.ts'],
	'host-invocation-schema.ts': ['primitives.ts', 'draft-schema.ts'],
	'run-authorization-schema.ts': ['primitives.ts', 'runtime-vocabulary.ts'],
	'execution-records.ts': ['primitives.ts', 'role-schema.ts'],
	'review-records.ts': ['primitives.ts', 'role-schema.ts'],
	'reliability-records.ts': ['primitives.ts'],
	'primitives.ts': [],
};

function productionModules() {
	return fs.readdirSync(CONTRACTS_DIR)
		.filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts'))
		.sort();
}

function importSources(source) {
	const found = [];
	const pattern = /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
	for (const match of source.matchAll(pattern)) found.push(match[1]);
	return found;
}

function newlineCount(file) {
	const data = fs.readFileSync(file);
	let lines = 0;
	for (const byte of data) if (byte === 0x0a) lines += 1;
	return { lines, bytes: data.length };
}

test('@ac AC-01 @case AC-01.1 the sorted export names of the barrel equal the frozen list', () => {
	assert.deepEqual(Object.keys(contracts).sort(), FROZEN_CONTRACT_EXPORTS);
});

test('@ac AC-01 @case AC-01.2 the barrel source is only explicit re-exports', () => {
	const source = fs.readFileSync(path.join(HERE, 'contracts.ts'), 'utf8');
	assert.doesNotMatch(source, /^\s*(?:async\s+)?function\b/m);
	assert.doesNotMatch(source, /^\s*class\b/m);
	assert.doesNotMatch(source, /^\s*const\b/m);
	assert.doesNotMatch(source, /^\s*let\b/m);
	assert.doesNotMatch(source, /^\s*import\b/m);
	assert.doesNotMatch(source, /export\s*\*/);
	for (const line of source.split('\n')) {
		if (line.trim() === '') continue;
		assert.match(line, /^(?:export (?:type )?\{|\t[A-Za-z0-9_]+,|\} from '\.\/contracts\/[a-z0-9-]+\.ts';)$/);
	}
});

test('@ac AC-01 @case AC-01.3 renamed helpers are not barrel exports', () => {
	for (const name of PRIVATE_HELPERS) assert.equal(Object.hasOwn(contracts, name), false, name);
});

test('@ac AC-01 @case AC-01.4 barrel TERMINAL_STATES is the transitions Set', () => {
	assert.equal(contracts.TERMINAL_STATES, transitionTerminalStates);
});

test('@ac AC-01 @case AC-01.5 dead contract exports are absent from production files', () => {
	const files = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name === '.agent-sdlc') continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && /\.(mjs|js|ts)$/.test(entry.name) && !entry.name.endsWith('.spec.mjs') && !entry.name.endsWith('.spec.ts')) files.push(full);
		}
	};
	walk(SDLC_ROOT);
	for (const file of files) {
		const source = fs.readFileSync(file, 'utf8');
		for (const name of DEAD_EXPORTS) {
			assert.equal(new RegExp(`\\b${name}\\b`).test(source), false, `${path.relative(SDLC_ROOT, file)} names ${name}`);
		}
	}
});

test('@ac AC-02 @case AC-02.1 each contracts submodule is within the ceiling', () => {
	for (const name of productionModules()) {
		const size = newlineCount(path.join(CONTRACTS_DIR, name));
		assert.ok(size.lines <= 500, `${name} lines ${size.lines}`);
		assert.ok(size.bytes <= 20480, `${name} bytes ${size.bytes}`);
	}
});

test('@ac AC-02 @case AC-02.2 no submodule imports the contracts barrel', () => {
	for (const name of productionModules()) {
		const sources = importSources(fs.readFileSync(path.join(CONTRACTS_DIR, name), 'utf8'));
		for (const source of sources) assert.equal(source.endsWith('/contracts.ts') || source.endsWith('../contracts.ts'), false, `${name} -> ${source}`);
	}
});

test('@ac AC-02 @case AC-02.3 submodule imports use the allowed edges and do not cycle', () => {
	const graph = new Map();
	for (const name of productionModules()) {
		assert.ok(Object.hasOwn(ALLOWED, name), name);
		const neighbors = [];
		for (const source of importSources(fs.readFileSync(path.join(CONTRACTS_DIR, name), 'utf8'))) {
			if (!source.startsWith('./')) continue;
			const target = source.slice(2);
			assert.ok(ALLOWED[name].includes(target), `${name} -> ${target}`);
			neighbors.push(target);
		}
		graph.set(name, neighbors);
	}
	const seen = new Set();
	const stack = new Set();
	const visit = (name) => {
		if (stack.has(name)) assert.fail(`cycle at ${name}`);
		if (seen.has(name)) return;
		stack.add(name);
		for (const next of graph.get(name) ?? []) visit(next);
		stack.delete(name);
		seen.add(name);
	};
	for (const name of graph.keys()) visit(name);
});

test('@ac AC-02 @case AC-02.4 primitives imports only errors and node built-ins', () => {
	const sources = importSources(fs.readFileSync(path.join(CONTRACTS_DIR, 'primitives.ts'), 'utf8'));
	assert.ok(sources.length > 0);
	for (const source of sources) {
		assert.equal(source === '../errors.ts' || source.startsWith('node:'), true, source);
	}
});
