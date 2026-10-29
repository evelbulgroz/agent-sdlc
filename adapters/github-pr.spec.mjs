import '../testing/use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createDraftPullRequest,
	formatPullRequestBody,
	isHighRiskPath,
} from './github-pr.ts';

test('isHighRiskPath correctly identifies high risk directories and normal directories', () => {
	assert.equal(isHighRiskPath('services/authentication/src/auth.ts'), true);
	assert.equal(isHighRiskPath('services/registry/src/index.ts'), true);
	assert.equal(isHighRiskPath('packages/service-auth-core/src/index.ts'), true);
	assert.equal(isHighRiskPath('packages/nest-service-auth/src/index.ts'), true);
	assert.equal(isHighRiskPath('packages/shared-base/src/index.ts'), true);
	assert.equal(isHighRiskPath('packages/base/src/index.ts'), true);
	assert.equal(isHighRiskPath('.github/workflows/verify.yml'), true);
	assert.equal(isHighRiskPath('tools/quality/rules.json'), true);
	assert.equal(isHighRiskPath('secrets-config/keys.json'), true);

	// Normal paths
	assert.equal(isHighRiskPath('services/billing/src/index.ts'), false);
	assert.equal(isHighRiskPath('frontends/pwa-frontend/src/App.tsx'), false);
	assert.equal(isHighRiskPath('tools/agent-sdlc/workflow/graph.mjs'), false);

	// Shadow paths: nil, empty, non-string
	assert.equal(isHighRiskPath(null), false);
	assert.equal(isHighRiskPath(undefined), false);
	assert.equal(isHighRiskPath(''), false);
});

test('formatPullRequestBody formats PR body matching monorepo template and shadow paths', () => {
	// 1. Happy path: standard run with decisions, preflight, normal risk
	const body = formatPullRequestBody({
		spec: {
			goal: 'Add GPS speed smoothing to billing service',
			owningContext: 'Billing',
			touchedSurfaces: ['services/billing/src/gps.ts'],
		},
		decisions: [
			{ topic: 'Algorithm', chosen: 'Kalman filter' },
			'Preserve raw GPS coordinates alongside smoothed data',
		],
		repairs: 0,
		preflightEvidence: {
			status: 'OK',
			changeClass: 'A',
			resultLine: 'agent-preflight: RESULT status=OK class=A canonical=true exitCode=0',
		},
		allowedPackages: ['services/billing'],
		runId: '2026-09-08-gps-smoothing',
		branchName: 'agent-sdlc/2026-09-08-gps-smoothing',
	});

	assert.ok(body.includes('## Summary'));
	assert.ok(body.includes('Add GPS speed smoothing to billing service'));
	assert.ok(body.includes('**Owning Context:** Billing'));
	assert.ok(body.includes('- [x] `lane:agent`'));
	assert.ok(body.includes('- [x] Normal'));
	assert.ok(body.includes('`services/billing`'));
	assert.ok(body.includes('agent-preflight: RESULT status=OK class=A canonical=true exitCode=0'));
	assert.ok(body.includes('- **Algorithm**: Kalman filter'));
	assert.ok(body.includes('- Initial implementation passed local preflight'));
	assert.ok(body.includes('tools/.agent-sdlc/2026-09-08-gps-smoothing'));
	assert.ok(body.includes('Branch: `agent-sdlc/2026-09-08-gps-smoothing`'));

	// 2. High risk path detection
	const highRiskBody = formatPullRequestBody({
		spec: {
			goal: 'Update authentication token validation',
			owningContext: 'Authentication',
		},
		touchedSurfaces: ['services/authentication/src/tokens.ts'],
		allowedPackages: ['services/authentication'],
		runId: '2026-09-08-auth-update',
	});
	assert.ok(highRiskBody.includes('- [x] `risk:high`'));

	// 3. Escalated lane when repairs >= 2
	const escalatedBody = formatPullRequestBody({
		spec: { goal: 'Bugfix requiring multiple repairs' },
		repairs: 2,
		allowedPackages: ['services/billing'],
		runId: '2026-09-08-repair-test',
	});
	assert.ok(escalatedBody.includes('- [x] `lane:escalate`'));
	assert.ok(escalatedBody.includes('- Completed after 2 semantic repair attempt(s)'));

	// 4. Automation lane for tools/docs only
	const automationBody = formatPullRequestBody({
		spec: { goal: 'Update tooling scripts' },
		allowedPackages: ['tools'],
		runId: '2026-09-08-tooling',
	});
	assert.ok(automationBody.includes('- [x] `lane:automation`'));

	// 5. Nil / empty inputs
	const nilBody = formatPullRequestBody({
		spec: null,
		decisions: null,
		allowedPackages: [],
		touchedSurfaces: [],
	});
	assert.ok(nilBody.includes('Automated SDLC implementation'));
	assert.ok(nilBody.includes('Standard repository defaults applied'));
});

test('createDraftPullRequest handles happy path, shadow paths, and CLI failures', () => {
	// 1. Happy path: mock gh CLI returns PR URL
	const mockGh = (cmd, args) => {
		assert.equal(cmd, 'gh');
		assert.equal(args[0], 'pr');
		assert.equal(args[1], 'create');
		assert.ok(args.includes('--draft'));
		assert.ok(args.includes('--title'));
		assert.ok(args.includes('--head'));
		return 'https://github.com/evelbulgroz/agent-sdlc/pull/105\n';
	};

	const result = createDraftPullRequest({
		worktreeDir: '/tmp/worktree',
		title: 'feat(billing): add GPS smoothing',
		body: '## Summary\nAdds GPS smoothing',
		branchName: 'agent-sdlc/feat-gps',
		baseBranch: 'main',
		ghCli: mockGh,
	});

	assert.equal(result.prUrl, 'https://github.com/evelbulgroz/agent-sdlc/pull/105');
	assert.equal(result.prNumber, 105);
	assert.equal(result.draft, true);
	assert.equal(result.branchName, 'agent-sdlc/feat-gps');
	assert.equal(result.baseBranch, 'main');

	// 2. Nil / empty title path
	assert.throws(
		() =>
			createDraftPullRequest({
				worktreeDir: '/tmp/worktree',
				title: '',
				body: 'body',
				branchName: 'branch',
				ghCli: mockGh,
			}),
		/Pull request title cannot be empty/,
	);
	assert.throws(
		() =>
			createDraftPullRequest({
				worktreeDir: '/tmp/worktree',
				title: null,
				body: 'body',
				branchName: 'branch',
				ghCli: mockGh,
			}),
		/Pull request title cannot be empty/,
	);

	// 3. Invalid body type path
	assert.throws(
		() =>
			createDraftPullRequest({
				worktreeDir: '/tmp/worktree',
				title: 'title',
				body: 123,
				branchName: 'branch',
				ghCli: mockGh,
			}),
		/Pull request body must be a string/,
	);

	// 4. Invalid branch name
	assert.throws(
		() =>
			createDraftPullRequest({
				worktreeDir: '/tmp/worktree',
				title: 'title',
				body: 'body',
				branchName: '../escape',
				ghCli: mockGh,
			}),
		/Invalid git branch name/,
	);

	// 5. Upstream error: gh not found (ENOENT)
	const enoentGh = () => {
		const err = new Error('spawn gh ENOENT');
		err.code = 'ENOENT';
		throw err;
	};
	assert.throws(
		() =>
			createDraftPullRequest({
				worktreeDir: '/tmp/worktree',
				title: 'title',
				body: 'body',
				branchName: 'agent-sdlc/feat-1',
				ghCli: enoentGh,
			}),
		/GH_CLI_NOT_FOUND/,
	);

	// 6. Upstream error: gh command failure
	const failGh = () => {
		throw new Error('GraphQL: Resource not accessible by integration');
	};
	assert.throws(
		() =>
			createDraftPullRequest({
				worktreeDir: '/tmp/worktree',
				title: 'title',
				body: 'body',
				branchName: 'agent-sdlc/feat-1',
				ghCli: failGh,
			}),
		/PR_CREATION_FAILED/,
	);
});

test('formatPullRequestBody includes QA Divergence Brief and Test Linkage Advisories when present', () => {
	const body = formatPullRequestBody({
		spec: { goal: 'Test divergence formatting' },
		qaDivergences: [
			{ severity: 'P2', ruleId: 'QA_COVERAGE', message: 'AC-02 Then clause not asserted', evidence: 'GAP AC-02: test.spec.ts:15' },
			{ severity: 'P1', ruleId: 'QA_SPEC', message: 'Asserts forbidden field', evidence: 'OVERSPEC: test.spec.ts:30' },
		],
		coverageAdvisories: {
			emptyAssertFiles: ['services/billing/src/empty.spec.ts'],
			uncitedTouchedTests: [{ file: 'services/billing/src/uncited.spec.ts', line: 12, title: 'does something' }],
			staleOracleCitations: [{ file: 'services/billing/src/legacy.oracle.spec.ts', line: 10, id: 'AC-99' }],
		},
	});

	assert.ok(body.includes('## QA Divergence Brief'));
	assert.ok(body.includes('- [P2] **QA_COVERAGE**: AC-02 Then clause not asserted (GAP AC-02: test.spec.ts:15)'));
	assert.ok(body.includes('- [P1] **QA_SPEC**: Asserts forbidden field (OVERSPEC: test.spec.ts:30)'));

	assert.ok(body.includes('## Test Linkage Advisories'));
	assert.ok(body.includes('- **Empty assertions**: `services/billing/src/empty.spec.ts`'));
	assert.ok(body.includes('- **Uncited touched test**: `services/billing/src/uncited.spec.ts:12` "does something"'));
	assert.ok(body.includes('- **Stale oracle citation**: `services/billing/src/legacy.oracle.spec.ts:10` (`AC-99`)'));

	const missed = formatPullRequestBody({
		spec: { goal: 'Test divergence formatting' },
		coverageAdvisories: {
			coveragePass: false,
			uncoveredAcIds: ['AC-01', 'AC-04'],
			emptyAssertFiles: [],
			uncitedTouchedTests: [],
			staleOracleCitations: [],
		},
	});
	assert.ok(missed.includes('## Acceptance Coverage'));
	assert.ok(missed.includes('Acceptance coverage did not pass: AC-01, AC-04'));
});

test('formatPullRequestBody renders the secrets checklist from policy.secretPaths only', () => {
	const spec = { goal: 'Checklist wording' };
	const plain = formatPullRequestBody({ spec, profile: { version: '1.3.0' } });
	assert.match(plain, /- \[x\] No secrets committed/);
	assert.doesNotMatch(plain, /secrets-config/);
	const configured = formatPullRequestBody({
		spec,
		profile: { version: '1.3.0', policy: { secretPaths: ['vault/', '*.keys.ts'] } },
	});
	assert.match(configured, /No secrets \/ `vault\/`, `\*\.keys\.ts` committed/);
});
