import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './test-support.mjs';
import {
	NAVIGABILITY_BYTE_CEILING,
	NAVIGABILITY_LINE_CEILING,
} from './navigability-support.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_STANDALONE = !fs.existsSync(path.join(PACKAGE_ROOT, 'packages/engine'));
const ROOT = IS_STANDALONE ? PACKAGE_ROOT : path.resolve(PACKAGE_ROOT, '../../..');
const SDLC = IS_STANDALONE ? PACKAGE_ROOT : path.join(ROOT, 'packages/engine');

function resolveRepo(rel) {
	if (fs.existsSync(path.join(ROOT, rel))) return path.join(ROOT, rel);
	return path.join(SDLC, rel.replace(/^packages\/engine\//, ''));
}

const NODE_IDS = [
	"check_completeness",
	"prepare_model_request",
	"execute_configured_role",
	"apply_model_patch",
	"prepare_questions",
	"ask_questions",
	"apply_answers",
	"execute_spec_critic",
	"prepare_approval",
	"ask_approval",
	"apply_approval",
	"prepare_authorization",
	"ask_authorization",
	"apply_authorization",
	"plan_tasks",
	"evaluate_policy_gate",
	"execute_plan_critic",
	"ask_plan_critic",
	"apply_plan_critic",
	"prepare_workspace",
	"hydrate_workspace",
	"execute_tasks",
	"reconcile_integration",
	"ask_reconciliation_conflict",
	"apply_reconciliation_conflict",
	"snapshot_generation",
	"execute_reviewer",
	"execute_verifier",
	"execute_qa_critic",
	"create_local_commit",
	"verify_committed_tree",
	"repair_failure",
	"finalize_run"
];

const PRODUCTION_SCOPE = [
	'packages/engine/workflow/graph.ts',
	'packages/engine/workflow/graph-topology.ts',
	'packages/engine/workflow/node-helpers.ts',
	'packages/engine/workflow/preflight-gate.ts',
	'packages/engine/workflow/specification.ts',
	'packages/engine/workflow/acceptance-criteria.ts',
	...fs.readdirSync(resolveRepo('packages/engine/workflow/nodes'))
		.filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts'))
		.sort()
		.map((name) => `packages/engine/workflow/nodes/${name}`),
];

const SPEC_SCOPE = [
	'packages/engine/workflow/graph.spec.mjs',
	'packages/engine/workflow/graph-approval.spec.mjs',
	'packages/engine/workflow/graph-slice2.spec.mjs',
	'packages/engine/workflow/graph-slice3.spec.mjs',
	'packages/engine/workflow/graph-slice4.spec.mjs',
	'packages/engine/workflow/graph-plan-critic.spec.mjs',
	'packages/engine/workflow/graph-reconciliation.spec.mjs',
	'packages/engine/workflow/graph-qa-advisory.spec.mjs',
	'packages/engine/workflow/specification.spec.mjs',
	'packages/engine/workflow/reconciliation.spec.mjs',
	'packages/engine/workflow/reconciliation-guards.spec.mjs',
	'packages/engine/workflow/acceptance-criteria.spec.mjs',
	'packages/engine/workflow/node-helpers.spec.mjs',
	'packages/engine/workflow/preflight-gate.spec.mjs',
	'packages/engine/workflow/graph-topology.spec.mjs',
	'packages/engine/testing/deepen-workflow.spec.mjs',
	...fs.readdirSync(resolveRepo('packages/engine/workflow/nodes'))
		.filter((name) => name.endsWith('.spec.mjs'))
		.sort()
		.map((name) => `packages/engine/workflow/nodes/${name}`),
];

const MOVED_HELPERS = [
	'buildTaskPromptContexts',
	'readBoundTaskManifest',
	'advanceAfterGreenPreflight',
	'executePreflightForSnapshot',
	'resolvePreflightWorktree',
	'shouldDeferGitMaterialization',
	'getAndValidateAuthorization',
	'deferUnavailableCritic',
	'collectQaBriefAndAdvisories',
	'applyAcCoverageGate',
];

const ACCEPTANCE_NAMES = [
	'parseAcceptanceCriterion',
	'evaluateAcceptanceCriteriaQuality',
	'freezeAcQuality',
	'buildAcceptanceCriteriaGrammarQuestion',
	'AMBIGUOUS',
	'ACCEPTANCE_CRITERIA_GRAMMAR_QUESTION_ID',
	'AC_GRAMMAR',
	'AC_CASE_GRAMMAR',
];

const SPECIFICATION_EXPORTS = [
	'evaluateCompleteness',
	'applyPatch',
	'applyAnswers',
	'validateProposalCompatibility',
	'renderSpecification',
	'parseSpecification',
	'specificationHash',
	'approvedInputHash',
	'parseTaskManifest',
	'taskManifestHash',
	'completenessHash',
	'createApprovalBinding',
	'assertDraftFields',
];

function readRepo(rel) {
	return fs.readFileSync(resolveRepo(rel), 'utf8');
}

function measure(rel) {
	const data = fs.readFileSync(resolveRepo(rel));
	let lines = 0;
	for (const byte of data) if (byte === 0x0a) lines += 1;
	return { lines, bytes: data.length };
}

function exportNames(source) {
	const names = [];
	for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|class|const)\s+([A-Za-z0-9_]+)/gm)) {
		names.push(match[1]);
	}
	for (const match of source.matchAll(/^export\s*\{([^}]+)\}/gm)) {
		for (const part of match[1].split(',')) {
			const local = part.trim().split(/\s+as\s+/).at(-1)?.trim();
			if (local) names.push(local);
		}
	}
	return names;
}

function namedImports(source) {
	const found = [];
	const pattern = /import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g;
	for (const match of source.matchAll(pattern)) {
		const names = match[1].split(',').map((part) => part.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
		found.push({ names, from: match[2] });
	}
	return found;
}

function walkFiles(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkFiles(full, out);
		else out.push(full);
	}
	return out;
}

test('@ac AC-04 @case AC-04.1 graph.mjs exports only SdlcWorkflowRuntime', () => {
	assert.deepEqual(exportNames(readRepo('packages/engine/workflow/graph.ts')), ['SdlcWorkflowRuntime']);
});

test('@ac AC-04 @case AC-04.2 addNode binds the frozen ids to node factories', () => {
	const source = readRepo('packages/engine/workflow/graph.ts');
	const ids = [];
	for (const match of source.matchAll(/\.addNode\('([a-z0-9_]+)',\s*([A-Za-z0-9_]+)\(runtime\)\)/g)) {
		ids.push(match[1]);
		const imported = namedImports(source).some((entry) => entry.names.includes(match[2]) && entry.from.startsWith('./nodes/'));
		assert.equal(imported, true, match[2]);
	}
	assert.deepEqual(ids, NODE_IDS);
});

test('@ac AC-04 @case AC-04.3 graph.mjs holds no route function or edge call', () => {
	const source = readRepo('packages/engine/workflow/graph.ts');
	assert.equal(source.includes('function route'), false);
	assert.equal(source.includes('addConditionalEdges'), false);
	assert.equal(source.includes('addEdge'), false);
});

test('@ac AC-04 @case AC-04.4 a runtime graph exposes the 33 nodes plus __start__', () => {
	const fixture = makeFixture('deepen-compiled-graph');
	try {
		assert.deepEqual(
			Object.keys(fixture.runtime.graph.nodes).sort(),
			[...NODE_IDS, '__start__'].sort(),
		);
	} finally {
		fixture.close();
	}
});

test('@ac AC-05 @case AC-05.1 node files do not import the graph, the topology, or each other', () => {
	const dir = resolveRepo('packages/engine/workflow/nodes');
	const files = fs.readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts'));
	assert.ok(files.length >= 11);
	for (const file of files) {
		for (const entry of namedImports(readRepo(`packages/engine/workflow/nodes/${file}`))) {
			assert.equal(entry.from.endsWith('/graph.ts') || entry.from.endsWith('/graph-topology.ts'), false, file);
			assert.equal(entry.from.includes('/nodes/'), false, `${file} -> ${entry.from}`);
		}
		const raw = readRepo(`packages/engine/workflow/nodes/${file}`);
		assert.equal(/from\s+['"][^'"]*graph\.ts['"]/.test(raw), false, file);
		assert.equal(/from\s+['"][^'"]*graph-topology\.ts['"]/.test(raw), false, file);
		assert.equal(/from\s+['"]\.\/[^'"]+['"]/.test(raw), false, file);
	}
});

test('@ac AC-05 @case AC-05.2 collaborators do not import graph.mjs', () => {
	for (const rel of [
		'packages/engine/workflow/node-helpers.ts',
		'packages/engine/workflow/preflight-gate.ts',
		'packages/engine/workflow/graph-topology.ts',
	]) {
		assert.equal(/from\s+['"][^'"]*graph\.ts['"]/.test(readRepo(rel)), false, rel);
	}
});

test('@ac AC-05 @case AC-05.3 finish-run has no repair loop and the repair owner is gone', () => {
	const finish = readRepo('packages/engine/workflow/nodes/finish-run.ts');
	assert.equal(finish.includes('executeRepair' + 'Loop'), false);
	assert.equal(finish.includes("'" + 'repairer' + "'"), false);
	const needle = 'selectRepair' + 'OwningTask';
	const hits = walkFiles(SDLC).filter((file) =>
		fs.readFileSync(file, 'utf8').includes(needle));
	assert.deepEqual(hits, []);
});

test('@ac AC-05 @case AC-05.4 specification.mjs keeps the frozen non-grammar exports', () => {
	assert.deepEqual(exportNames(readRepo('packages/engine/workflow/specification.ts')), SPECIFICATION_EXPORTS);
});

test('@ac AC-05 @case AC-05.5 moved names are not imported from their former modules', () => {
	const files = [
		...(IS_STANDALONE ? [] : walkFiles(path.join(ROOT, 'tools'))),
		...walkFiles(SDLC),
	].filter((file) => file.endsWith('.mjs') || file.endsWith('.ts'));
	assert.ok(files.length > 10);
	for (const file of files) {
		for (const entry of namedImports(fs.readFileSync(file, 'utf8'))) {
			if (entry.from.endsWith('/specification.ts') || entry.from.endsWith('/specification.mjs')) {
				const hit = entry.names.find((name) => ACCEPTANCE_NAMES.includes(name));
				assert.equal(hit, undefined, `${file} imports ${hit} from specification`);
			}
			if (entry.from.endsWith('/graph.ts') || entry.from.endsWith('/graph.mjs')) {
				const hit = entry.names.find((name) => MOVED_HELPERS.includes(name));
				assert.equal(hit, undefined, `${file} imports ${hit} from graph`);
			}
		}
	}
});

test('@ac AC-06 @case AC-06.1 production scope files are within the ceiling', () => {
	assert.ok(PRODUCTION_SCOPE.length >= 17);
	for (const rel of PRODUCTION_SCOPE) {
		const size = measure(rel);
		assert.ok(size.lines <= NAVIGABILITY_LINE_CEILING, `${rel} lines ${size.lines}`);
		assert.ok(size.bytes <= NAVIGABILITY_BYTE_CEILING, `${rel} bytes ${size.bytes}`);
	}
});

test('@ac AC-06 @case AC-06.2 spec scope files are within the ceiling', () => {
	assert.ok(SPEC_SCOPE.length >= 20);
	for (const rel of SPEC_SCOPE) {
		const size = measure(rel);
		assert.ok(size.lines <= NAVIGABILITY_LINE_CEILING, `${rel} lines ${size.lines}`);
		assert.ok(size.bytes <= NAVIGABILITY_BYTE_CEILING, `${rel} bytes ${size.bytes}`);
	}
});

test('@ac AC-06 @case AC-06.3 scope paths are absent from the exceptions file', () => {
	const exceptions = JSON.parse(readRepo('packages/engine/testing/navigability-exceptions.json'));
	for (const rel of [...PRODUCTION_SCOPE, ...SPEC_SCOPE]) {
		assert.equal(Object.hasOwn(exceptions, rel), false, rel);
	}
});
