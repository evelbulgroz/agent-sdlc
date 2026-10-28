import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runDeterministicArchitect } from '../execution/pipeline-deterministic-roles.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { scanWorkspacePackages } from '../policy/task-planner/workspace-packages.ts';
import { CriticReviewAdapter } from '../review/critic-review.ts';
import { anyHighRiskPaths, hasHighRiskPaths } from '../review/review-generation.ts';
import { HOST_PROFILE_RELATIVE_PATH, loadHostProfile } from './host-profile.ts';
import { inferRecallScopes } from './learnings.ts';

const PACKAGE_ROOT = fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/agent-sdlc'))
	? path.join(REPOSITORY_ROOT, 'packages/agent-sdlc')
	: REPOSITORY_ROOT;

function makeTempRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-host-profile-'));
}

function validDefaultProfile(overrides = {}) {
	return {
		schemaVersion: '1.2.0', profileId: 'default-host', repositoryId: 'default-host', adapter: 'default',
		stateDir: 'tools/.agent-sdlc', reviewDir: 'tools/.review', specDraftDir: 'docs/specs/drafts',
		verify: {
			argv: ['pnpm', 'run', 'agent:preflight', '--', '--base', '{baseSha}'],
			resultPath: 'tools/.agent-preflight-last.json', require: { status: 'OK', canonical: true }, headField: 'gitHeadSha',
		},
		...overrides,
	};
}

function minimalScriptProfile13(overrides = {}) {
	return {
		schemaVersion: '1.3.0', profileId: 'acme-client', repositoryId: 'acme-client', adapter: 'script',
		hydration: [['pnpm', 'install']], commands: [['pnpm', 'test']], workspace: { directories: ['.'] },
		verify: {
			argv: ['pnpm', 'run', 'verify', '--', '{baseSha}'],
			resultPath: '.agent-sdlc/verify.json', require: { status: 'OK', canonical: true }, headField: 'gitHeadSha',
		},
		...overrides,
	};
}

function writeProfile(rootDir, payload) {
	const fullPath = path.join(rootDir, HOST_PROFILE_RELATIVE_PATH);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, typeof payload === 'string' ? payload : `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function isHostProfileError(error) {
	return error?.code === 'INVALID_INPUT' && typeof error?.message === 'string' && error.message.startsWith('HOST_PROFILE_INVALID');
}

test('@ac AC-01 @case AC-01.1 a missing profile throws INVALID_INPUT starting with HOST_PROFILE_INVALID', () => {
	const rootDir = makeTempRoot();
	try {
		assert.throws(() => loadHostProfile(rootDir), isHostProfileError);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.2 an extra key budget throws INVALID_INPUT starting with HOST_PROFILE_INVALID', () => {
	const rootDir = makeTempRoot();
	try {
		writeProfile(rootDir, validDefaultProfile({ budget: 100 }));
		assert.throws(() => loadHostProfile(rootDir), isHostProfileError);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.3 a stateDir of ../escape throws INVALID_INPUT starting with HOST_PROFILE_INVALID without creating the escaped path', () => {
	const parentDir = makeTempRoot();
	const rootDir = path.join(parentDir, 'repo');
	const escapedDir = path.join(parentDir, 'escape');
	fs.mkdirSync(rootDir, { recursive: true });
	try {
		writeProfile(rootDir, validDefaultProfile({ stateDir: '../escape' }));
		assert.throws(() => loadHostProfile(rootDir), isHostProfileError);
		assert.equal(fs.existsSync(escapedDir), false);
	} finally {
		fs.rmSync(parentDir, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.4 a verify argv that omits the {baseSha} element throws INVALID_INPUT starting with HOST_PROFILE_INVALID', () => {
	const rootDir = makeTempRoot();
	try {
		writeProfile(
			rootDir,
			validDefaultProfile({
				verify: {
					argv: ['pnpm', 'run', 'agent:preflight'],
					resultPath: 'tools/.agent-preflight-last.json',
					require: { status: 'OK', canonical: true },
					headField: 'gitHeadSha',
				},
			}),
		);
		assert.throws(() => loadHostProfile(rootDir), isHostProfileError);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.5 host check --root on a directory with no profile exits 64 and its output contains HOST_PROFILE_INVALID', () => {
	const rootDir = makeTempRoot();
	try {
		const res = spawnSync(
			process.execPath,
			[path.join(PACKAGE_ROOT, 'cli/cli.ts'), 'host', 'check', '--root', rootDir, '--json'],
			{
				cwd: PACKAGE_ROOT,
				encoding: 'utf8',
				timeout: 30_000,
			},
		);
		const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
		assert.equal(res.status, 64, output);
		assert.match(output, /HOST_PROFILE_INVALID/);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('loadHostProfile rejects default profiles carrying hydration, commands, or workspace and script profiles missing commands', () => {
	const rootDir = makeTempRoot();
	try {
		writeProfile(rootDir, validDefaultProfile({ hydration: [] }));
		assert.throws(() => loadHostProfile(rootDir), isHostProfileError);

		writeProfile(rootDir, validDefaultProfile({ commands: [['pnpm', 'test']] }));
		assert.throws(() => loadHostProfile(rootDir), isHostProfileError);

		writeProfile(
			rootDir,
			validDefaultProfile({
				adapter: 'script',
				hydration: [],
				commands: [],
				workspace: { directories: ['.'] },
			}),
		);
		assert.throws(() => loadHostProfile(rootDir), isHostProfileError);

		writeProfile(rootDir, '');
		assert.throws(() => loadHostProfile(rootDir), isHostProfileError);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.1 loadHostProfile parses schemaVersion 1.2.0 with optional prompts block', () => {
	const rootDir = makeTempRoot();
	try {
		writeProfile(rootDir, validDefaultProfile({
			prompts: {
				preset: 'default', roleAddendaDir: '.agents/workflows/prompts', rubricAddendaDir: '.agents/review-rubrics',
				pathScopedRules: [{
					id: 'frontend-pwa', pathPrefixes: ['apps/frontends/pwa-frontend'],
					addendaFile: '.agents/workflows/scoped/frontend-pwa.md', roles: ['implementer', 'reviewer'], phases: ['code', 'qa'],
				}],
			},
		}));
		const loaded = loadHostProfile(rootDir);
		assert.equal(loaded.schemaVersion, '1.2.0');
		assert.equal(loaded.prompts?.preset, 'default');
		assert.equal(loaded.prompts?.pathScopedRules?.length, 1);
		assert.equal(loaded.prompts?.pathScopedRules?.[0]?.id, 'frontend-pwa');
		assert.equal(Object.isFrozen(loaded.prompts), true);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.2 loadHostProfile rejects schemaVersion 1.1.0 or unknown preset with HOST_PROFILE_INVALID', () => {
	const rootDir = makeTempRoot();
	try {
		writeProfile(rootDir, validDefaultProfile({ schemaVersion: '1.1.0' }));
		assert.throws(() => loadHostProfile(rootDir), isHostProfileError);
		writeProfile(rootDir, validDefaultProfile({ prompts: { preset: 'unknown-preset' } }));
		assert.throws(() => loadHostProfile(rootDir), isHostProfileError);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.3 loadHostProfile rejects escaping paths in prompts block with HOST_PROFILE_INVALID', () => {
	const rootDir = makeTempRoot();
	try {
		writeProfile(rootDir, validDefaultProfile({ prompts: { roleAddendaDir: '../escape' } }));
		assert.throws(() => loadHostProfile(rootDir), isHostProfileError);
		writeProfile(rootDir, validDefaultProfile({
			prompts: { pathScopedRules: [{ id: 'bad-rule', pathPrefixes: ['packages/agent-sdlc'], addendaFile: '../escape/rule.md' }] },
		}));
		assert.throws(() => loadHostProfile(rootDir), isHostProfileError);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

function collectTsFiles(dir) {
	const results = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectTsFiles(fullPath));
		} else if (entry.name.endsWith('.ts')) {
			results.push(fullPath);
		}
	}
	return results;
}

test('@ac AC-01 @case AC-01.1 loadHostProfile(REPOSITORY_ROOT) succeeds with schemaVersion 1.3.0 and exposes declarative host blocks', () => {
	const loaded = loadHostProfile(REPOSITORY_ROOT);
	assert.equal(loaded.schemaVersion, '1.3.0');
	assert.ok(loaded.workspace);
	assert.ok(loaded.hydration);
	assert.ok(loaded.policy);
	assert.ok(loaded.architecture);
	assert.ok(loaded.qualityGate);
	assert.ok(loaded.learnings);
	assert.ok(loaded.git);
	assert.equal(typeof loaded.runsDir, 'string');
});

test('@ac AC-01 @case AC-01.2 loadHostProfile rejects escaping paths in 1.3.0 relative path fields with HOST_PROFILE_INVALID', () => {
	const rootDir = makeTempRoot();
	try {
		const base13 = {
			...validDefaultProfile(),
			schemaVersion: '1.3.0',
		};

		const badPayloads = [
			{ ...base13, runsDir: '../escape-runs' },
			{ ...base13, workspace: { packageRoots: ['../escape-pkg'] } },
			{ ...base13, hydration: { untrackedCopies: ['../escape-secret'] } },
			{ ...base13, policy: { highRiskPaths: ['../escape-risk'] } },
			{
				...base13,
				qualityGate: {
					eslintConfigPath: '../escape/eslint.cjs',
					baselinePath: 'tools/quality/baselines/quality-v1.json',
					exceptionsPath: 'tools/quality/exceptions.json',
				},
			},
			{ ...base13, learnings: { filePath: '../escape/.learnings.jsonl' } },
		];

		for (const payload of badPayloads) {
			writeProfile(rootDir, payload);
			assert.throws(() => loadHostProfile(rootDir), isHostProfileError);
		}
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-02 @case AC-02.1 no .ts file under packages/agent-sdlc/ contains legacy tools/lib learnings script path', () => {
	const legacyLearnPath = `tools/lib/${'learn'}.${'mjs'}`;
	const tsFiles = collectTsFiles(PACKAGE_ROOT);
	for (const file of tsFiles) {
		const content = fs.readFileSync(file, 'utf8');
		assert.equal(
			content.includes(legacyLearnPath),
			false,
			`Unexpected legacy learnings script reference in ${file}`,
		);
	}
});

test('@ac AC-02 @case AC-02.2 inferRecallScopes resolves scopes from synthetic host profile learnings.scopeInference rules', () => {
	const rootDir = makeTempRoot();
	try {
		writeProfile(rootDir, {
			...validDefaultProfile(),
			schemaVersion: '1.3.0',
			learnings: {
				filePath: '.learnings.jsonl',
				scopes: ['global', 'billing-core', 'web-portal'],
				scopeInference: [
					{ prefix: 'domains/billing/', mode: 'literal', scope: 'billing-core' },
					{ prefix: 'clients/portal', mode: 'literal', scope: 'web-portal' },
				],
			},
		});
		const scopes = inferRecallScopes(
			['domains/billing/src/invoice.ts', 'clients/portal/app.tsx'],
			rootDir,
		);
		assert.deepEqual(scopes, ['billing-core', 'web-portal']);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.1 scanWorkspacePackages discovers packages from custom workspace.packageRoots without apps/services or apps/frontends', () => {
	const rootDir = makeTempRoot();
	try {
		writeProfile(rootDir, { ...validDefaultProfile(), schemaVersion: '1.3.0', workspace: { packageRoots: ['modules'] } });
		const modDir = path.join(rootDir, 'modules', 'alpha');
		fs.mkdirSync(modDir, { recursive: true });
		fs.writeFileSync(path.join(modDir, 'package.json'), JSON.stringify({ name: '@acme/alpha', version: '1.0.0' }), 'utf8');

		const discovered = scanWorkspacePackages(rootDir);
		assert.equal(discovered.packageMap.size, 1);
		assert.equal(discovered.pathToPackage.get('modules/alpha'), '@acme/alpha');
		assert.equal(discovered.packageMap.get('@acme/alpha')?.packagePath, 'modules/alpha');
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.2 workspace-packages.ts, authorization.ts, policy-gate.ts, and task-planner.ts contain no hardcoded apps/services, apps/frontends, or apps/e2e strings', () => {
	const files = [
		'packages/agent-sdlc/policy/task-planner/workspace-packages.ts',
		'packages/agent-sdlc/policy/authorization.ts',
		'packages/agent-sdlc/policy/policy-gate.ts',
		'packages/agent-sdlc/policy/task-planner.ts',
	];
	const forbidden = /apps\/services|apps\/frontends|apps\/e2e/;
	for (const rel of files) {
		const targetPath = path.join(PACKAGE_ROOT, rel.replace(/^packages\/agent-sdlc\//, ''));
		assert.equal(forbidden.test(fs.readFileSync(targetPath, 'utf8')), false, `Forbidden path literal in ${rel}`);
	}
});

test('@ac AC-04 @case AC-04.1 anyHighRiskPaths and hasHighRiskPaths respect custom policy.highRiskPaths in host profile', () => {
	const rootDir = makeTempRoot();
	try {
		writeProfile(rootDir, { ...validDefaultProfile(), schemaVersion: '1.3.0', policy: { highRiskPaths: ['packages/critical-auth'] } });
		assert.equal(anyHighRiskPaths(['packages/critical-auth/index.ts'], rootDir), true);
		assert.equal(hasHighRiskPaths(['packages/critical-auth/index.ts'], rootDir), true);
		assert.equal(anyHighRiskPaths(['packages/other/index.ts'], rootDir), false);
		assert.equal(hasHighRiskPaths(['packages/other/index.ts'], rootDir), false);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-04 @case AC-04.2 review-generation.ts, citation-verifier.ts, failure-packet.ts, github-pr.ts, and reversible-decisions.ts contain no hardcoded ddd-base, example-base, or apps/** strings', () => {
	const files = [
		'review/review-generation.ts', 'review/citation-verifier.ts',
		'review/failure-packet.ts', 'adapters/github-pr.ts',
		'policy/reversible-decisions.ts',
	];
	const forbidden = /ddd-base|example-base|apps\/\*\*/;
	for (const rel of files) {
		assert.equal(forbidden.test(fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8')), false, `Forbidden literal in ${rel}`);
	}
});

test('@ac AC-05 @case AC-05.1 runDeterministicArchitect flags imports matching custom architecture.importRules.forbiddenSpecifierPattern', () => {
	const rootDir = makeTempRoot();
	try {
		writeProfile(rootDir, {
			...validDefaultProfile(), schemaVersion: '1.3.0', workspace: { packageRoots: ['packages'] },
			architecture: {
				importRules: [{
					id: 'no-acme-internal', description: 'Do not import @acme/internal-only directly.',
					sourcePathPrefixes: ['packages/'], forbiddenSpecifierPattern: '^@acme/internal-only(?:/|$)',
				}],
			},
		});
		const pkgDir = path.join(rootDir, 'packages', 'consumer');
		fs.mkdirSync(pkgDir, { recursive: true });
		fs.writeFileSync(path.join(pkgDir, 'index.ts'), "import { secret } from '@acme/internal-only';\nexport const x = secret;\n", 'utf8');

		const result = runDeterministicArchitect({
			worktreeDir: rootDir, changedFiles: ['packages/consumer/index.ts'],
			allowedPackages: ['packages/consumer'], allowedPathPrefixes: ['packages/consumer'],
		});
		assert.equal(result.status, 'VIOLATIONS_DETECTED');
		assert.equal(result.violations.some((v) => v.boundary === 'no-acme-internal'), true);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-05 @case AC-05.2 pipeline-deterministic-roles.ts and task-quality-gate.ts contain no hardcoded service or tools/quality/ literals', () => {
	const files = [
		'execution/pipeline-deterministic-roles.ts',
		'execution/task-quality-gate.ts',
	];
	const forbidden = /@(?!langchain|evelbulgroz|swc)[a-z0-9-]+-service|tools\/quality\//;
	for (const rel of files) {
		const content = fs.readFileSync(path.join(PACKAGE_ROOT, rel), 'utf8');
		assert.equal(forbidden.test(content), false, `Forbidden literal in ${rel}`);
	}
});

test('@ac AC-06 @case AC-06.1 no production .ts file under packages/agent-sdlc/ contains forbidden host-specific literals', () => {
	const forbidden =
		/example-agent|example\.local|agent-run-init\.sh|example-base/;
	const tsFiles = collectTsFiles(PACKAGE_ROOT);
	for (const file of tsFiles) {
		const content = fs.readFileSync(file, 'utf8');
		const match = content.match(forbidden);
		assert.equal(
			match,
			null,
			`Unexpected forbidden literal "${match?.[0] ?? ''}" in ${path.relative(PACKAGE_ROOT, file)}`,
		);
	}
});

test('@ac AC-06 @case AC-06.2 git-manager.ts and commit.ts use profile.git or default to agent-sdlc and agent@sdlc.local', () => {
	const gitManagerSource = fs.readFileSync(
		path.join(PACKAGE_ROOT, 'workflow/git-manager.ts'),
		'utf8',
	);
	const commitNodeSource = fs.readFileSync(
		path.join(PACKAGE_ROOT, 'workflow/nodes/commit.ts'),
		'utf8',
	);
	assert.equal(gitManagerSource.includes('agent-sdlc'), true);
	assert.equal(gitManagerSource.includes('agent@sdlc.local'), true);
	assert.equal(commitNodeSource.includes('hostProfile.git?.authorName'), true);
	assert.equal(commitNodeSource.includes('agent@sdlc.local'), true);
});

test('@ac AC-01 @case AC-01.1 loadHostProfile on a 1.3.0 script profile omitting stateDir, reviewDir, and specDraftDir populates .agent-sdlc defaults and derives reviewDir and specDraftDir under custom stateDir', () => {
	const rootDir = makeTempRoot();
	try {
		writeProfile(rootDir, minimalScriptProfile13());
		const loaded = loadHostProfile(rootDir);
		assert.equal(loaded.stateDir, '.agent-sdlc');
		assert.equal(loaded.reviewDir, '.agent-sdlc/reviews');
		assert.equal(loaded.specDraftDir, '.agent-sdlc/specs/drafts');
		assert.equal(loaded.runsDir, undefined);

		writeProfile(rootDir, minimalScriptProfile13({ stateDir: 'var/.sdlc' }));
		const customState = loadHostProfile(rootDir);
		assert.equal(customState.stateDir, 'var/.sdlc');
		assert.equal(customState.reviewDir, 'var/.sdlc/reviews');
		assert.equal(customState.specDraftDir, 'var/.sdlc/specs/drafts');
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.2 loadHostProfile on a 1.2.0 profile omitting stateDir, reviewDir, or specDraftDir throws INVALID_INPUT starting with HOST_PROFILE_INVALID', () => {
	const rootDir = makeTempRoot();
	try {
		for (const omittedField of ['stateDir', 'reviewDir', 'specDraftDir']) {
			const payload = validDefaultProfile();
			delete payload[omittedField];
			writeProfile(rootDir, payload);
			assert.throws(() => loadHostProfile(rootDir), isHostProfileError);
		}
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-04 @case AC-04.1 CriticReviewAdapter resolves reviewBaseDir to .agent-sdlc/reviews when a 1.3.0 profile omits stateDir and reviewDir', () => {
	const rootDir = makeTempRoot();
	try {
		writeProfile(rootDir, minimalScriptProfile13());
		const adapter = new CriticReviewAdapter({ rootDir });
		assert.equal(adapter.reviewBaseDir, path.join(rootDir, '.agent-sdlc/reviews'));
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('@ac AC-04 @case AC-04.2 CriticReviewAdapter resolves reviewBaseDir to tools/.review when .agents/sdlc-host.json sets reviewDir to tools/.review', () => {
	const rootDir = makeTempRoot();
	try {
		writeProfile(rootDir, { ...validDefaultProfile(), schemaVersion: '1.3.0', reviewDir: 'tools/.review' });
		const adapter = new CriticReviewAdapter({ rootDir });
		assert.equal(adapter.reviewBaseDir, path.join(rootDir, 'tools/.review'));
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});
