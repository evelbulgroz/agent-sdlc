import assert from 'node:assert/strict';
import { FIXTURE_MONOREPO_ROOT } from '../testing/fixture-monorepo-root.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ArtifactStore } from '../persistence/artifacts.ts';
import { SdlcWorkflowRuntime } from '../workflow/graph.ts';
import { isDeterministicRole, PACKAGE_ROLE_DEFAULTS_ROOT, RoleRegistry } from './role-registry.ts';
import { getCapability, hasCapability } from './capability-registry.ts';
import { getEvaluator } from '../review/evaluator-registry.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { FakeModelGovernor } from '../testing/fake-model-governor.mjs';
import { completeProposal } from '../testing/test-support.mjs';

test('@ac AC-02 @case AC-02.1 loads and hashes configured workflow, role, prompt, capability, and evaluator from PACKAGE_ROLE_DEFAULTS_ROOT with Layer 3 addenda', () => {
	const registry = new RoleRegistry({ rootDir: FIXTURE_MONOREPO_ROOT });
	assert.equal(registry.workflowRoot, PACKAGE_ROLE_DEFAULTS_ROOT);
	assert.equal(registry.workflowRoot, path.dirname(registry.workflowPath));
	const loaded = registry.load();
	assert.equal(loaded.workflow.workflowId, 'specification');
	assert.equal(loaded.workflow.roleId, loaded.role.roleId);
	for (const hash of Object.values(loaded.hashes)) assert.match(hash, /^[a-f0-9]{64}$/);
	const imp = registry.loadRole('implementer');
	assert.ok(imp.promptPolicy.includes('# Implementer policy'));
	assert.match(imp.promptPolicy, /UI -> application use case -> port -> gateway adapter/i);
});

function withWorkflowFixture({ workflowOverrides = {}, roleOverrides = {} }, fn) {
	const root = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `registry-${crypto.randomUUID()}`);
	const workflowRoot = path.join(root, '.agents/workflows');
	fs.mkdirSync(path.join(workflowRoot, 'roles'), { recursive: true });
	fs.mkdirSync(path.join(workflowRoot, 'prompts'), { recursive: true });
	const source = new RoleRegistry({ rootDir: REPOSITORY_ROOT }).load();
	const role = { ...source.role, ...roleOverrides };
	const workflow = { ...source.workflow, roleId: role.roleId, ...workflowOverrides };
	fs.writeFileSync(path.join(workflowRoot, 'specification.json'), JSON.stringify(workflow));
	fs.writeFileSync(path.join(workflowRoot, 'roles', `${role.roleId}.json`), JSON.stringify(role));
	fs.writeFileSync(path.join(workflowRoot, 'prompts', role.promptFile), source.promptPolicy);
	return Promise.resolve(fn({ root, workflowRoot, source })).finally(() =>
		fs.rmSync(root, { recursive: true, force: true }),
	);
}

test('renamed configured role loads without executable dispatch changes', async () => {
	const renamed = 'synthetic-author';
	await withWorkflowFixture(
		{ roleOverrides: { roleId: renamed, promptFile: `${renamed}.md` } },
		async ({ root }) => {
			const registry = new RoleRegistry({ rootDir: root });
			const loaded = registry.load();
			assert.equal(loaded.role.roleId, renamed);
			const runtimeDir = path.join(root, 'runtime');
			fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
			const store = new RuntimeStore(path.join(runtimeDir, 'runtime.sqlite'));
			const artifacts = new ArtifactStore({
				artifactsDir: path.join(runtimeDir, 'artifacts'),
				runtimeStore: store,
				maxArtifactBytes: loaded.workflow.limits.maxArtifactBytes,
			});
			const governor = new FakeModelGovernor([completeProposal()]);
			const runtime = new SdlcWorkflowRuntime({
				runtimeStore: store,
				artifactStore: artifacts,
				registry,
				governor,
			});
			try {
				const initial = runtime.initialize({
					runId: '2026-09-04-renamed-role',
					goal: 'Exercise renamed role end-to-end',
				});
				const state = await runtime.start(initial);
				assert.equal(governor.calls.length, 1);
				assert.equal(governor.calls[0].attribution.roleId, renamed);
				assert.equal(state.state, 'WAITING_FOR_ANSWERS');
				assert.ok(state.pendingInterruptId);
			} finally {
				store.close();
			}
		},
	);
});

test('rejects unknown capabilities, executable fields, and prompt escapes', () =>
	withWorkflowFixture({ roleOverrides: { capabilityId: 'unknown' } }, ({ root, workflowRoot, source }) => {
		assert.throws(() => new RoleRegistry({ rootDir: root }).load(), /Unknown capability/);
		fs.writeFileSync(
			path.join(workflowRoot, 'roles', `${source.role.roleId}.json`),
			JSON.stringify({ ...source.role, command: 'echo unsafe' }),
		);
		assert.throws(() => new RoleRegistry({ rootDir: root }).load(), /forbidden/);
	}));

test('@ac AC-03 @case AC-03.1 loads active built-in roles with matching capabilities and evaluators', () => {
	const registry = new RoleRegistry({ rootDir: REPOSITORY_ROOT });
	const specifier = registry.loadRole('specifier');
	assert.equal(specifier.role.roleId, 'specifier');
	assert.equal(specifier.role.capabilityId, 'governed-structured-synthesis-v1');
	assert.equal(specifier.role.evaluatorId, 'specification-proposal-v1');

	const implementer = registry.loadRole('implementer');
	assert.equal(implementer.role.roleId, 'implementer');
	assert.equal(implementer.role.capabilityId, 'lean-tool-loop-v1');
	assert.equal(implementer.role.evaluatorId, 'implementer-action-v1');
	assert.equal(hasCapability('lean-tool-loop-v1'), true);
	const lean = getCapability('lean-tool-loop-v1');
	assert.equal(lean.id, 'lean-tool-loop-v1');
	assert.equal(typeof lean.buildPrompt, 'undefined');
	assert.equal(Object.hasOwn(lean, 'structuredOutputSchema'), false);

	const reviewer = registry.loadRole('reviewer');
	assert.equal(reviewer.role.roleId, 'reviewer');
	assert.equal(reviewer.role.capabilityId, 'semantic-review-v1');
	assert.equal(reviewer.role.evaluatorId, 'review-rubric-v1');
	assert.equal(reviewer.role.requestedLimits.maxCompletionTokens, 16000);

	const critic = registry.loadRole('critic-reviewer');
	assert.equal(critic.role.roleId, 'critic-reviewer');
	assert.equal(critic.role.capabilityId, 'semantic-review-v1');
	assert.equal(critic.role.evaluatorId, 'review-rubric-v1');
	assert.equal(critic.role.insertionPoint, 'review');
	assert.equal(isDeterministicRole(critic), false);
	assert.equal(critic.role.modelProfile, 'critic-review');
});

test('@ac AC-03 @case AC-03.1 loads specification workflow definition via RoleRegistry fallback', () => {
	const registry = new RoleRegistry({
		rootDir: REPOSITORY_ROOT,
		workflowPath: 'specification.json',
	});
	assert.equal(registry.workflowRoot, PACKAGE_ROLE_DEFAULTS_ROOT);
	const loaded = registry.load();
	assert.equal(loaded.workflow.workflowId, 'specification');
	assert.equal(loaded.workflow.roleId, 'specifier');
});

test('isDeterministicRole correctly classifies roles', () => {
	assert.equal(isDeterministicRole({ modelProfile: 'agent-sdlc-deterministic' }), true);
	assert.equal(isDeterministicRole({ role: { modelProfile: 'agent-sdlc-deterministic' } }), true);
	assert.equal(isDeterministicRole({ modelProfile: 'agent-sdlc-default' }), false);
	assert.equal(isDeterministicRole(null), false);
	assert.equal(isDeterministicRole(undefined), false);
});

test('loadPipeline returns empty array for workflow without pipelines', () => {
	const registry = new RoleRegistry({ rootDir: REPOSITORY_ROOT });
	const pipeline = registry.loadPipeline('post_implement');
	assert.deepEqual(pipeline, []);
});

test('loadPipeline rejects invalid insertion point', () => {
	const registry = new RoleRegistry({ rootDir: REPOSITORY_ROOT });
	assert.throws(() => registry.loadPipeline('invalid_point'), /Invalid insertion point/);
});

test('pipeline loading rejects duplicate roles across pipelines', () =>
	withWorkflowFixture(
		{ workflowOverrides: { roles: ['specifier'], pipelines: { post_implement: ['specifier'], review: ['specifier'] } } },
		({ root }) => {
			assert.throws(() => new RoleRegistry({ rootDir: root }).loadPipeline('post_implement'), /Duplicate role/);
		},
	));

test('pipeline loading rejects role placed in wrong insertion point', () =>
	withWorkflowFixture(
		{
			workflowOverrides: { roles: ['specifier'], pipelines: { review: ['specifier'] } },
			roleOverrides: { insertionPoint: 'post_implement' },
		},
		({ root }) => {
			assert.throws(() => new RoleRegistry({ rootDir: root }).loadPipeline('review'), /does not match pipeline/);
		},
	));

test('rejects deterministic role with non-zero token limits', () =>
	withWorkflowFixture(
		{
			roleOverrides: {
				modelProfile: 'agent-sdlc-deterministic',
				requestedLimits: { maxPromptTokens: 100, maxCompletionTokens: 0 },
			},
		},
		({ root }) => {
			assert.throws(() => new RoleRegistry({ rootDir: root }).load(), /zero token limits/i);
		},
	));

test('@ac AC-02 @case AC-02.2 @ac AC-03 @case AC-03.1 @case AC-03.2 loads fixture-configured optional pipeline roles and verifies post_implement and pre_review pipelines', () => {
	const root = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `reg-pipeline-${crypto.randomUUID()}`);
	const workflowRoot = path.join(root, '.agents/workflows');
	fs.mkdirSync(path.join(workflowRoot, 'roles'), { recursive: true });
	fs.mkdirSync(path.join(workflowRoot, 'prompts'), { recursive: true });
	const baseWorkflow = new RoleRegistry({ rootDir: REPOSITORY_ROOT }).loadWorkflow();
	try {
		const extendedRoles = [
			{
				roleId: 'cleaner',
				roleKind: 'mutation',
				insertionPoint: 'post_implement',
				capabilityId: 'cleaner-tool-loop-v1',
				evaluatorId: 'cleaner-result-v1',
				promptFile: 'cleaner.md',
			},
			{
				roleId: 'hardener',
				roleKind: 'mutation',
				insertionPoint: 'post_implement',
				capabilityId: 'hardener-tool-loop-v1',
				evaluatorId: 'hardener-action-v1',
				promptFile: 'hardener.md',
			},
			{
				roleId: 'architect',
				roleKind: 'review',
				insertionPoint: 'pre_review',
				capabilityId: 'architect-analysis-v1',
				evaluatorId: 'architect-evaluation-v1',
				promptFile: 'architect.md',
			},
		];
		for (const item of extendedRoles) {
			fs.writeFileSync(
				path.join(workflowRoot, 'roles', `${item.roleId}.json`),
				JSON.stringify({
					schemaVersion: '1.0.0',
					roleId: item.roleId,
					roleKind: item.roleKind,
					insertionPoint: item.insertionPoint,
					modelProfile: 'agent-sdlc-deterministic',
					promptFile: item.promptFile,
					capabilityId: item.capabilityId,
					evaluatorId: item.evaluatorId,
					requestedLimits: {
						maxPromptTokens: 0,
						maxCompletionTokens: 0,
						timeoutMs: 60000,
						maxPhysicalAttempts: 1,
						maxRetriesPerRoute: 0,
						maxFailovers: 0,
					},
				}),
			);
			fs.writeFileSync(
				path.join(workflowRoot, 'prompts', item.promptFile),
				`# ${item.roleId} policy\n`,
			);
		}
		const workflowPath = path.join(workflowRoot, 'custom-extended.json');
		fs.writeFileSync(
			workflowPath,
			JSON.stringify({
				...baseWorkflow,
				workflowId: 'custom-extended',
				roles: ['specifier', 'implementer', 'cleaner', 'hardener', 'architect', 'reviewer', 'critic-reviewer'],
				pipelines: {
					post_implement: ['cleaner', 'hardener'],
					pre_review: ['architect'],
					review: [],
				},
			}),
		);

		const registry = new RoleRegistry({ rootDir: root, workflowPath });
		const workflow = registry.loadWorkflow();
		assert.equal(workflow.workflowId, 'custom-extended');

		const postImplement = registry.loadPipeline('post_implement');
		assert.equal(postImplement.length, 2);
		assert.equal(postImplement[0].role.roleId, 'cleaner');
		assert.equal(isDeterministicRole(postImplement[0]), true);
		assert.equal(postImplement[1].role.roleId, 'hardener');
		assert.equal(isDeterministicRole(postImplement[1]), true);

		const preReview = registry.loadPipeline('pre_review');
		assert.equal(preReview.length, 1);
		assert.equal(preReview[0].role.roleId, 'architect');
		assert.equal(isDeterministicRole(preReview[0]), true);

		const review = registry.loadPipeline('review');
		assert.equal(review.length, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('cleaner evaluator validates hygiene and rejects functional diffs', () => {
	const evaluator = getEvaluator('cleaner-result-v1');
	const clean = evaluator.evaluate({
		status: 'CLEANED',
		cleanedFiles: ['tools/agent-sdlc/foo.mjs'],
		hygieneOperations: ['removed-unused-imports', 'trimmed-whitespace'],
	});
	assert.equal(clean.status, 'CLEANED');
	assert.deepEqual(clean.cleanedFiles, ['tools/agent-sdlc/foo.mjs']);

	assert.throws(
		() =>
			evaluator.evaluate({
				status: 'CLEANED',
				cleanedFiles: ['tools/agent-sdlc/foo.mjs'],
				functionalDiffsDetected: true,
			}),
		/functional production logic diffs/,
	);
});

test('hardener evaluator validates test additions and shadow path coverage', () => {
	const evaluator = getEvaluator('hardener-action-v1');
	const res = evaluator.evaluate({
		status: 'HARDENED',
		testsAdded: ['tools/agent-sdlc/foo.spec.mjs'],
		shadowPathsCovered: ['unhappy', 'boundary', 'timeout'],
	});
	assert.equal(res.status, 'HARDENED');
	assert.deepEqual(res.testsAdded, ['tools/agent-sdlc/foo.spec.mjs']);
	assert.deepEqual(res.shadowPathsCovered, ['unhappy', 'boundary', 'timeout']);
});

test('architect evaluator validates boundary analysis and detects P1 violations', () => {
	const evaluator = getEvaluator('architect-evaluation-v1');
	const passing = evaluator.evaluate({
		status: 'PASS',
		violations: [],
	});
	assert.equal(passing.status, 'PASS');
	assert.equal(passing.hasViolations, false);
	assert.equal(passing.hasP1, false);

	const violation = evaluator.evaluate({
		status: 'VIOLATIONS_DETECTED',
		violations: [
			{
				boundary: 'bounded-context',
				file: 'apps/services/conditioning/src/foo.ts',
				description: 'Cross-service deep import into registry',
				severity: 'P1',
			},
		],
	});
	assert.equal(violation.status, 'VIOLATIONS_DETECTED');
	assert.equal(violation.hasViolations, true);
	assert.equal(violation.hasP1, true);
});

function makeStandaloneHostProfile(prompts) {
	return {
		schemaVersion: '1.2.0',
		profileId: 'standalone-host',
		repositoryId: 'standalone-host',
		adapter: 'script',
		stateDir: 'tools/.agent-sdlc',
		reviewDir: 'tools/.review',
		specDraftDir: 'docs/specs/drafts',
		verify: {
			argv: ['node', 'verify.mjs', '{baseSha}'],
			resultPath: 'tools/.verify/last.json',
			headField: 'head',
			require: { status: 'OK', canonical: true },
		},
		commands: [['node', '--test']],
		hydration: [],
		workspace: { directories: ['.'] },
		...(prompts ? { prompts } : {}),
	};
}

test('@ac AC-02 @case AC-02.1 @case AC-02.2 @case AC-02.3 @ac AC-03 @case AC-03.1 RoleRegistry composes 3-layer prompts and supports preset none in standalone workspace', () => {
	const root = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `reg-standalone-${crypto.randomUUID()}`);
	fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
	fs.writeFileSync(path.join(root, '.agents/sdlc-host.json'), JSON.stringify(makeStandaloneHostProfile()));
	try {
		const registry = new RoleRegistry({ rootDir: root });
		for (const roleId of ['specifier', 'implementer', 'reviewer', 'critic-reviewer']) {
			const loaded = registry.loadRole(roleId);
			assert.equal(loaded.role.roleId, roleId);
			assert.match(loaded.hashes.promptPolicyHash, /^[a-f0-9]{64}$/);
		}
		const imp = registry.loadRole('implementer');
		assert.ok(imp.promptPolicy.includes('# Implementer policy'));
		assert.ok(imp.promptPolicy.includes('### Engineering Philosophy'));

		fs.mkdirSync(path.join(root, '.agents/workflows/prompts'), { recursive: true });
		fs.writeFileSync(path.join(root, '.agents/sdlc-host.json'), JSON.stringify(makeStandaloneHostProfile({ preset: 'none' })));
		fs.writeFileSync(path.join(root, '.agents/workflows/prompts/implementer.md'), '# Custom Host Addendum\n');
		const impNone = new RoleRegistry({ rootDir: root }).loadRole('implementer');
		assert.ok(impNone.promptPolicy.includes('# Implementer policy'));
		assert.equal(impNone.promptPolicy.includes('### Engineering Philosophy'), false);
		assert.ok(impNone.promptPolicy.includes('# Custom Host Addendum'));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.1 @case AC-03.2 @case AC-03.3 @case AC-03.4 pathScopedRules attach matching addenda and reject missing or executable files', () => {
	const registry = new RoleRegistry({ rootDir: FIXTURE_MONOREPO_ROOT });
	const pwaImp = registry.loadRole('implementer', { authoredPaths: ['apps/frontends/example-pwa-frontend/src/App.tsx'] });
	assert.ok(pwaImp.promptPolicy.includes('Path-Scoped Rules: Frontend PWA'));
	assert.equal(pwaImp.promptPolicy.includes('Path-Scoped Rules: Backend Services'), false);

	const backendImp = registry.loadRole('implementer', { authoredPaths: ['apps/services/conditioning/src/main.ts'] });
	assert.ok(backendImp.promptPolicy.includes('Path-Scoped Rules: Backend Services'));
	assert.equal(backendImp.promptPolicy.includes('Path-Scoped Rules: Frontend PWA'), false);

	const criticPwa = registry.loadRole('critic-reviewer', { authoredPaths: ['apps/frontends/example-pwa-frontend/src/App.tsx'] });
	assert.equal(criticPwa.promptPolicy.includes('Path-Scoped Rules: Frontend PWA'), false);

	const root = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', `reg-scoped-inv-${crypto.randomUUID()}`);
	fs.mkdirSync(path.join(root, '.agents/workflows/scoped'), { recursive: true });
	try {
		const badRule = [{ id: 'missing-rule', pathPrefixes: ['src/ui'], addendaFile: '.agents/workflows/scoped/missing.md' }];
		fs.writeFileSync(path.join(root, '.agents/sdlc-host.json'), JSON.stringify(makeStandaloneHostProfile({ pathScopedRules: badRule })));
		assert.throws(() => new RoleRegistry({ rootDir: root }).loadRole('implementer'), (err) => err.code === 'INVALID_CONTRACT');
		fs.writeFileSync(path.join(root, '.agents/workflows/scoped/missing.md'), '# Bad Rule\n```bash\nrm -rf /\n```\n');
		assert.throws(() => new RoleRegistry({ rootDir: root }).loadRole('implementer'), (err) => err.code === 'INVALID_CONTRACT' && /executable/.test(err.message));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.1 @case AC-01.2 redundant workflow and role JSONs are absent from .agents/workflows while Layer 3 addenda remain intact', () => {
	for (const rel of [
		'.agents/workflows/specification.json',
		'.agents/workflows/sdlc-extended-roles.json',
		'.agents/workflows/sdlc-single-worktree.json',
		'.agents/workflows/roles',
	]) {
		assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, rel)), false, `${rel} must be absent`);
	}
	for (const rel of [
		'.agents/workflows/prompts/implementer.md',
	]) {
		assert.equal(fs.existsSync(path.join(REPOSITORY_ROOT, rel)), true, `${rel} must exist`);
	}
});

test('@ac AC-04 @case AC-04.1 @case AC-04.2 roles and workflows READMEs document defaults fallback and built-in role inventory', () => {
	const promptsReadme = fs.readFileSync(path.join(REPOSITORY_ROOT, 'prompts/README.md'), 'utf8');
	assert.match(promptsReadme, /roles\/defaults\/protocol\//);
	const rolesReadme = fs.readFileSync(path.join(REPOSITORY_ROOT, 'roles/README.md'), 'utf8');
	assert.match(rolesReadme, /roles\/defaults\//);
	assert.match(rolesReadme, /\.agents\/workflows\/roles\/\*\.json/);
	for (const token of ['specification.json', 'specifier', 'implementer', 'reviewer', 'critic-reviewer']) {
		assert.equal(rolesReadme.includes(token), true, `roles/README.md must include ${token}`);
	}
	assert.equal(rolesReadme.includes('sdlc-extended-roles.json'), false);
	assert.equal(rolesReadme.includes('sdlc-single-worktree.json'), false);
	const workflowsReadme = fs.readFileSync(path.join(REPOSITORY_ROOT, '.agents/workflows/README.md'), 'utf8');
	assert.match(workflowsReadme, /prompts\//);
	assert.match(workflowsReadme, /pathScopedRules/);
	assert.equal(/├──\s+roles\//.test(workflowsReadme), false);
	assert.match(workflowsReadme, /\.\.\/\.\.\/roles\/README\.md/);
	assert.match(workflowsReadme, /\.\.\/\.\.\/prompts\/README\.md/);
});
