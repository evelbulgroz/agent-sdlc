import { z } from 'zod';
import { commandBindingHash, recordPins, resolveExecutable, type PinSpec } from '../host/command-evidence.ts';
import type { ProductCommandConfig, ProductEvidenceConfig } from '../host/product-evidence-schema.ts';
import { sha256 } from './contracts/primitives.ts';
import {
	AuthorizedQualityPlanSchema,
	Capability,
	CommandRegistrationSchema,
	EvidenceObligationSchema,
	Id,
	Layer,
	QualityPolicySchema,
	RelPath,
	UniqueStrings,
	type AuthorizedQualityPlan,
	type CommandRegistration,
} from './contracts/quality-schema.ts';
import { SdlcError, type SdlcErrorCode } from './errors.ts';
import { evaluateTaskReadiness, type ReadinessDraftLike } from './task-planner/task-readiness.ts';
import { parseAcceptanceCriterion } from '../workflow/acceptance-criteria.ts';

export type ProductQualityCode = Extract<SdlcErrorCode, 'INVALID_INPUT' | 'AUTHORIZATION_INVALID'>;

const MAX_REPORT_BYTES = 1_048_576;
const MAX_ARTIFACT_BYTES = 16_777_216;

const PRODUCT_QUALITY_POLICY = QualityPolicySchema.parse({
	schemaVersion: '1.0.0',
	policyId: 'checkpoint-evidence-v1',
	additionalCandidateReviews: 1,
	followUpDispatches: 1,
	testRetryPolicy: 'clean-success',
	retrieval: {
		maxPacketBytes: 24_576,
		maxPacketLines: 1_000,
		maxTotalBytesPerCandidate: 49_152,
		maxTotalLinesPerCandidate: 2_000,
	},
	execution: { maxInvocations: 48, maxTotalDurationMs: 1_800_000 },
	review: { maxLogicalDispatches: 20, maxPhysicalCalls: 40, maxInputTokens: 768_000, maxOutputTokens: 192_000 },
});

const ProductObligationSchema = z.strictObject({
	obligationId: Id,
	criterionId: z.string().regex(/^AC-\d{2,}$/),
	caseId: z.string().regex(/^AC-\d{2,}\.\d+$/),
	ownerTaskId: Id,
	layer: Layer,
	profileId: Id,
	testFile: RelPath,
	caseKey: Id,
	observableOutcome: z.string().trim().min(1),
	setupAction: z.string().trim().min(1),
	expectedResult: z.string().trim().min(1),
	capabilities: UniqueStrings(Capability).optional(),
});

export const ProductObligationsDocumentSchema = z.strictObject({
	schemaVersion: z.literal('1.0.0'),
	obligations: z.array(ProductObligationSchema).min(1),
});
export type ProductObligationsDocument = z.infer<typeof ProductObligationsDocumentSchema>;
type ProductObligation = ProductObligationsDocument['obligations'][number];

export interface ProductObligationManifest {
	slices?: readonly { sliceId: string; kind?: string; acceptanceCriteria?: readonly string[] }[];
	tasks?: readonly { taskId: string; sliceId: string; acceptanceCriteria?: readonly string[] }[];
}

function fail(code: ProductQualityCode, message: string): never {
	throw new SdlcError(code, message);
}

function declaredCases(criteria: readonly string[], code: ProductQualityCode): Set<string> {
	const expected = new Set<string>();
	const criterionIds = new Set<string>();
	for (const [index, text] of criteria.entries()) {
		const parsed = parseAcceptanceCriterion(text, index);
		if (!parsed.ok) fail(code, parsed.message);
		if (criterionIds.has(parsed.id)) fail(code, `Duplicate acceptance criterion '${parsed.id}'`);
		criterionIds.add(parsed.id);
		if (parsed.cases.length === 0) {
			fail(code, `each acceptance criterion needs at least one AC-NN.N case: ${parsed.id}`);
		}
		for (const entry of parsed.cases) {
			const key = `${parsed.id}\0${entry.id}`;
			if (expected.has(key)) fail(code, `Duplicate acceptance case '${entry.id}'`);
			expected.add(key);
		}
	}
	return expected;
}

function assertCoverage(rows: readonly ProductObligation[], criteria: readonly string[], code: ProductQualityCode): void {
	const expected = declaredCases(criteria, code);
	const seen = new Set<string>();
	const ids = new Set<string>();
	for (const row of rows) {
		if (!row.caseId.startsWith(`${row.criterionId}.`)) {
			fail(code, `obligation '${row.obligationId}' case '${row.caseId}' does not belong to ${row.criterionId}`);
		}
		const key = `${row.criterionId}\0${row.caseId}`;
		if (!expected.has(key) || seen.has(key)) {
			fail(code, `Foreign or duplicate quality obligation '${row.caseId}'`);
		}
		if (ids.has(row.obligationId)) fail(code, `Duplicate obligation id '${row.obligationId}'`);
		seen.add(key);
		ids.add(row.obligationId);
	}
	if (seen.size !== expected.size) fail(code, 'Quality plan omits acceptance obligations');
}

function assertOwners(
	rows: readonly ProductObligation[],
	draft: ReadinessDraftLike,
	taskManifest: ProductObligationManifest | null,
	rootDir: string,
	code: ProductQualityCode,
): void {
	if (taskManifest) {
		for (const row of rows) {
			const task = taskManifest.tasks?.find((entry) => entry.taskId === row.ownerTaskId);
			const slice = task ? taskManifest.slices?.find((entry) => entry.sliceId === task.sliceId) : undefined;
			const taskOwns = !task?.acceptanceCriteria || task.acceptanceCriteria.includes(row.criterionId);
			if (!task || !slice || slice.kind === 'enabling' || !slice.acceptanceCriteria?.includes(row.criterionId) || !taskOwns) {
				fail(code, `obligation owner '${row.ownerTaskId}' does not own ${row.criterionId}`);
			}
		}
		return;
	}
	const readiness = evaluateTaskReadiness({ draft, rootDir });
	if (readiness.tasks.length !== 1 || readiness.tasks[0]?.taskId !== 'task-0') {
		fail(code, 'product obligations need a task manifest when planning derives more than one task');
	}
	const slice = readiness.slices.find((entry) => entry.sliceId === 'implicit-vertical');
	for (const row of rows) {
		if (row.ownerTaskId !== 'task-0' || !slice?.acceptanceCriteria.includes(row.criterionId)) {
			fail(code, `obligation owner '${row.ownerTaskId}' does not own ${row.criterionId}`);
		}
	}
}

function pathAllowed(prefixes: readonly string[], file: string): boolean {
	return prefixes.some((prefix) => {
		const base = prefix.replace(/\/+$/, '');
		return base === '.' || file === base || file.startsWith(`${base}/`);
	});
}

function pinSpec(pin: ProductCommandConfig['pins'][number]): PinSpec {
	return 'file' in pin ? { file: pin.file } : { script: { file: pin.script.file, name: pin.script.name } };
}

function registrationFor(
	rootDir: string,
	repositoryId: string,
	profileId: string,
	command: ProductCommandConfig,
	code: ProductQualityCode,
): CommandRegistration {
	let executable: { path: string; sha256: string };
	let pins: CommandRegistration['pins'];
	try {
		executable = resolveExecutable(command.argv[0], process.env.PATH ?? '');
		pins = recordPins(rootDir, command.cwd, command.pins.map(pinSpec));
	} catch (error: unknown) {
		const detail = error instanceof Error ? error.message : 'unresolvable-command-executable';
		fail(code, `product command '${profileId}' could not be pinned: ${detail}`);
	}
	const parsed = CommandRegistrationSchema.safeParse({
		kind: 'command',
		adapterId: `${repositoryId}-${profileId}`,
		protocolVersion: '1.0.0',
		argv: [...command.argv],
		cwd: command.cwd,
		reportFormat: command.format ?? 'junit',
		retries: command.retries ?? 0,
		executable,
		pins,
		commandSha256: commandBindingHash(command.argv, executable.sha256, pins),
		profiles: [{ profileId, layers: [command.layer], capabilities: command.capabilities ?? [] }],
		limits: {
			timeoutMs: command.timeoutMs ?? (command.layer === 'browser' ? 300_000 : 120_000),
			maxReportBytes: MAX_REPORT_BYTES,
			maxArtifactBytes: MAX_ARTIFACT_BYTES,
			maxArtifacts: 8,
		},
	});
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		fail(code, `product command '${profileId}' is not a valid evidence registration: ${issue?.path.join('.') || '<root>'}: ${issue?.message}`);
	}
	return parsed.data;
}

function evidenceObligations(
	rows: readonly ProductObligation[],
	registrations: readonly CommandRegistration[],
	allowedPathPrefixes: readonly string[],
	code: ProductQualityCode,
) {
	const byProfile = new Map(registrations.map((entry) => [entry.profiles[0]?.profileId, entry]));
	return rows.map((row) => {
		const registration = byProfile.get(row.profileId);
		const profile = registration?.profiles[0];
		if (!registration || !profile) fail(code, `obligation profile is not a product command: ${row.profileId}`);
		if (!profile.layers.includes(row.layer)) {
			fail(code, `obligation '${row.obligationId}' layer does not match command '${row.profileId}'`);
		}
		const capabilities = row.capabilities ?? profile.capabilities;
		if (capabilities.some((capability) => !profile.capabilities.includes(capability))) {
			fail(code, `obligation '${row.obligationId}' requires a capability command '${row.profileId}' does not provide`);
		}
		if (!pathAllowed(allowedPathPrefixes, row.testFile)) {
			fail(code, `obligation test file is outside the authorized paths: ${row.testFile}`);
		}
		const obligation = {
			obligationId: row.obligationId,
			criterionId: row.criterionId,
			caseId: row.caseId,
			owner: { kind: 'task' as const, id: row.ownerTaskId },
			observableOutcome: row.observableOutcome,
			setupAction: row.setupAction,
			expectedResult: row.expectedResult,
			layer: row.layer,
			requiredCapabilities: [...capabilities],
			implementationPaths: [row.testFile],
			testCases: [{ file: row.testFile, caseKey: row.caseKey }],
			adapterBindingHash: sha256(registration),
			profileId: row.profileId,
		};
		const parsed = EvidenceObligationSchema.safeParse(obligation);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			fail(code, `obligation '${row.obligationId}' is invalid: ${issue?.path.join('.') || '<root>'}: ${issue?.message}`);
		}
		return parsed.data;
	});
}

export interface AcceptProductObligationsInput {
	rootDir: string;
	repositoryId: string;
	productEvidence: ProductEvidenceConfig | null;
	criteria: readonly string[];
	obligations: unknown | null;
	taskManifest: ProductObligationManifest | null;
	draft: ReadinessDraftLike;
	allowedPathPrefixes: readonly string[];
	code: ProductQualityCode;
}

/**
 * Turns a host obligations document into a checkpoint-evidence plan.
 * Pins may sit inside the package the task edits; execution rehashes them and fails if they change.
 * Returns no plan when the host has not declared productEvidence and no obligations were supplied.
 */
export function acceptProductObligations(input: AcceptProductObligationsInput): {
	document: ProductObligationsDocument | null;
	plan: AuthorizedQualityPlan | undefined;
} {
	const { productEvidence, obligations, criteria, code } = input;
	if (!productEvidence && obligations === null) return { document: null, plan: undefined };
	if (!productEvidence) fail(code, 'product obligations require productEvidence on the host profile');
	const commands = productEvidence.commands;
	if (criteria.length === 0) {
		if (obligations !== null) fail(code, 'product obligations do not match an empty acceptance list');
		return { document: null, plan: undefined };
	}
	if (obligations === null) {
		fail(code, 'productEvidence requires a product obligations file covering every acceptance case');
	}
	const parsed = ProductObligationsDocumentSchema.safeParse(obligations);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		fail(code, `product obligations are invalid: ${issue?.path.join('.') || '<root>'}: ${issue?.message}`);
	}
	const document = parsed.data;
	assertCoverage(document.obligations, criteria, code);
	assertOwners(document.obligations, input.draft, input.taskManifest, input.rootDir, code);
	const used = [...new Set(document.obligations.map((row) => row.profileId))].sort();
	const registrations = used.map((profileId) => {
		const command = commands[profileId];
		if (!command) fail(code, `obligation profile is not a product command: ${profileId}`);
		return registrationFor(input.rootDir, input.repositoryId, profileId, command, code);
	});
	const plan = AuthorizedQualityPlanSchema.parse({
		qualityPolicy: PRODUCT_QUALITY_POLICY,
		adapterBindings: registrations,
		evidenceObligations: evidenceObligations(document.obligations, registrations, input.allowedPathPrefixes, code),
	});
	return { document, plan };
}
