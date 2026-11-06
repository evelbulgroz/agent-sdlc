import fs from 'node:fs';
import {
	AdapterRegistrationSchema, EvidenceRequestSchema, EvidenceReportSchema,
	EvidenceReceiptSchema, InvocationRecordSchema, validateEvidenceReportForRequest,
	type AdapterRegistration, type EvidenceRequest, type EvidenceReport, type InvocationRecord,
} from '../policy/contracts/quality-schema.ts';
import { sha256 } from '../policy/contracts/primitives.ts';
import {
	assertEvidenceDirectory, hashEvidenceBytes, readEvidenceFile,
	verifyEvidenceArtifacts, verifyEvidenceRegistration,
} from './evidence-files.ts';
import { sanitizeEvidenceDiagnostic, spawnEvidence } from './evidence-transport.ts';
import type {
	EvidenceCallbacks, EvidenceCompletion, EvidenceExecutionResult, EvidenceInvocationContext,
	EvidenceRecordStore, EvidenceSourceObservation, EvidenceSpawn,
} from './evidence-types.ts';

function contains(prefix: string, relative: string): boolean {
	const normalized = prefix.replace(/\/+$/, '');
	return normalized === '.' || relative === normalized || relative.startsWith(`${normalized}/`);
}

function assertAuthorization(request: EvidenceRequest, context: EvidenceInvocationContext, now: Date): void {
	const auth = context.authorization;
	if (!auth || auth.runId !== request.binding.runId ||
		auth.approvedSpecHash !== request.binding.approvedSpecHash ||
		auth.baseCommitSha !== request.binding.baseCommitSha ||
		!auth.allowedOperations.runAllowlistedCommands ||
		!Number.isFinite(Date.parse(auth.expiresAt)) || Date.parse(auth.expiresAt) <= now.getTime() ||
		!auth.allowedPackages.some((prefix) => contains(prefix, context.targetPackage))) {
		throw new Error('evidence-authorization-invalid');
	}
	const qualityPlan = auth.qualityPlan;
	if (!qualityPlan ||
		sha256(qualityPlan.qualityPolicy) !== request.binding.qualityPolicyHash ||
		!qualityPlan.adapterBindings.some((adapter) => sha256(adapter) === request.adapterBindingHash) ||
		request.obligations.some((obligation) => !qualityPlan.evidenceObligations.some((approved) =>
			approved.obligationId === obligation.obligationId && sha256(approved) === sha256(obligation)))) {
		throw new Error('evidence-quality-plan-not-authorized');
	}
}

function assertSource(observation: EvidenceSourceObservation, request: EvidenceRequest, context: EvidenceInvocationContext): void {
	if (observation.treeSha !== request.binding.treeSha ||
		observation.sourceHash !== context.expectedSourceHash ||
		observation.preparationHash !== request.binding.preparationHash) {
		throw new Error('candidate-source-or-preparation-changed');
	}
}

/**
 * Runs the frozen command protocol only. The caller supplies authorized preparation,
 * engine source observation, and an atomic persistence/budget reservation collaborator.
 */
export async function executeEvidence(
	rawRequest: EvidenceRequest,
	rawRegistration: AdapterRegistration,
	context: EvidenceInvocationContext,
	spawn: EvidenceSpawn,
	store: EvidenceRecordStore,
	callbacks: EvidenceCallbacks = {},
): Promise<EvidenceExecutionResult> {
	const request = EvidenceRequestSchema.parse(rawRequest);
	const registration = AdapterRegistrationSchema.parse(rawRegistration);
	const durationCeiling = context.executionDurationCeilingMs;
	if (durationCeiling !== undefined && (!Number.isSafeInteger(durationCeiling) || durationCeiling <= 0)) {
		throw new Error('evidence-execution-duration-exhausted-or-invalid');
	}
	const runtimeLimits = {
		...registration.limits,
		timeoutMs: Math.min(registration.limits.timeoutMs, durationCeiling ?? registration.limits.timeoutMs),
	};
	const now = callbacks.now ?? (() => new Date());
	assertAuthorization(request, context, now());
	if (request.artifactDirectory !== context.artifactDirectory ||
		request.adapterBindingHash !== context.frozenAdapterBindingHash ||
		sha256(registration) !== context.frozenAdapterBindingHash ||
		!context.allowedArgv.some((argv) => argv.length === registration.argv.length &&
			argv.every((part, index) => part === registration.argv[index]))) {
		throw new Error('evidence-command-or-binding-not-authorized');
	}
	const profile = registration.profiles.find((item) => item.profileId === request.profileId);
	if (!profile || request.obligations.some((obligation) =>
		obligation.adapterBindingHash !== request.adapterBindingHash ||
		obligation.profileId !== request.profileId || !profile.layers.includes(obligation.layer) ||
		obligation.requiredCapabilities.some((capability) => !profile.capabilities.includes(capability)))) {
		throw new Error('evidence-profile-not-qualified');
	}
	const assertQualifiedReport = (report: EvidenceReport) => {
		if (report.cases.some((result) =>
			result.exercisedCapabilities.some((capability) => !profile.capabilities.includes(capability)))) {
			throw new Error('evidence-profile-not-qualified');
		}
	};
	const assertAllowed = (relative: string) => {
		if (!context.authorization.allowedPathPrefixes.some((prefix) => contains(prefix, relative))) {
			throw new Error('evidence-path-not-authorized');
		}
	};
	for (const obligation of request.obligations) {
		for (const file of obligation.implementationPaths) assertAllowed(file);
		for (const testCase of obligation.testCases) assertAllowed(testCase.file);
	}
	const stdin = Buffer.from(JSON.stringify(request), 'utf8');
	const maxRequestBytes = context.maxRequestBytes ?? 262144;
	const maxDiagnosticBytes = context.maxDiagnosticBytes ?? 4096;
	if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0 ||
		!Number.isSafeInteger(maxDiagnosticBytes) || maxDiagnosticBytes < 0 ||
		stdin.length > maxRequestBytes) throw new Error('evidence-request-limit');
	const requestHash = sha256(request);
	const bindingHash = sha256(request.binding);
	let invocation: InvocationRecord = InvocationRecordSchema.parse({
		schemaVersion: '1.0.0', operationId: request.operationId, requestHash, bindingHash,
		adapterBindingHash: request.adapterBindingHash, observedArgv: registration.argv,
		worktreeRegistryId: context.worktreeRegistryId, startedAt: now().toISOString(),
		finishedAt: null, exitCode: null, reportHash: null, artifactManifestHash: null,
		status: 'reserved', retryOf: context.retryOf ?? null, failureReason: null,
	});
	const reservation = await store.reserve(invocation);
	if (reservation.kind === 'existing') {
		const previous = reservation.invocation;
		if (previous.requestHash !== requestHash || previous.bindingHash !== bindingHash ||
			previous.adapterBindingHash !== request.adapterBindingHash ||
			previous.worktreeRegistryId !== context.worktreeRegistryId ||
			sha256(previous.observedArgv) !== sha256(registration.argv)) {
			throw new Error('evidence-operation-id-conflict');
		}
		const completion = reservation.completion;
		if (previous.status !== 'completed' || !completion ||
			completion.receipt.status !== 'passed' ||
			completion.receipt.invocationRecordHash !== sha256(previous) ||
			completion.receipt.requestHash !== requestHash ||
			completion.receipt.bindingHash !== bindingHash ||
			completion.receipt.adapterBindingHash !== request.adapterBindingHash) {
			throw new Error('evidence-operation-not-reusable');
		}
		const receipt = EvidenceReceiptSchema.parse(completion.receipt);
		const report = EvidenceReportSchema.parse(completion.report);
		assertQualifiedReport(report);
		assertSource(await context.observeSource(), request, context);
		verifyEvidenceRegistration(context.worktreeDir, registration, assertAllowed);
		validateEvidenceReportForRequest(report, request, previous);
		verifyEvidenceArtifacts(context.artifactDirectory, report, registration);
		if (sha256(report.artifacts) !== receipt.artifactManifestHash ||
			previous.reportHash !== receipt.reportHash ||
			previous.artifactManifestHash !== receipt.artifactManifestHash) {
			throw new Error('evidence-reuse-provenance-mismatch');
		}
		return { ...completion, report, receipt, reused: true };
	}
	let before: EvidenceSourceObservation | null = null;
	let after: EvidenceSourceObservation | null = null;
	let report: EvidenceReport | null = null;
	let stdout: Buffer = Buffer.alloc(0);
	let exitCode: number | null = null;
	let signal: string | null = null;
	let failureReason: string | null = null;
	let status: 'passed' | 'failed' | 'incomplete' = 'incomplete';
	const startMs = Date.now();
	// Phase durations go to the operator-only diagnostics channel, never into durable evidence.
	const phases: string[] = [];
	let phaseStart = Date.now();
	const phase = (name: string): void => {
		const current = Date.now();
		phases.push(`${name}=${current - phaseStart}ms`);
		phaseStart = current;
	};
	try {
		assertEvidenceDirectory(context.worktreeDir);
		assertEvidenceDirectory(context.artifactDirectory);
		if (fs.readdirSync(context.artifactDirectory).length !== 0) throw new Error('artifact-directory-not-fresh');
		verifyEvidenceRegistration(context.worktreeDir, registration, assertAllowed);
		for (const obligation of request.obligations) {
			for (const file of [...obligation.implementationPaths, ...obligation.testCases.map((item) => item.file)]) {
				readEvidenceFile(context.worktreeDir, file, Number.MAX_SAFE_INTEGER);
			}
		}
		phase('verify-before');
		before = await context.observeSource();
		assertSource(before, request, context);
		phase('observe-before');
		invocation = InvocationRecordSchema.parse({ ...invocation, status: 'running' });
		await store.started(invocation);
		phase('record-start');
		const processResult = await spawnEvidence(
			spawn, registration.argv, context.worktreeDir, stdin, runtimeLimits,
			context.environment ?? {}, maxDiagnosticBytes, callbacks.onDiagnostics,
		);
		({ stdout, exitCode, signal, failureReason } = processResult);
		phase('adapter-process');
		after = await context.observeSource();
		assertSource(after, request, context);
		phase('observe-after');
		verifyEvidenceRegistration(context.worktreeDir, registration, assertAllowed);
		phase('verify-after');
		if (failureReason || signal || exitCode === null) throw new Error(failureReason ?? 'process-interrupted');
		report = EvidenceReportSchema.parse(JSON.parse(stdout.toString('utf8')));
		assertQualifiedReport(report);
		validateEvidenceReportForRequest(report, request, { ...invocation, exitCode });
		verifyEvidenceArtifacts(context.artifactDirectory, report, registration);
		phase('report-and-artifacts');
		status = exitCode === 0 && report.cases.every((item) => item.outcome === 'passed') ? 'passed' :
			report.cases.some((item) => item.outcome === 'incomplete' || item.outcome === 'not-run') ? 'incomplete' : 'failed';
		if (status === 'failed') failureReason = 'evidence-cases-failed';
	} catch (error) {
		// Never persist attacker-controlled reports, diagnostics, or exception messages as reasons.
		const known = new Set([
			'timeout', 'spawn-failed', 'process-error', 'stdin-error', 'report-byte-limit',
			'process-cleanup-failed', 'unqualified-evidence-executable', 'unqualified-evidence-adapter',
			'candidate-source-or-preparation-changed', 'frozen-adapter-file-changed',
			'artifact-directory-not-fresh', 'evidence-path-not-authorized', 'process-interrupted',
			'artifact-count-limit', 'artifact-manifest-mismatch', 'undeclared-attempt-artifact',
			'unsafe-directory', 'unsafe-file-path', 'invalid-file-size-or-kind',
		]);
		failureReason = error instanceof Error && known.has(error.message) ? error.message : 'invalid-evidence';
		// The unclassified cause is operator-visible only through the diagnostics callback, never in durable evidence.
		if (callbacks.onDiagnostics && error instanceof Error) {
			try { callbacks.onDiagnostics(`evidence-port: ${sanitizeEvidenceDiagnostic(error.message, maxDiagnosticBytes)}`); }
			catch { /* Diagnostics never affect durable completion. */ }
		}
	}
	if (callbacks.onDiagnostics) {
		try { callbacks.onDiagnostics(`evidence-timing: ${phases.join(' ')}`); }
		catch { /* Diagnostics never affect durable completion. */ }
	}
	const reportHash = hashEvidenceBytes(stdout);
	const artifactManifestHash = sha256(report?.artifacts ?? []);
	invocation = InvocationRecordSchema.parse({
		...invocation, status: status === 'passed' ? 'completed' : signal ? 'interrupted' : 'failed',
		finishedAt: now().toISOString(), exitCode, reportHash, artifactManifestHash, failureReason,
	});
	const receipt = EvidenceReceiptSchema.parse({
		schemaVersion: '1.0.0', operationId: request.operationId, requestHash, bindingHash,
		adapterBindingHash: request.adapterBindingHash, invocationRecordHash: sha256(invocation),
		reportHash, artifactManifestHash,
		dischargedObligationIds: status === 'passed' ? request.obligations.map((item) => item.obligationId) : [],
		status,
	});
	const completion: EvidenceCompletion = {
		invocation, receipt, report,
		observations: { before, after, signal, durationMs: Date.now() - startMs },
	};
	await store.complete(completion);
	return { ...completion, reused: false };
}
