import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { casesFromReport } from '../acceptance/command-evidence.ts';
import { readReportFile, type CaseResult } from '../acceptance/report-formats.ts';
import { selectedCaseIdentities, substituteArgv, verifyCommandRegistration } from '../host/command-evidence.ts';
import type { CommandCaseResult } from '../host/command-evidence.ts';
import type { CommandRunner, EvidenceSpawn } from '../host/evidence-types.ts';
import type { CommandRegistration, EvidenceRequest } from '../policy/contracts/quality-evidence-schema.ts';

const EXTENSIONS = { junit: 'xml', 'case-report': 'json' } as const;
const CLOCK_TOLERANCE_MS = 20;

function knownPinError(error: unknown): string | null {
	const message = error instanceof Error ? error.message : '';
	return message === 'PINNED_FILE_MODIFIED' || message === 'frozen-adapter-file-changed' ? message : null;
}

function runChild(
	executable: string,
	args: readonly string[],
	cwd: string,
	timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			cwd,
			// Unsandboxed: package scripts need the operator PATH and HOME.
			// CI=true makes a product preview server start its own process.
			env: { ...process.env, CI: 'true' },
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: timeoutMs,
		});
		child.stdout?.resume();
		child.stderr?.resume();
		child.on('error', reject);
		child.on('close', (code, signal) => resolve({ code, signal }));
	});
}

function commandCases(cases: readonly CaseResult[]): CommandCaseResult[] {
	return cases.map((entry) => {
		if (entry.outcome === 'todo') throw new Error('invalid-evidence');
		return {
			identity: entry.identity,
			...(entry.source ? { source: entry.source } : {}),
			outcome: entry.outcome,
			message: entry.message,
			attempts: entry.attempts,
		};
	});
}

const runCommand: CommandRunner = async (registration, request, worktreeDir) => {
	verifyCommandRegistration(worktreeDir, registration);
	const selected = selectedCaseIdentities(request);
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-product-evidence-'));
	try {
		return await runRegistration(registration, request, worktreeDir, directory, selected);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
};

async function runRegistration(
	registration: CommandRegistration,
	request: EvidenceRequest,
	worktreeDir: string,
	directory: string,
	selected: readonly string[],
): Promise<{ exitCode: number | null; cases: CommandCaseResult[]; reportBytes: Buffer; failureReason?: string | null }> {
	const name = `report.${EXTENSIONS[registration.reportFormat]}`;
	const reportPath = path.join(directory, name);
	const argv = substituteArgv(registration.argv, { reportPath, baseSha: request.binding?.baseCommitSha });
	const cwd = path.resolve(worktreeDir, registration.cwd);
	const started = Date.now();
	let code: number | null = null;
	let signal: NodeJS.Signals | null = null;
	try {
		const result = await runChild(registration.executable.path, argv.slice(1), cwd, registration.limits.timeoutMs);
		code = result.code;
		signal = result.signal;
	} catch {
		return { exitCode: null, cases: [], reportBytes: Buffer.alloc(0), failureReason: 'spawn-failed' };
	}
	try {
		verifyCommandRegistration(worktreeDir, registration);
	} catch (error: unknown) {
		return {
			exitCode: code, cases: [], reportBytes: Buffer.alloc(0),
			failureReason: knownPinError(error) ?? 'invalid-evidence',
		};
	}
	if (signal !== null && code === null) {
		return { exitCode: null, cases: [], reportBytes: Buffer.alloc(0), failureReason: 'timeout' };
	}
	let reportBytes: Buffer;
	try {
		reportBytes = Buffer.from(readReportFile(directory, name, {
			maxBytes: registration.limits.maxReportBytes,
			runStartedMs: started - CLOCK_TOLERANCE_MS,
		}), 'utf8');
	} catch {
		return { exitCode: code, cases: [], reportBytes: Buffer.alloc(0), failureReason: 'invalid-evidence' };
	}
	try {
		const cases = commandCases(casesFromReport({ registration, selected, code, reportBytes, request }));
		return { exitCode: code, cases, reportBytes };
	} catch {
		return { exitCode: code, cases: [], reportBytes, failureReason: 'invalid-evidence' };
	}
}

/** Local command runner for hosts that declare productEvidence. Callers that pass their own spawn keep it. */
export function createLocalEvidenceSpawn(): EvidenceSpawn {
	const localSpawn = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) =>
		spawn(command, args, options)) as EvidenceSpawn;
	localSpawn.runCommand = runCommand;
	return localSpawn;
}
