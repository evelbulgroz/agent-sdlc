#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
	VALID_PROMPT_ROLES,
	VALID_FRICTION_SIGNALS,
	CLOSED_FRICTION_CATEGORIES,
	validateFindingKey,
	validateProposedDiff,
	validateRunId,
	SkillFindingsSyncArtifactSchema,
	sha256,
	type FrictionSignal,
	type PromptRole,
} from '../policy/contracts.ts';
import { SdlcError, asSdlcError, exitCodeForError } from '../policy/errors.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { RepositoryModelGovernor } from '../adapters/model-governor.ts';
import { validateOperationRequest } from '@evelbulgroz/model-usage-govenor/policy';

const ALL_CATEGORIES = Object.values(CLOSED_FRICTION_CATEGORIES).flat();

export interface TraceAuditorGovernorLike {
	assertAvailable(): Promise<unknown>;
	execute(request: Record<string, unknown>): Promise<{ output?: unknown }>;
}

export interface PersistedFrictionFinding {
	findingId: string;
	roleId: PromptRole;
	signalType: FrictionSignal;
	category: string;
	findingKey: string;
	status: 'PROVISIONAL' | 'RECOMMENDED' | 'APPLIED' | 'REJECTED';
	attributionLayer: 'layer1' | 'layer3' | 'layer5';
	evidence: Record<string, unknown>;
	proposedDiff: string | null;
}

export interface TraceSkillAuditorResult {
	ok: true;
	runId: string;
	findings: PersistedFrictionFinding[];
	syncArtifactPath?: string;
	message: string;
}

export const ATTRIBUTION_OUTPUT_SCHEMA = {
	type: 'object',
	required: ['findings'],
	additionalProperties: false,
	properties: {
		findings: {
			type: 'array',
			items: {
				type: 'object',
				// OpenAI strict structured-output mode requires every declared
				// property to be listed in `required`; optional semantics are
				// expressed via nullable (anyOf [..., null]) types instead of
				// omission from `required`.
				required: [
					'roleId',
					'signalType',
					'category',
					'attributionLayer',
					'explanation',
					'evidence',
					'proposedDiff',
				],
				additionalProperties: false,
				properties: {
					roleId: { type: 'string', enum: VALID_PROMPT_ROLES },
					signalType: { type: 'string', enum: VALID_FRICTION_SIGNALS },
					category: { type: 'string', enum: ALL_CATEGORIES },
					attributionLayer: { type: 'string', enum: ['layer1', 'layer3', 'layer5'] },
					explanation: { type: 'string' },
					// A free-form open dict (`type: 'object'` with no enumerated
					// properties) is not expressible in the governed structured-output
					// subset (every object node must enumerate properties and set
					// additionalProperties: false). Evidence is instead a short
					// free-text note; callers wrap it back into the `evidence: {}`
					// object shape the persisted artifact schema expects.
					evidence: { anyOf: [{ type: 'string' }, { type: 'null' }] },
					proposedDiff: { anyOf: [{ type: 'string' }, { type: 'null' }] },
				},
			},
		},
	},
};

/**
 * Runs governed trace attribution analysis on a completed SDLC run.
 * Follows the Ratchet Pattern (Layer 1 deterministic > Layer 5 incubator > Layer 3 prompt).
 * Atomically writes findings into SQLite and emits PROMPT_FRICTION_ANALYZED without revision bump.
 * Synchronously writes a git-tracked sync artifact to .agents/trace-findings/<run-id>.json.
 */
export async function runTraceSkillAuditor({
	runId,
	rootDir = REPOSITORY_ROOT,
	governor = null,
}: {
	runId: string;
	rootDir?: string;
	governor?: TraceAuditorGovernorLike | null;
	options?: Record<string, unknown>;
}): Promise<TraceSkillAuditorResult> {
	validateRunId(runId);

	const storePath = path.join(rootDir, 'tools/.agent-sdlc', runId, 'runtime.sqlite');
	if (!fs.existsSync(storePath)) {
		throw new SdlcError('RUN_NOT_FOUND', `Run ${runId} not found at ${storePath}`, { runId });
	}

	const store = new RuntimeStore(storePath);
	try {
		const failedTools = store.database
			.prepare(
				'SELECT execution_id, role_id, tool_name, exit_code, input_hash, created_at FROM tool_executions WHERE run_id = ? AND exit_code IS NOT NULL AND exit_code != 0',
			)
			.all(runId);

		const runRow = store.database
			.prepare('SELECT state, semantic_repairs_count FROM runs WHERE run_id = ?')
			.get(runId) as { state?: string; semantic_repairs_count?: number } | undefined;
		const repairCount = runRow?.semantic_repairs_count ?? 0;

		const qaReviewRows = store.database
			.prepare(
				"SELECT review_id, findings_count, has_p1, findings_json FROM critic_reviews WHERE run_id = ? AND phase = 'qa'",
			)
			.all(runId) as Array<{
			review_id?: string;
			findings_count?: number;
			has_p1?: number;
			findings_json?: string | null;
		}>;
		const qaReviews = qaReviewRows.filter((r) => {
			if (!r.findings_json) return false;
			try {
				const parsed: unknown = JSON.parse(r.findings_json);
				const findings = Array.isArray(parsed)
					? parsed
					: parsed && typeof parsed === 'object' && 'findings' in parsed && Array.isArray(parsed.findings)
						? parsed.findings
						: [];
				return findings.some((f: unknown) => {
					const rec = f && typeof f === 'object' ? (f as Record<string, unknown>) : {};
					return /GAP|DIVERGENT/i.test(
						`${String(rec.evidence ?? '')} ${String(rec.message ?? '')} ${String(rec.ruleId ?? '')}`,
					);
				});
			} catch {
				return /GAP|DIVERGENT/i.test(r.findings_json);
			}
		});

		const frictionEvents = store.database
			.prepare("SELECT event_type, event_json FROM events WHERE run_id = ? AND event_type = 'PROMPT_FRICTION_DETECTED'")
			.all(runId);

		if (failedTools.length === 0 && repairCount === 0 && qaReviews.length === 0 && frictionEvents.length === 0) {
			return {
				ok: true,
				runId,
				findings: [],
				message: `No prompt friction detected for run ${runId}`,
			};
		}

		const prompt = [
			'You are the SDLC Trace Attribution Auditor.',
			'Analyze the following prompt friction and failure signals for this run and attribute root causes.',
			'',
			'ARCHITECTURAL RATCHET PATTERN RULES:',
			'1. Layer 1 (Deterministic/Mechanical): If the error is mechanical (e.g. missing script in package.json, contract drift, type error, Semgrep rule, leak, test failure), attribute to "layer1". NEVER propose prompt diffs for layer1.',
			'2. Layer 5 (Domain Pitfalls / Incubator): If the error represents an ad-hoc domain quirk or framework edge case, attribute to "layer5".',
			'3. Layer 3 (Procedural / Role Prompts): ONLY attribute to "layer3" if the prompt instructions in .agents/workflows/prompts/<role>.md were genuinely ambiguous, contradictory, or missing expected workflow sequence.',
			'',
			'CLOSED VOCABULARY:',
			`- Roles: ${JSON.stringify(VALID_PROMPT_ROLES)}`,
			`- Signals: ${JSON.stringify(VALID_FRICTION_SIGNALS)}`,
			`- Categories: ${JSON.stringify(CLOSED_FRICTION_CATEGORIES)}`,
			'',
			'EVIDENCE:',
			`- Semantic repairs count: ${repairCount}`,
			`- Failed tool executions: ${JSON.stringify(failedTools, null, 2)}`,
			`- QA critic reviews: ${JSON.stringify(qaReviews, null, 2)}`,
			'',
			'Output ONLY a valid JSON object matching the requested schema.',
		].join('\n');

		const resolvedGovernor: TraceAuditorGovernorLike =
			governor ?? new RepositoryModelGovernor({ rootDir });
		try {
			await resolvedGovernor.assertAvailable();
		} catch (err: unknown) {
			throw asSdlcError(err);
		}

		const operationId = crypto.randomUUID();
		const auditRunId = `trace-audit-${runId}`;
		const request = {
			schemaVersion: '1.0.0',
			operationId,
			runId: auditRunId,
			consumer: 'agent-sdlc',
			profile: 'trace-attribution',
			attribution: {
				taskId: sha256(runId).slice(0, 24),
				nodeId: 'trace-skill-auditor',
				roleId: 'auditor',
				generation: 0,
				nodeAttempt: 1,
				phase: 'attribution',
			},
			prompt,
			structuredOutputSchema: ATTRIBUTION_OUTPUT_SCHEMA,
			routingConstraints: {
				requiredCapabilities: ['structured-output'],
				strategy: 'quality-first',
				minQualityTier: 3,
			},
		};

		validateOperationRequest(request);

		let modelResponse: { output?: unknown };
		try {
			modelResponse = await resolvedGovernor.execute(request);
		} catch (err: unknown) {
			const errObj =
				err && typeof err === 'object' ? (err as { code?: unknown; message?: unknown }) : {};
			const errMessage = typeof errObj.message === 'string' ? errObj.message : '';
			if (
				errObj.code === 'GOVERNOR_CONCURRENCY_DENIED' ||
				errMessage.includes('concurrency') ||
				errMessage.includes('rate limit')
			) {
				throw new SdlcError(
					'GOVERNOR_CONCURRENCY_DENIED',
					'Governor concurrency limit reached. Please retry after in-flight operations complete.',
					{ runId, originalError: errMessage },
				);
			}
			throw asSdlcError(err);
		}

		const rawOutput = modelResponse.output;
		let parsedOutput: Record<string, unknown>;
		if (typeof rawOutput === 'string') {
			try {
				const parsed: unknown = JSON.parse(rawOutput);
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
					throw new Error('Parsed JSON is not an object');
				}
				parsedOutput = parsed as Record<string, unknown>;
			} catch (e: unknown) {
				const message = e instanceof Error ? e.message : String(e);
				throw new SdlcError('MODEL_OUTPUT_INVALID', `Model returned invalid JSON: ${message}`, {
					runId,
					rawOutput,
				});
			}
		} else if (rawOutput && typeof rawOutput === 'object' && !Array.isArray(rawOutput)) {
			parsedOutput = rawOutput as Record<string, unknown>;
		} else {
			throw new SdlcError('MODEL_OUTPUT_INVALID', 'Model returned empty or non-object output', {
				runId,
			});
		}

		if (!Array.isArray(parsedOutput.findings)) {
			throw new SdlcError(
				'MODEL_OUTPUT_INVALID',
				"Model output missing 'findings' array",
				{ runId, output: parsedOutput },
			);
		}

		const validatedFindings: PersistedFrictionFinding[] = [];
		for (const rawFinding of parsedOutput.findings) {
			const f =
				rawFinding && typeof rawFinding === 'object'
					? (rawFinding as Record<string, unknown>)
					: {};
			const roleId = typeof f.roleId === 'string' ? f.roleId : '';
			if (!(VALID_PROMPT_ROLES as readonly string[]).includes(roleId)) {
				throw new SdlcError(
					'MODEL_OUTPUT_INVALID',
					`Invalid roleId '${roleId}'. Must be one of: ${VALID_PROMPT_ROLES.join(', ')}`,
					{ runId, finding: f },
				);
			}
			const signalType = typeof f.signalType === 'string' ? f.signalType : '';
			if (!(VALID_FRICTION_SIGNALS as readonly string[]).includes(signalType)) {
				throw new SdlcError(
					'MODEL_OUTPUT_INVALID',
					`Invalid signalType '${signalType}'. Must be one of: ${VALID_FRICTION_SIGNALS.join(', ')}`,
					{ runId, finding: f },
				);
			}
			const category = typeof f.category === 'string' ? f.category : '';
			const validCategories = CLOSED_FRICTION_CATEGORIES[signalType as FrictionSignal] as
				| readonly string[]
				| undefined;
			if (!validCategories || !validCategories.includes(category)) {
				throw new SdlcError(
					'MODEL_OUTPUT_INVALID',
					`Invalid category '${category}' for signal '${signalType}'. Must be one of: ${validCategories?.join(', ')}`,
					{ runId, finding: f },
				);
			}
			const findingKey = `[${roleId}] ${signalType}:${category}`;
			try {
				validateFindingKey(findingKey);
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				throw new SdlcError('MODEL_OUTPUT_INVALID', message, { runId, finding: f });
			}

			const attributionLayer = typeof f.attributionLayer === 'string' ? f.attributionLayer : '';
			if (
				attributionLayer !== 'layer1' &&
				attributionLayer !== 'layer3' &&
				attributionLayer !== 'layer5'
			) {
				throw new SdlcError(
					'MODEL_OUTPUT_INVALID',
					`Invalid attributionLayer '${attributionLayer}'. Must be layer1, layer3, or layer5`,
					{ runId, finding: f },
				);
			}

			const proposedDiff =
				attributionLayer === 'layer3' && typeof f.proposedDiff === 'string'
					? validateProposedDiff(f.proposedDiff, roleId)
					: null;

			const evidence: Record<string, unknown> =
				typeof f.evidence === 'string' && f.evidence.trim().length > 0
					? { note: f.evidence }
					: { explanation: f.explanation };

			validatedFindings.push({
				findingId:
					typeof f.findingId === 'string' && f.findingId.length > 0
						? f.findingId
						: `find-${crypto.randomUUID().slice(0, 8)}`,
				roleId: roleId as PromptRole,
				signalType: signalType as FrictionSignal,
				category,
				findingKey,
				status: 'PROVISIONAL',
				attributionLayer,
				evidence,
				proposedDiff,
			});
		}

		const recordResult = store.recordFrictionAnalyzed({
			runId,
			findings: validatedFindings,
		}) as { findings: PersistedFrictionFinding[] };

		const artifactData = {
			schemaVersion: '1.0.0' as const,
			runId,
			analyzedAt: new Date().toISOString(),
			findings: recordResult.findings.map((f) => ({
				findingId: f.findingId,
				roleId: f.roleId,
				signalType: f.signalType,
				category: f.category,
				findingKey: f.findingKey,
				status: f.status,
				attributionLayer: f.attributionLayer,
				evidence: f.evidence ?? {},
				proposedDiff: f.proposedDiff ?? null,
			})),
		};
		SkillFindingsSyncArtifactSchema.parse(artifactData);

		const artifactDir = path.join(rootDir, '.agents/trace-findings');
		fs.mkdirSync(artifactDir, { recursive: true });
		const artifactPath = path.join(artifactDir, `${runId}.json`);
		fs.writeFileSync(artifactPath, `${JSON.stringify(artifactData, null, 2)}\n`, 'utf8');

		return {
			ok: true,
			runId,
			findings: recordResult.findings,
			syncArtifactPath: artifactPath,
			message: `Attributed ${recordResult.findings.length} finding(s) for run ${runId}`,
		};
	} finally {
		store.close();
	}
}

function parseCliArgs(args: readonly string[]): {
	runId: string | null;
	rootDir: string;
	json: boolean;
} {
	let runId: string | null = null;
	let rootDir = REPOSITORY_ROOT;
	let json = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const nextArg = args[i + 1];
		if (arg === '--run' && nextArg !== undefined) {
			runId = nextArg;
			i += 1;
		} else if (arg === '--root' && nextArg !== undefined) {
			rootDir = path.resolve(nextArg);
			i += 1;
		} else if (arg === '--json') {
			json = true;
		}
	}

	return { runId, rootDir, json };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
	const { runId, rootDir, json } = parseCliArgs(argv);
	if (!runId) {
		process.stderr.write('Usage: node trace-skill-auditor.mjs --run <run-id> [--root <path>] [--json]\n');
		process.exitCode = 64;
		return;
	}

	try {
		const result = await runTraceSkillAuditor({ runId, rootDir });
		if (json) {
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			process.stdout.write(`✔ ${result.message}\n`);
			for (const f of result.findings) {
				process.stdout.write(`  - ${f.findingKey} -> ${f.attributionLayer} (${f.status})\n`);
			}
			if (result.syncArtifactPath) {
				process.stdout.write(`  Artifact: ${result.syncArtifactPath}\n`);
			}
		}
		process.exitCode = 0;
	} catch (error: unknown) {
		const typed = asSdlcError(error);
		if (json) {
			process.stdout.write(`${JSON.stringify({ ok: false, error: typed.toJSON() })}\n`);
		} else {
			process.stderr.write(`${typed.code}: ${typed.message}\n`);
		}
		process.exitCode = exitCodeForError(typed);
	}
}

function isDirectExecution(): boolean {
	if (!process.argv[1]) return false;
	try {
		return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
	}
}

if (isDirectExecution()) {
	main();
}
