import type { EvidenceSpawn } from './evidence-types.ts';
import path from 'node:path';
import { awaitEvidenceGroupStopped, terminateEvidenceGroup } from './evidence-process-cleanup.ts';

export interface EvidenceProcessResult {
	stdout: Buffer;
	exitCode: number | null;
	signal: string | null;
	failureReason: string | null;
}

export function spawnEvidence(
	spawn: EvidenceSpawn,
	argv: readonly string[],
	cwd: string,
	stdin: Buffer,
	limits: { timeoutMs: number; maxReportBytes: number },
	environment: Readonly<Record<string, string>>,
	maxDiagnosticBytes: number,
	onDiagnostics?: (message: string) => void,
): Promise<EvidenceProcessResult> {
	return new Promise((resolve) => {
		let child: ReturnType<EvidenceSpawn>;
		try {
			const command = argv[0];
			if (!command || !path.isAbsolute(command) || command.includes('\0')) throw new Error('invalid-command');
			child = spawn(command, argv.slice(1), {
				cwd,
				shell: false,
				detached: process.platform === 'linux',
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...environment },
			});
		} catch {
			resolve({ stdout: Buffer.alloc(0), exitCode: null, signal: null, failureReason: 'spawn-failed' });
			return;
		}
		const chunks: Buffer[] = [];
		const diagnostics: Buffer[] = [];
		let bytes = 0;
		let diagnosticBytes = 0;
		let failureReason: string | null = null;
		let settled = false;
		let finishing = false;
		const terminate = () => terminateEvidenceGroup(child);
		const stop = (reason: string) => {
			if (settled || finishing) return;
			failureReason ??= reason;
			terminate();
			void finish(null, 'SIGKILL');
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
		};
		const timer = setTimeout(() => stop('timeout'), limits.timeoutMs);
		const finish = async (exitCode: number | null, signal: string | null) => {
			if (settled || finishing) return;
			finishing = true;
			clearTimeout(timer);
			terminate();
			if (!await awaitEvidenceGroupStopped(child)) failureReason ??= 'process-cleanup-failed';
			settled = true;
			if (onDiagnostics && diagnostics.length) {
				// Diagnostic content is not persisted or treated as evidence.
				const sanitized = Buffer.concat(diagnostics).toString('utf8')
					.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
					.replace(/[^\x20-\x7e\n\t]/g, '?')
					.replace(/(?:[A-Za-z_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Za-z_]*\s*[=:]\s*)\S+/gi, '[REDACTED]')
					.replace(/\b(?:Authorization\s*:\s*|Bearer\s+)\S+(?:\s+\S+)?/gi, '[REDACTED]')
					.replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://[REDACTED]@')
					.replace(/\b(?:sk-[A-Za-z0-9_-]+|AKIA[A-Z0-9]+)\b/g, '[REDACTED]')
					.replace(/-----BEGIN[\s\S]*$/g, '[REDACTED]')
					.slice(0, maxDiagnosticBytes);
				try { onDiagnostics(sanitized); } catch { /* Diagnostics never affect durable completion. */ }
			}
			resolve({ stdout: Buffer.concat(chunks), exitCode, signal, failureReason });
		};
		child.stdout.on('data', (value: Buffer | string) => {
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
			bytes += chunk.length;
			if (bytes > limits.maxReportBytes) stop('report-byte-limit');
			else chunks.push(chunk);
		});
		child.stderr.on('data', (value: Buffer | string) => {
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
			const remaining = maxDiagnosticBytes - diagnosticBytes;
			if (remaining > 0) diagnostics.push(chunk.subarray(0, remaining));
			diagnosticBytes += Math.min(chunk.length, Math.max(0, remaining));
		});
		child.once('error', () => {
			stop('process-error');
		});
		child.once('exit', terminate);
		child.once('close', (code: number | null, signal: string | null) => { void finish(code, signal); });
		child.stdin.on('error', (error: NodeJS.ErrnoException) => {
			const exited =
				(child.exitCode !== null && child.exitCode !== undefined) ||
				(child.signalCode !== null && child.signalCode !== undefined);
			if (error.code === 'EPIPE' || exited) return;
			stop('stdin-error');
		});
		try {
			child.stdin.end(stdin);
		} catch {
			const exited =
				(child.exitCode !== null && child.exitCode !== undefined) ||
				(child.signalCode !== null && child.signalCode !== undefined);
			if (!child.stdin.destroyed && !exited) {
				stop('stdin-error');
			}
		}
	});
}
