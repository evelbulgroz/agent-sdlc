import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sanitize } from '@evelbulgroz/model-usage-govenor/sanitize-failure-text';
import { type VerificationDiagnosticStore, recordVerificationAttempt } from '../policy/reliability.ts';
import type { MinimalToolCallRecord } from './minimal-prompt.ts';
import {
	type ParsedTestExecutionEvidence,
	parseTestExecutionEvidence,
} from './test-execution-evidence.ts';
import { type CommandExecFn, COMMAND_MAX_BUFFER_BYTES, ROLE_COMMAND_TIMEOUT_MS } from './tool-commands.ts';
import { presentPagedText } from './tool-read.ts';

export const WRITE_TOOLS: ReadonlySet<string> = new Set([
	'write_file',
	'replace_in_file',
	'replace_snapshot_range',
	'delete_file',
]);

export interface MinimalVerificationInput {
	readonly runId: string;
	readonly taskId: string;
	readonly worktreeDir: string;
	readonly verificationCommands: readonly (readonly string[])[];
	readonly acceptanceEvidenceCommand?: readonly string[] | null;
	readonly [key: string]: unknown;
}

export interface VerificationEvidence {
	readonly command: readonly string[];
	readonly exitCode: number;
	readonly pagedStdout: string;
	readonly testExecutionEvidence: ParsedTestExecutionEvidence;
}

export interface RunVerificationResult {
	readonly ok: boolean;
	readonly reason: string | null;
	readonly output: string;
	readonly exitCode?: number;
	readonly terminal: boolean;
	readonly evidence?: VerificationEvidence | null;
}

export interface CompletionValidationResult {
	readonly pass: boolean;
	readonly auditRequired?: boolean;
	readonly summary?: string;
}

export type CompletionValidatorFn = (input: {
	state: {
		toolHistory: MinimalToolCallRecord[];
		lastSubstantiveWriteStep: number;
	};
	action: { kind: 'complete' };
}) => CompletionValidationResult | null;

export interface VerificationRuntimeStoreLike {
	readonly recordDiagnostic?: VerificationDiagnosticStore['recordDiagnostic'];
	readonly listDiagnostics?: VerificationDiagnosticStore['listDiagnostics'];
}

export function computeWorktreeDigest(
	worktreeDir: unknown,
	scopePaths: readonly string[] = [],
): string {
	if (!worktreeDir || typeof worktreeDir !== 'string' || !fs.existsSync(worktreeDir)) {
		return 'empty';
	}
	const skipDirs = new Set(['.git', '.agent-sdlc', '.tmp', 'node_modules', 'dist', 'coverage']);
	const files: string[] = [];
	const collect = (targetRel: string): void => {
		const abs = path.resolve(worktreeDir, targetRel);
		if (!fs.existsSync(abs)) return;
		const stat = fs.statSync(abs);
		if (stat.isFile()) {
			files.push(path.relative(worktreeDir, abs).split(path.sep).join('/'));
			return;
		}
		if (!stat.isDirectory()) return;
		for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
			if (skipDirs.has(entry.name)) continue;
			collect(path.join(targetRel, entry.name));
		}
	};
	const roots = Array.isArray(scopePaths) && scopePaths.length > 0 ? scopePaths : ['.'];
	for (const root of roots) collect(root);
	const uniqueSorted = [...new Set(files)].sort();
	const hash = crypto.createHash('sha256');
	for (const rel of uniqueSorted) {
		const content = fs.readFileSync(path.join(worktreeDir, rel));
		const fileDigest = crypto.createHash('sha256').update(content).digest('hex');
		hash.update(`${rel}\0${fileDigest}\n`);
	}
	return hash.digest('hex');
}

export function buildAuditRequiredFeedback(digest: string): string {
	return [
		`AUDIT_REQUIRED (candidateDigest=${digest}): Verification commands and AC coverage checks passed.`,
		'Before completing, audit your live working set against every task requirement:',
		'1. Confirm every AC-NN and AC-NN.N case is genuinely implemented and asserted.',
		'2. Confirm all 4 shadow paths (unhappy, timeout, empty, boundary) and domain invariants hold.',
		'3. Confirm every authored function stays within sonarjs/cognitive-complexity <= 15 and new imports are placed after existing imports.',
		'4. If no further edits are needed, emit {"kind":"complete","summary":"..."} again without modifying files to finish.',
	].join('\n');
}

export function checkMissingAuthoredFiles(
	worktreeDir: string | null | undefined,
	authoredPaths: readonly string[] = [],
	authoredTestPaths: readonly string[] = [],
): string | null {
	if (!worktreeDir) return null;
	const required = [...new Set([...(authoredPaths ?? []), ...(authoredTestPaths ?? [])])].filter(
		(entry) => typeof entry === 'string' && entry.length > 0 && /\.[a-z0-9]+$/i.test(entry),
	);
	const missing = required.filter((relPath) => !fs.existsSync(path.join(worktreeDir, relPath)));
	if (missing.length === 0) return null;
	return `AUDIT_REQUIRED: Cannot complete until all authoredPaths and authoredTestPaths exist on disk. Missing: ${missing.join(', ')}`;
}

export function sameArgv(left: unknown, right: unknown): boolean {
	return (
		Array.isArray(left) &&
		Array.isArray(right) &&
		left.length === right.length &&
		left.every((part, index) => part === right[index])
	);
}

export function verificationArgv(input: MinimalVerificationInput): Array<readonly string[]> {
	const commands: Array<readonly string[]> = [...input.verificationCommands];
	const evidence = input.acceptanceEvidenceCommand;
	if (
		Array.isArray(evidence) &&
		evidence.length > 0 &&
		!commands.some((command) => sameArgv(command, evidence))
	) {
		commands.push(evidence);
	}
	return commands;
}

export function captureCommand(
	execCli: CommandExecFn,
	command: readonly string[],
	worktreeDir: string,
	evidenceCommand: boolean,
): { exitCode: number; stdout: string; stderr: string } {
	let exitCode = 0;
	let stdout = '';
	let stderr = '';
	const options: {
		cwd: string;
		encoding: BufferEncoding;
		stdio: ['ignore', 'pipe', 'pipe'];
		timeout: number;
		maxBuffer: number;
		env?: NodeJS.ProcessEnv;
	} = {
		cwd: worktreeDir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: ROLE_COMMAND_TIMEOUT_MS,
		maxBuffer: COMMAND_MAX_BUFFER_BYTES,
		...(evidenceCommand ? { env: { ...process.env, CI: 'true' } } : {}),
	};
	try {
		const cmd = command[0] ?? '';
		const out = execCli(cmd, command.slice(1), options);
		stdout = typeof out === 'string' ? out : (out?.toString('utf8') ?? '');
	} catch (error) {
		const errObj = error as {
			stdout?: { toString?: () => string };
			stderr?: { toString?: () => string };
			message?: string;
			status?: number;
		};
		stdout = errObj.stdout?.toString?.() ?? '';
		stderr = errObj.stderr?.toString?.() ?? errObj.message ?? '';
		exitCode = typeof errObj.status === 'number' && Number.isInteger(errObj.status) ? errObj.status : 1;
	}
	return { exitCode, stdout, stderr };
}

export function recordVerification(
	runtimeStore: VerificationRuntimeStoreLike | null | undefined,
	clock: () => number,
	input: MinimalVerificationInput,
	command: readonly string[],
	attempt: number,
	exitCode: number,
): void {
	const recordDiagnostic = runtimeStore?.recordDiagnostic;
	const listDiagnostics = runtimeStore?.listDiagnostics;
	if (typeof recordDiagnostic !== 'function' || typeof listDiagnostics !== 'function') {
		return;
	}
	recordVerificationAttempt(
		{
			recordDiagnostic: recordDiagnostic.bind(runtimeStore),
			listDiagnostics: listDiagnostics.bind(runtimeStore),
		},
		{
			schemaVersion: '1.0.0',
			attemptId: `minimal-verify:${input.taskId}:${attempt}:${crypto.randomUUID()}`,
			runId: input.runId,
			taskId: input.taskId,
			command,
			attempt,
			phase: 'post-implementation',
			status: exitCode === 0 ? 'passed' : 'failed',
			exitCode,
			occurredAt: new Date(clock()).toISOString(),
		},
	);
}

export function runVerification({
	execCli,
	runtimeStore,
	clock,
	input,
	attempt,
}: {
	execCli: CommandExecFn;
	runtimeStore: VerificationRuntimeStoreLike | null | undefined;
	clock: () => number;
	input: MinimalVerificationInput;
	attempt: number;
}): RunVerificationResult {
	const worktreeDir = input.worktreeDir;
	const chunks: string[] = [];
	let evidence: VerificationEvidence | null = null;
	for (const command of verificationArgv(input)) {
		const evidenceCommand = sameArgv(command, input.acceptanceEvidenceCommand);
		const ran = captureCommand(execCli, command, worktreeDir, evidenceCommand);
		let paged: { text: string; byteLength: number; pagedPath: string | null };
		try {
			paged = presentPagedText(`${ran.stdout}${ran.stderr}`, {
				worktreeDir,
				name: `verify-a${attempt}-${crypto.randomBytes(3).toString('hex')}`,
			});
		} catch (error) {
			const msg = error && typeof error === 'object' && 'message' in error ? error.message : '';
			if (String(msg ?? '').startsWith('page-write-failed')) {
				return { ok: false, reason: 'page-write-failed', output: '', terminal: true };
			}
			throw error;
		}
		chunks.push(paged.text);
		if (evidenceCommand) {
			const body = ran.exitCode === 0 ? ran.stdout : `${ran.stdout}\n${ran.stderr}`;
			evidence = {
				command,
				exitCode: ran.exitCode,
				pagedStdout: paged.text,
				testExecutionEvidence: parseTestExecutionEvidence(sanitize(body)),
			};
		}
		recordVerification(runtimeStore, clock, input, command, attempt, ran.exitCode);
		if (ran.exitCode !== 0) {
			return {
				ok: false,
				reason: 'verification-failed',
				output: chunks.join('\n'),
				exitCode: ran.exitCode,
				terminal: false,
				evidence,
			};
		}
	}
	return {
		ok: true,
		reason: null,
		output: chunks.join('\n'),
		exitCode: 0,
		terminal: false,
		evidence,
	};
}

export function evaluateEvidence(
	input: MinimalVerificationInput,
	toolCalls: readonly MinimalToolCallRecord[],
	verification: RunVerificationResult,
	completionValidator: CompletionValidatorFn | null | undefined,
): CompletionValidationResult | null {
	if (typeof completionValidator !== 'function') return null;
	const evidence = verification.evidence;
	const command =
		evidence?.command ?? input.acceptanceEvidenceCommand ?? input.verificationCommands?.[0];
	if (!Array.isArray(command) || command.length === 0) return null;
	let lastWrite = -1;
	const history: MinimalToolCallRecord[] = toolCalls.map((call, index) => {
		if (call.toolName && WRITE_TOOLS.has(call.toolName) && !call.result?.error && !call.result?.code) {
			lastWrite = index;
		}
		return { ...call, stepIndex: index };
	});
	const parsed = evidence?.testExecutionEvidence;
	history.push({
		toolName: 'run_allowlisted_command',
		parameters: { command: command[0], args: command.slice(1) },
		result: {
			exitCode: evidence?.exitCode ?? 0,
			stdout: evidence?.pagedStdout ?? verification.output,
			stderr: '',
			...(parsed?.format ? { testExecutionEvidence: parsed } : {}),
		},
		stepIndex: history.length,
	});
	try {
		return completionValidator({
			state: { toolHistory: history, lastSubstantiveWriteStep: lastWrite },
			action: { kind: 'complete' },
		});
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { pass: false, summary: msg };
	}
}
