#!/usr/bin/env node

/**
 * Passive validator for run-folder status.json files against schema v1.
 * Enforces handoff schema, enum validity, retry limits, and monotonic revisions.
 *
 * READ-ONLY: Never mutates status.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_STATES, validateHostInvocation } from './policy/contracts.ts';

export interface ValidateStatusOptions {
	previous?: unknown;
}

export interface ValidateStatusResult {
	ok: boolean;
	errors: string[];
}

const VALID_LANES = new Set([
	'automation',
	'agent',
	'escalate',
	'lane:automation',
	'lane:agent',
	'lane:escalate',
]);

const VALID_PHASES = new Set([
	'spec',
	'implement',
	'verify',
	'review',
	'repair',
	'done',
	'escalated',
	'blocked',
	'abandoned',
]);

const ALLOWED_PHASE_TRANSITIONS: Record<string, Set<string>> = {
	spec: new Set(['spec', 'implement', 'review', 'blocked', 'escalated', 'abandoned']),
	implement: new Set(['implement', 'verify', 'repair', 'review', 'done', 'blocked', 'escalated', 'abandoned']),
	verify: new Set(['verify', 'done', 'repair', 'review', 'blocked', 'escalated', 'abandoned']),
	review: new Set(['review', 'implement', 'repair', 'verify', 'done', 'blocked', 'escalated', 'abandoned']),
	repair: new Set(['repair', 'verify', 'implement', 'review', 'done', 'blocked', 'escalated', 'abandoned']),
	escalated: new Set(['escalated', 'spec', 'implement', 'verify', 'repair', 'done', 'abandoned']),
	blocked: new Set(['blocked', 'spec', 'implement', 'verify', 'repair', 'abandoned', 'escalated']),
	done: new Set(['done']),
	abandoned: new Set(['abandoned']),
};

const VALID_CHANGE_CLASSES = new Set(['A', 'B', 'C', 'D', 'E']);

const VALID_TASK_STATUSES = new Set([
	'pending',
	'planned',
	'in_progress',
	'in-progress',
	'blocked',
	'done',
	'completed',
	'cancelled',
]);

const VALID_PREFLIGHT_STATUSES = new Set<unknown>([
	null,
	'OK',
	'FAIL',
	'PARTIAL',
	'ok',
	'fail',
	'partial',
	'not_run',
	'pass',
]);

const HASH_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Validate a status.json object.
 */
export function validateStatus(
	statusInput: unknown,
	options: ValidateStatusOptions = {},
): ValidateStatusResult {
	const errors: string[] = [];

	if (!statusInput || typeof statusInput !== 'object') {
		return { ok: false, errors: ['status is not a valid JSON object'] };
	}

	const status = statusInput as Record<string, unknown>;

	// 1. schemaVersion
	if (status.schemaVersion !== 1 && status.schemaVersion !== '1' && status.schemaVersion !== '1.0.0') {
		errors.push(`Invalid or missing schemaVersion: expected 1, got ${JSON.stringify(status.schemaVersion)}`);
	}

	// 2. revision
	if (typeof status.revision !== 'number' || !Number.isInteger(status.revision) || status.revision < 1) {
		errors.push(`Invalid revision: expected positive integer, got ${JSON.stringify(status.revision)}`);
	}

	// 3. runId
	if (typeof status.runId !== 'string' || status.runId.trim().length === 0) {
		errors.push(`Invalid or missing runId: expected non-empty string`);
	}

	// 4. updatedAt
	if (typeof status.updatedAt !== 'string' || Number.isNaN(Date.parse(status.updatedAt))) {
		errors.push(`Invalid or missing updatedAt: expected ISO timestamp, got ${JSON.stringify(status.updatedAt)}`);
	}

	// 5. git
	const gitRecord = status.git && typeof status.git === 'object' ? (status.git as Record<string, unknown>) : null;
	if (!gitRecord) {
		errors.push(`Missing or invalid git object`);
	} else {
		if (typeof gitRecord.branch !== 'string' || gitRecord.branch.trim().length === 0) {
			errors.push(`Invalid git.branch: expected non-empty string`);
		}
		if (typeof gitRecord.headSha !== 'string' || gitRecord.headSha.trim().length === 0) {
			errors.push(`Invalid git.headSha: expected non-empty string`);
		}
		if (typeof gitRecord.dirty !== 'boolean') {
			errors.push(`Invalid git.dirty: expected boolean`);
		}
	}

	// 6. lane
	if (typeof status.lane !== 'string' || !VALID_LANES.has(status.lane)) {
		errors.push(`Invalid lane: got ${JSON.stringify(status.lane)}, expected one of: ${[...VALID_LANES].join(', ')}`);
	}

	// 7. phase
	if (typeof status.phase !== 'string' || !VALID_PHASES.has(status.phase)) {
		errors.push(`Invalid phase: got ${JSON.stringify(status.phase)}, expected one of: ${[...VALID_PHASES].join(', ')}`);
	}

	// 8. activeOwner
	const isTerminal = status.phase === 'done' || status.phase === 'abandoned';
	if (isTerminal && status.activeOwner === null) {
		// Terminal runs may release activeOwner to null
	} else if (typeof status.activeOwner !== 'string' || status.activeOwner.trim().length === 0) {
		errors.push(`Invalid activeOwner: expected non-empty string${isTerminal ? ' or null' : ''}`);
	}

	// 9. changeClass
	if (typeof status.changeClass !== 'string' || !VALID_CHANGE_CLASSES.has(status.changeClass)) {
		errors.push(`Invalid changeClass: got ${JSON.stringify(status.changeClass)}, expected A, B, C, D, or E`);
	}

	// 10. retry
	const retryRecord =
		status.retry && typeof status.retry === 'object' ? (status.retry as Record<string, unknown>) : null;
	if (!retryRecord) {
		errors.push(`Missing retry object`);
	} else {
		if (typeof retryRecord.count !== 'number' || retryRecord.count < 0) {
			errors.push(`Invalid retry.count: expected non-negative integer`);
		}
		const maxRetries = retryRecord.maxRetries ?? retryRecord.max ?? 2;
		if (typeof maxRetries !== 'number' || maxRetries < 0) {
			errors.push(`Invalid retry.maxRetries: expected non-negative integer`);
		}

		// Autonomous repair cap enforcement: max 2 retries before mandatory escalation
		const isEscalationLane = status.lane === 'escalate' || status.lane === 'lane:escalate';
		const maxAllowed = typeof maxRetries === 'number' ? Math.min(maxRetries, 2) : 2;
		if (typeof retryRecord.count === 'number' && retryRecord.count > maxAllowed && !isEscalationLane) {
			errors.push(`Autonomous retry cap exceeded (retry.count=${retryRecord.count} > ${maxAllowed}) without lane:escalate`);
		}
	}

	// 11. packages
	if (!Array.isArray(status.packages)) {
		errors.push(`Invalid packages: expected array of package paths`);
	}

	// 12. tasks
	if (!Array.isArray(status.tasks)) {
		errors.push(`Invalid tasks: expected array of task items`);
	} else {
		for (let i = 0; i < status.tasks.length; i++) {
			const taskRaw = status.tasks[i];
			if (!taskRaw || typeof taskRaw !== 'object') {
				errors.push(`Task [${i}] is not an object`);
				continue;
			}
			const task = taskRaw as Record<string, unknown>;
			if (!task.id || typeof task.id !== 'string') {
				errors.push(`Task [${i}] missing valid string id`);
			}
			if (task.status && (typeof task.status !== 'string' || !VALID_TASK_STATUSES.has(task.status))) {
				errors.push(`Task [${i}] has invalid status: ${JSON.stringify(task.status)}`);
			}
		}
	}

	// 13. verification & phase completion gate
	const verificationRecord =
		status.verification && typeof status.verification === 'object'
			? (status.verification as Record<string, unknown>)
			: null;
	const preflightRecord =
		verificationRecord?.preflight && typeof verificationRecord.preflight === 'object'
			? (verificationRecord.preflight as Record<string, unknown>)
			: null;
	if (verificationRecord) {
		const pfStatus = preflightRecord?.status;
		if (
			pfStatus !== undefined &&
			pfStatus !== null &&
			(typeof pfStatus !== 'string' || !VALID_PREFLIGHT_STATUSES.has(pfStatus))
		) {
			errors.push(`Invalid verification.preflight.status: ${JSON.stringify(pfStatus)}`);
		}
	}

	if (status.phase === 'done') {
		const pfStatus = preflightRecord?.status;
		if (pfStatus !== 'OK' && pfStatus !== 'ok') {
			errors.push(`Terminal phase 'done' requires verification.preflight.status == 'OK', got ${JSON.stringify(pfStatus)}`);
		}
	}

	// 14. Optional LangGraph orchestration projection
	if (status.orchestration !== undefined) {
		const orchestrationRaw = status.orchestration;
		if (!orchestrationRaw || typeof orchestrationRaw !== 'object' || Array.isArray(orchestrationRaw)) {
			errors.push(`Invalid orchestration: expected object`);
		} else {
			const orchestration = orchestrationRaw as Record<string, unknown>;
			const allowedKeys = new Set([
				'mode',
				'schemaVersion',
				'runtimeRevision',
				'state',
				'eventLogHash',
				'draftHash',
				'pendingInterruptId',
				'projectionHash',
			]);
			for (const key of Object.keys(orchestration)) {
				if (!allowedKeys.has(key)) errors.push(`Invalid orchestration field: ${key}`);
			}
			if (orchestration.mode !== 'langgraph') {
				errors.push(`Invalid orchestration.mode: expected "langgraph"`);
			}
			if (orchestration.schemaVersion !== '1.0.0') {
				errors.push(`Invalid orchestration.schemaVersion: expected "1.0.0"`);
			}
			if (
				typeof orchestration.runtimeRevision !== 'number' ||
				!Number.isSafeInteger(orchestration.runtimeRevision) ||
				orchestration.runtimeRevision < 0
			) {
				errors.push(`Invalid orchestration.runtimeRevision: expected non-negative integer`);
			}
			if (
				typeof orchestration.state !== 'string' ||
				!(RUNTIME_STATES as readonly string[]).includes(orchestration.state)
			) {
				errors.push(`Invalid orchestration.state: ${JSON.stringify(orchestration.state)}`);
			}
			for (const field of ['eventLogHash', 'draftHash', 'projectionHash']) {
				const value = orchestration[field];
				if (
					value !== null &&
					(typeof value !== 'string' || !HASH_PATTERN.test(value))
				) {
					errors.push(`Invalid orchestration.${field}: expected SHA-256 hash or null`);
				}
			}
			if (
				orchestration.pendingInterruptId !== null &&
				(typeof orchestration.pendingInterruptId !== 'string' ||
					orchestration.pendingInterruptId.length === 0)
			) {
				errors.push(`Invalid orchestration.pendingInterruptId`);
			}
			if (retryRecord?.source !== 'runtime.sqlite') {
				errors.push(`Orchestrated status requires retry.source == "runtime.sqlite"`);
			}
			if (status.phase === 'done') {
				const isCommittedDone =
					orchestration.state === 'DONE' &&
					typeof gitRecord?.worktreePath === 'string' &&
					gitRecord.worktreePath.length > 0 &&
					typeof gitRecord?.branch === 'string' &&
					gitRecord.branch !== 'unknown' &&
					gitRecord.branch !== 'detached' &&
					typeof gitRecord?.headSha === 'string' &&
					gitRecord.headSha.length === 40 &&
					preflightRecord?.status === 'OK' &&
					preflightRecord?.gitHeadSha === gitRecord.headSha;

				if (!isCommittedDone) {
					errors.push(
						"Orchestrated status cannot project phase 'done' without verified git landing and preflight OK",
					);
				}
			}
		}
	}

	// 15. Optional host continuation card. Older files omit it. A present card must match the closed shape.
	if (status.hostInvocation !== undefined) {
		try {
			validateHostInvocation(status.hostInvocation);
		} catch (error) {
			errors.push(`Invalid hostInvocation: ${(error as Error).message}`);
		}
	}

	// 16. Transition checks against previous status
	if (options.previous && typeof options.previous === 'object') {
		const prev = options.previous as Record<string, unknown>;
		if (typeof prev.revision === 'number' && typeof status.revision === 'number') {
			if (status.revision <= prev.revision) {
				errors.push(`Non-monotonic revision: current revision (${status.revision}) must be > previous (${prev.revision})`);
			}
		}
		if (prev.runId && status.runId && prev.runId !== status.runId) {
			errors.push(`Run ID mismatch: previous (${String(prev.runId)}) vs current (${String(status.runId)})`);
		}
		if (prev.phase === 'done' && status.phase !== 'done') {
			errors.push(`Invalid transition: terminal phase 'done' cannot transition to '${String(status.phase)}'`);
		}
		if (prev.phase === 'abandoned' && status.phase !== 'abandoned') {
			errors.push(`Invalid transition: terminal phase 'abandoned' cannot transition to '${String(status.phase)}'`);
		}
		if (typeof prev.phase === 'string' && typeof status.phase === 'string') {
			const allowedNext = ALLOWED_PHASE_TRANSITIONS[prev.phase];
			if (allowedNext && !allowedNext.has(status.phase)) {
				errors.push(`Invalid phase transition from '${prev.phase}' to '${status.phase}'`);
			}
		}
	}

	return {
		ok: errors.length === 0,
		errors,
	};
}

/**
 * Resolve target path to status.json file.
 */
function resolveStatusFile(targetPath: string): string | null {
	const resolved = path.resolve(targetPath);
	if (!fs.existsSync(resolved)) {
		return null;
	}
	const stat = fs.statSync(resolved);
	if (stat.isDirectory()) {
		const nested = path.join(resolved, 'status.json');
		return fs.existsSync(nested) ? nested : null;
	}
	return resolved;
}

// CLI runner
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		console.error('Usage: node tools/agent-status-validate.mjs <run-folder-or-status.json> [--previous <prior-status.json>]');
		process.exit(1);
	}
	if (args.includes('--help') || args.includes('-h')) {
		console.log('Usage: node tools/agent-status-validate.mjs <run-folder-or-status.json> [--previous <prior-status.json>]');
		console.log('Validates status.json schema, enums, retry caps, and monotonic revisions.');
		process.exit(0);
	}

	let targetPath: string | null = null;
	let previousPath: string | null = null;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--previous' || arg === '-p') {
			previousPath = args[++i] ?? null;
		} else if (arg && !arg.startsWith('-') && !targetPath) {
			targetPath = arg;
		}
	}

	if (!targetPath) {
		console.error('agent-status-validate: ERROR: Target path required');
		process.exit(1);
	}

	const statusFile = resolveStatusFile(targetPath);
	if (!statusFile) {
		console.error(`agent-status-validate: ERROR: status.json not found at '${targetPath}'`);
		process.exit(1);
	}

	let status: Record<string, unknown>;
	try {
		status = JSON.parse(fs.readFileSync(statusFile, 'utf8')) as Record<string, unknown>;
	} catch (err) {
		console.error(`agent-status-validate: ERROR: Failed to parse JSON from '${statusFile}':`, (err as Error).message);
		process.exit(1);
	}

	let previous: unknown = null;
	if (previousPath) {
		const prevFile = resolveStatusFile(previousPath);
		if (!prevFile) {
			console.error(`agent-status-validate: ERROR: Previous status.json not found at '${previousPath}'`);
			process.exit(1);
		}
		try {
			previous = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
		} catch (err) {
			console.error(`agent-status-validate: ERROR: Failed to parse previous JSON from '${prevFile}':`, (err as Error).message);
			process.exit(1);
		}
	}

	const result = validateStatus(status, { previous });

	if (result.ok) {
		console.log(`agent-status-validate: OK (${statusFile}, revision ${String(status?.revision)}, phase ${String(status?.phase)})`);
		process.exit(0);
	} else {
		console.error(`agent-status-validate: FAIL (${statusFile}):`);
		for (const err of result.errors) {
			console.error(`  - ${err}`);
		}
		process.exit(1);
	}
}

function isDirectExecution(): boolean {
	if (!process.argv[1]) return false;
	const base = path.basename(process.argv[1]);
	if (base === 'agent-status-validate.mjs' || base === 'agent-status-validate.ts') {
		return true;
	}
	try {
		const argvPath = fs.realpathSync(path.resolve(process.argv[1]));
		const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
		return argvPath === modulePath;
	} catch {
		return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
	}
}

if (isDirectExecution()) {
	main().catch((err) => {
		console.error('agent-status-validate: Unexpected error:', err);
		process.exit(1);
	});
}
