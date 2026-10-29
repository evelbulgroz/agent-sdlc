import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAuthoritativeInputSafe } from '../persistence/artifacts.ts';
import { emptyDraft } from '../policy/contracts.ts';
import { evaluateAcceptanceCriteriaQuality } from './acceptance-criteria.ts';
import {
	approvedInputHash,
	applyAnswers,
	applyPatch,
	createApprovalBinding,
	evaluateCompleteness,
	parseSpecification,
	parseTaskManifest,
	renderSpecification,
	specificationHash,
	taskManifestHash,
	validateProposalCompatibility,
} from './specification.ts';

const GRAMMAR_AC =
	'AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.';

function completeDraftExcept(overrides = {}) {
	const draft = emptyDraft('Build the workflow');
	const patch = [
		{ field: 'nonGoals', operation: 'set', value: ['No code execution'] },
		{ field: 'owningContext', operation: 'set', value: 'Tooling' },
		{ field: 'touchedSurfaces', operation: 'set', value: ['tools/workflow.mjs'] },
		{ field: 'invariantsAndConstraints', operation: 'set', value: ['Fail closed'] },
		{ field: 'publicContractImpact', operation: 'set', value: 'None' },
		{ field: 'acceptanceCriteria', operation: 'set', value: ['One outcome'] },
		{ field: 'failureDefenses', operation: 'set', value: ['Reject stale answer'] },
		{ field: 'verificationPlan', operation: 'set', value: ['Run tests'] },
	].filter((operation) => !Object.hasOwn(overrides, operation.field));
	for (const [field, value] of Object.entries(overrides)) {
		if (value !== null && value !== undefined && (!Array.isArray(value) || value.length > 0)) {
			patch.push({
				field,
				operation: 'set',
				value,
			});
		}
	}
	return applyPatch(draft, patch);
}

test('completeness reports exact missing and ambiguous fields', () => {
	const draft = emptyDraft('Build the workflow');
	const incomplete = evaluateCompleteness(draft);
	assert.equal(incomplete.complete, false);
	assert.deepEqual(incomplete.missingFields, [
		'owningContext',
		'touchedSurfaces',
		'acceptanceCriteria',
		'invariantsAndConstraints',
		'nonGoals',
		'publicContractImpact',
		'failureDefenses',
		'verificationPlan',
	]);
	const ambiguous = applyPatch(draft, [{ field: 'nonGoals', operation: 'set', value: ['TBD'] }]);
	assert.ok(evaluateCompleteness(ambiguous).ambiguousFields.includes('nonGoals'));
});

test('patches and answers update only allowlisted fields', () => {
	const draft = emptyDraft('Build the workflow');
	const patched = applyPatch(draft, [
		{ field: 'owningContext', operation: 'set', value: 'Tooling' },
		{ field: 'acceptanceCriteria', operation: 'append', value: 'One outcome' },
	]);
	assert.equal(patched.owningContext, 'Tooling');
	assert.deepEqual(patched.acceptanceCriteria, ['One outcome']);
	assert.throws(
		() => applyPatch(draft, [{ field: 'approvedSpecHash', operation: 'set', value: 'x' }]),
		/allowlisted/,
	);
	const answered = applyAnswers(
		draft,
		{
			questions: [
				{
					questionId: 'q',
					targets: ['acceptanceCriteria', 'failureDefenses'],
				},
			],
		},
		{ answers: [{ questionId: 'q', value: 'Fail closed' }] },
	);
	assert.deepEqual(answered.acceptanceCriteria, ['Fail closed']);
	assert.deepEqual(answered.failureDefenses, ['Fail closed']);
});

test('rendering and approval hashes are stable and secret-safe', () => {
	let draft = emptyDraft('Build the workflow');
	draft = applyPatch(draft, [
		{ field: 'nonGoals', operation: 'set', value: ['No code execution'] },
		{ field: 'owningContext', operation: 'set', value: 'Tooling' },
		{
			field: 'touchedSurfaces',
			operation: 'set',
			value: ['tools/workflow.mjs'],
		},
		{
			field: 'invariantsAndConstraints',
			operation: 'set',
			value: ['Fail closed'],
		},
		{ field: 'publicContractImpact', operation: 'set', value: 'None' },
		{ field: 'acceptanceCriteria', operation: 'set', value: ['Spec approved'] },
		{
			field: 'failureDefenses',
			operation: 'set',
			value: ['Reject stale answer'],
		},
		{ field: 'verificationPlan', operation: 'set', value: ['Run tests'] },
	]);
	assert.equal(renderSpecification(draft), renderSpecification(structuredClone(draft)));
	assert.equal(specificationHash(draft), specificationHash(structuredClone(draft)));
	const binding = createApprovalBinding({
		runId: '2026-09-04-example',
		draftHash: specificationHash(draft),
		runtimeRevision: 4,
		workflowHash: 'a'.repeat(64),
		roleHash: 'b'.repeat(64),
		promptPolicyHash: 'c'.repeat(64),
		completenessResultHash: 'd'.repeat(64),
		timestamp: '2026-09-04T00:00:00.000Z',
	});
	assert.match(binding.approvalHash, /^[a-f0-9]{64}$/);
	assert.throws(
		() => renderSpecification({ ...draft, goal: `Use ${'sk-'}1234567890abcdef` }),
		/secret pattern/,
	);
	for (const secret of [
		`Authorization: Bearer ${'a'.repeat(24)}`,
		`"token":"${'b'.repeat(24)}"`,
		`AKIA${'C'.repeat(16)}`,
		`${'AI'}${'za'}${'D'.repeat(35)}`,
		`https://user:${'d'.repeat(12)}@example.invalid/path`,
	]) {
		assert.throws(
			() => assertAuthoritativeInputSafe({ ...draft, goal: secret }, 'Draft'),
			/high-risk secret/,
		);
	}
});

test('applyAnswers splits newline-separated answers for standard array targets', () => {
	const draft = emptyDraft('Multi-line answer test');
	const batch = {
		questions: [
			{
				questionId: 'q-ac',
				targets: ['acceptanceCriteria'],
			},
		],
	};
	const answerDoc = {
		answers: [
			{
				questionId: 'q-ac',
				value: `${GRAMMAR_AC}\nAC-02: Second criterion. Given precondition. Then result.`,
			},
		],
	};
	const updated = applyAnswers(draft, batch, answerDoc);
	assert.equal(updated.acceptanceCriteria.length, 2);
	assert.equal(updated.acceptanceCriteria[0], GRAMMAR_AC);
	assert.equal(evaluateAcceptanceCriteriaQuality(updated).complete, true);
});

test('validateProposalCompatibility permits questions targeting fields unresolved in draftInput even if patched', () => {
	const draft = completeDraftExcept({ invariantsAndConstraints: [], nonGoals: [] });
	const proposal = {
		patch: [
			{
				field: 'invariantsAndConstraints',
				operation: 'set',
				value: ['Fail closed on network error'],
			},
			{
				field: 'nonGoals',
				operation: 'set',
				value: ['No external billing integration'],
			},
		],
		questions: [
			{
				questionId: 'q1',
				targets: ['invariantsAndConstraints'],
				prompt: 'Any additional invariants?',
				responseKind: 'text',
				options: [],
				required: true,
				rationale: 'Clarify invariants',
			},
			{
				questionId: 'q2',
				targets: ['nonGoals'],
				prompt: 'Any additional non-goals?',
				responseKind: 'text',
				options: [],
				required: true,
				rationale: 'Clarify non-goals',
			},
		],
	};
	const result = validateProposalCompatibility(draft, proposal);
	assert.equal(result.completeness.complete, true);
	assert.deepEqual(result.revisedDraft.invariantsAndConstraints, ['Fail closed on network error']);
	assert.deepEqual(result.revisedDraft.nonGoals, ['No external billing integration']);
});

test('validateProposalCompatibility rejects questions targeting fields already resolved in draftInput', () => {
	const draft = completeDraftExcept({ invariantsAndConstraints: [] });
	const proposal = {
		patch: [
			{
				field: 'invariantsAndConstraints',
				operation: 'set',
				value: ['Fail closed'],
			},
		],
		questions: [
			{
				questionId: 'q-goal',
				targets: ['goal'],
				prompt: 'What is the goal?',
				responseKind: 'text',
				options: [],
				required: true,
				rationale: 'Goal is already resolved',
			},
		],
	};
	assert.throws(
		() => validateProposalCompatibility(draft, proposal),
		(err) => err.code === 'MODEL_OUTPUT_INVALID' && err.message.includes('goal'),
	);
});

test('parseSpecification roundtrips from renderSpecification markdown', () => {
	const original = completeDraftExcept();
	const markdown = renderSpecification(original);
	const parsed = parseSpecification(markdown);
	assert.deepEqual(parsed, original);
	assert.equal(evaluateCompleteness(parsed).complete, true);
});

test('parseSpecification falls back to emptyDraft for plain goal text', () => {
	const parsed = parseSpecification('Add trendline to heart rate chart');
	assert.equal(parsed.goal, 'Add trendline to heart rate chart');
	assert.deepEqual(parsed.nonGoals, []);
	assert.equal(parsed.owningContext, '');
	assert.equal(evaluateCompleteness(parsed).complete, false);
});

test('parseSpecification parses JSON draft text directly', () => {
	const original = completeDraftExcept();
	const parsed = parseSpecification(JSON.stringify(original));
	assert.deepEqual(parsed, original);
	assert.equal(evaluateCompleteness(parsed).complete, true);
});

test('parseSpecification accepts heading aliases and nested ### subheadings', () => {
	const parsed = parseSpecification(
		[
			'# Intent',
			'',
			'## Goal',
			'',
			'Ship the slice',
			'',
			'### Why this slice',
			'',
			'It is the narrowest wedge.',
			'',
			'## Non goals',
			'',
			'- No deploy',
			'',
			'## Owning context',
			'',
			'Tooling',
			'',
			'## Touched surfaces',
			'',
			'- tools/agent-sdlc/workflow/specification.mjs',
			'',
			'## Invariants & constraints',
			'',
			'- Fail closed',
			'',
			'## Public contract impact',
			'',
			'None',
			'',
			'## Acceptance criteria',
			'',
			'1. AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.',
			'',
			'## Failure defenses',
			'',
			'- Reject renamed headings',
			'',
			'## Verification plan',
			'',
			'- Run specification.spec.mjs',
			'',
			'## Unresolved questions',
			'',
			'_None_',
			'',
			'## Assumptions',
			'',
			'_None_',
			'',
		].join('\n'),
	);
	assert.match(parsed.goal, /narrowest wedge/);
	assert.deepEqual(parsed.nonGoals, ['No deploy']);
	assert.deepEqual(parsed.invariantsAndConstraints, ['Fail closed']);
	assert.equal(evaluateCompleteness(parsed).complete, true);
});

test('parseSpecification fails closed on unknown ## headings', () => {
	const markdown = [
		'# Intent',
		'',
		'## Goal',
		'',
		'Ship the slice',
		'',
		'## Scope & Owning Context',
		'',
		'Tooling',
		'',
		'## Acceptance Criteria (Observable Outcomes)',
		'',
		'1. AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.',
	].join('\n');
	assert.throws(
		() => parseSpecification(markdown),
		(err) =>
			err.code === 'INVALID_INPUT' &&
			err.message.includes('Scope & Owning Context') &&
			err.message.includes('Acceptance Criteria (Observable Outcomes)') &&
			err.message.includes('Owning context') &&
			err.message.includes('Acceptance criteria'),
	);
});

test('task manifest parsing validates JSON and produces a stable canonical hash', () => {
	const manifest = {
		schemaVersion: '1.0.0',
		slices: [
			{
				sliceId: 'behavior',
				kind: 'vertical',
				goal: 'Deliver behavior',
				acceptanceCriteria: ['AC-01'],
				dependsOn: [],
			},
		],
		tasks: [
			{
				taskId: 'behavior-task',
				sliceId: 'behavior',
				targetPackage: 'tools',
				authoredPaths: ['tools/agent-sdlc/policy/contracts.mjs'],
				pathPrefixes: ['tools/agent-sdlc'],
				generatedOutputs: [],
				dependsOn: [],
				deliveryLayers: ['tooling'],
				dependencyMutations: [],
				shadowPaths: {
					unhappy: 'invalid input',
					timeout: 'deadline exceeded',
					empty: 'no delta',
					boundary: 'scope escape',
				},
				verificationCommand: ['pnpm', 'run', 'test:unit'],
				generatorCommand: null,
			},
		],
	};
	const parsed = parseTaskManifest(JSON.stringify(manifest));
	assert.deepEqual(parsed, manifest);
	assert.equal(taskManifestHash(parsed), taskManifestHash(structuredClone(manifest)));
	assert.throws(() => parseTaskManifest(''), /non-empty JSON text/);
	assert.throws(() => parseTaskManifest('{bad json'), /valid JSON/);
	assert.throws(
		() => parseTaskManifest(JSON.stringify({ ...manifest, extra: true })),
		/unknown field 'extra'/,
	);
	assert.equal(approvedInputHash(completeDraftExcept(), null), specificationHash(completeDraftExcept()));
	assert.notEqual(
		approvedInputHash(completeDraftExcept(), taskManifestHash(manifest)),
		specificationHash(completeDraftExcept()),
	);
});
