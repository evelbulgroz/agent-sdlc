import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyReliabilityFailure } from './failure-classification.ts';

test('@ac AC-01 classifies the rerun-5 missing literal as a stale replacement', () => {
	assert.equal(
		classifyReliabilityFailure({
			code: 'INVALID_INPUT',
			error:
				"old_string not found in 'apps/frontends/fitnessapp-pwa-frontend/src/ui/SignInPage.tsx'. Copy an exact unique snippet from the latest read_file output.",
		}),
		'STALE_LITERAL_REPLACEMENT',
	);
});

test('@ac AC-29 classifies already-named infrastructure, repair-gate, and contract codes instead of UNCLASSIFIED', () => {
	// Reproduces canary rerun-23/run2's exhaustion outcome, rerun-27's repair
	// gate, run1's AC-ownership contract violation, and other recurring
	// already-understood codes found when aggregating `reliability report`
	// evidence: without dedicated categories these all fell into UNCLASSIFIED,
	// hiding genuinely novel failures behind already-known noise.
	assert.equal(
		classifyReliabilityFailure({
			code: 'GOVERNOR_ROUTES_EXHAUSTED',
			message: 'No allowed governed model route completed',
		}),
		'INFRASTRUCTURE_INTERRUPTION',
	);
	assert.equal(
		classifyReliabilityFailure({
			code: 'GOVERNOR_RUN_DEADLINE_EXPIRED',
			message: 'Run deadline has expired',
		}),
		'RUN_DEADLINE_EXPIRED',
	);
	assert.equal(
		classifyReliabilityFailure({
			code: 'REPAIR_BUDGET_EXHAUSTED',
			message: 'Autonomous repair prohibited: REPAIR_BUDGET_EXHAUSTED',
		}),
		'REPAIR_GATE_EXHAUSTED',
	);
	assert.equal(
		classifyReliabilityFailure({
			code: 'REPAIR_HUMAN_INTERVENTION_REQUIRED',
			message: 'Autonomous repair prohibited: REPAIR_HUMAN_INTERVENTION_REQUIRED',
		}),
		'REPAIR_GATE_EXHAUSTED',
	);
	assert.equal(
		classifyReliabilityFailure({
			code: 'INVALID_CONTRACT',
			message:
				'taskManifest acceptance criterion ownership is invalid (missing: AC-03, AC-04)',
		}),
		'TASK_PLAN_CONTRACT_VIOLATION',
	);
	assert.equal(
		classifyReliabilityFailure({
			code: 'CONFIGURATION_CHANGED',
			message: 'Workflow, role, prompt, capability, or evaluator policy changed',
		}),
		'CONFIGURATION_DRIFT',
	);
	assert.equal(
		classifyReliabilityFailure({
			code: 'AUTHOR_VENDOR_UNKNOWN',
			message: "Unknown or unsupported author vendor: 'deterministic-json'",
		}),
		'UNSUPPORTED_AUTHOR_VENDOR',
	);
	assert.equal(
		classifyReliabilityFailure({
			code: 'IMPLEMENTER_NON_PROGRESS',
			message:
				'Implementer made no bounded progress after route failover: repeated-failed-reads',
		}),
		'IMPLEMENTER_NON_PROGRESS',
	);
	assert.equal(
		classifyReliabilityFailure({
			code: 'NON_SUBSTANTIVE_RECOVERY_MUTATION',
			message:
				"Mutation on 'apps/frontends/fitnessapp-pwa-frontend/src/features/auth/SignInPage.spec.tsx' modified only comments or whitespace.",
		}),
		'INVALID_EDIT',
	);
});

test('@ac AC-02 @case AC-02.4 classification maps budget denial, unknown codes, and null', () => {
	assert.equal(
		classifyReliabilityFailure({ code: 'GOVERNOR_BUDGET_DENIED' }),
		'INFRASTRUCTURE_INTERRUPTION',
	);
	assert.equal(classifyReliabilityFailure({ code: 'NOT_A_REAL_CODE' }), 'UNCLASSIFIED');
	assert.equal(classifyReliabilityFailure(null), 'UNCLASSIFIED');
});
