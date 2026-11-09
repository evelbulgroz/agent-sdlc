import '../use-fixture-monorepo.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultAuthorizationEnvelope } from '../../policy/authorization.ts';
import { CITING_SPEC_PATH, createMockExecCli, leanWriteAction } from '../test-support.mjs';
import {
	billingProposal,
	implementerScript,
	makeGraphFixture,
	reachSpecApproved,
} from '../graph-fixtures.ts';

async function authorizeRun(fixture) {
	const approved = await reachSpecApproved(fixture);
	const envelope = createDefaultAuthorizationEnvelope({
		runId: fixture.runId,
		approvedSpecHash: approved.approvedSpecHash,
		baseCommitSha: fixture.baseCommitSha,
		allowedPackages: ['services/billing'],
		allowedPathPrefixes: ['services/billing'],
		createBranch: true,
		createLocalCommits: false,
		maxSemanticRepairs: 0,
	});
	return fixture.runtime.authorize(approved, envelope);
}

function scriptWithSpec(specSource) {
	return [
		billingProposal(),
		leanWriteAction('services/billing/src/feature.ts', 'export const feature = true;\n'),
		leanWriteAction(CITING_SPEC_PATH, specSource),
		{ action: { kind: 'complete', summary: 'Done' } },
		{ action: { kind: 'complete', summary: 'Audit confirmed' } },
		{ status: 'PASS', summary: 'Implementation looks solid', findings: [] },
	];
}

// S2a gate: a test that cites an approved criterion but asserts nothing never discharges it.
test('@ac AC-03 @case AC-03.S2a a cited test with no assertion blocks the run with AC_COVERAGE_FAILED', async () => {
	const fixture = makeGraphFixture(
		'qual-s2a',
		scriptWithSpec("it('holds the approved outcome @ac AC-01', () => {\n  const value = 1;\n});\n"),
		{ profile: 'slice3', execCli: createMockExecCli({ requireAcceptanceCitation: false }) },
	);
	try {
		const terminal = await authorizeRun(fixture);
		assert.equal(terminal.state, 'BLOCKED', JSON.stringify(terminal.lastError ?? terminal));
		assert.equal(terminal.blockedReason, 'AC_COVERAGE_FAILED');
		const events = fixture.store.listEvents(fixture.runId);
		const failed = events.find((event) => event.eventType === 'AC_COVERAGE_FAILED');
		const report = fixture.artifacts.readJson(failed.payload.coverageArtifact);
		assert.ok(report.citeWithoutAssertion.length > 0, 'blocked because the cited test has no assertion');
		assert.equal(events.some((event) => event.eventType === 'AC_COVERAGE_PASSED'), false);
		assert.equal(events.some((event) => event.eventType === 'RUN_READY_FOR_GIT_APPROVAL'), false);
	} finally {
		fixture.close();
	}
});

// S2b known gap: a literal assertion is only warned about. When the engine blocks no-op
// assertions, this scenario must flip to a gate, so the assertions below will fail.
test('@ac AC-04 @case AC-04.S2b a test asserting only a literal reaches READY with a no-op warning', async () => {
	const fixture = makeGraphFixture('qual-s2b', implementerScript(), { profile: 'slice3' });
	try {
		const terminal = await authorizeRun(fixture);
		assert.equal(terminal.state, 'READY_FOR_GIT_APPROVAL', JSON.stringify(terminal.lastError ?? terminal));
		const passed = fixture.store
			.listEvents(fixture.runId)
			.find((event) => event.eventType === 'AC_COVERAGE_PASSED');
		assert.ok(passed, 'coverage passed');
		const report = fixture.artifacts.readJson(passed.payload.coverageArtifact);
		assert.equal(report.pass, true);
		assert.ok(report.noopAssertionTests.length > 0, 'the no-op test is recorded as a warning');
	} finally {
		fixture.close();
	}
});
