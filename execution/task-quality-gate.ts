import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
	type HostProfile,
	loadHostProfileOrFallback,
} from '../host/host-profile.ts';
import type { GitShowFn } from './ac-worktree-coverage.ts';
import { safeCanonicalPath } from './tool-path-guards.ts';

export interface EvaluateTaskQualityGateOptions {
	readonly worktreeDir?: string;
	readonly targetPackage?: string;
	readonly authoredPaths?: readonly string[];
	readonly baseCommitSha?: string | null;
	readonly gitCli?: GitShowFn | null;
	readonly profile?: Readonly<HostProfile>;
}

export interface TaskQualityGateResult {
	readonly pass: boolean;
	readonly auditRequired?: true;
	readonly summary?: string;
	readonly findings: string[];
}

interface QualityBaselineFinding {
	readonly tool?: unknown;
	readonly location?: unknown;
}

interface QualityBaseline {
	readonly fingerprints?: readonly string[];
	readonly findings?: readonly QualityBaselineFinding[];
}

interface QualityExceptionsFile {
	readonly exceptions?: ReadonlyArray<{ readonly fingerprint?: unknown }>;
	readonly entries?: ReadonlyArray<{ readonly fingerprint?: unknown }>;
}

interface EslintMessage {
	readonly ruleId?: unknown;
	readonly line?: unknown;
	readonly endLine?: unknown;
	readonly message?: unknown;
}

interface EslintFileResult {
	readonly filePath?: unknown;
	readonly messages?: readonly EslintMessage[];
}

export function resolveTaskQualityGatePaths(
	worktreeDir: string,
	profile?: Readonly<HostProfile>,
): {
	readonly gateConfig: string | null;
	readonly baselinePath: string | null;
	readonly exceptionsPath: string | null;
} {
	const resolvedProfile = profile ?? loadHostProfileOrFallback(worktreeDir);
	const qg = resolvedProfile.qualityGate;
	if (!qg?.eslintConfigPath || !qg?.baselinePath) {
		return { gateConfig: null, baselinePath: null, exceptionsPath: null };
	}
	return {
		gateConfig: path.join(worktreeDir, qg.eslintConfigPath),
		baselinePath: path.join(worktreeDir, qg.baselinePath),
		exceptionsPath: qg.exceptionsPath ? path.join(worktreeDir, qg.exceptionsPath) : null,
	};
}

export function hasTaskQualityGateConfig(
	worktreeDir: string | null | undefined,
	profile?: Readonly<HostProfile>,
): boolean {
	if (!worktreeDir) return false;
	const { gateConfig, baselinePath } = resolveTaskQualityGatePaths(worktreeDir, profile);
	return Boolean(
		gateConfig && baselinePath && fs.existsSync(gateConfig) && fs.existsSync(baselinePath),
	);
}

export function evaluateTaskQualityGate({
	worktreeDir,
	targetPackage,
	authoredPaths = [],
	baseCommitSha = null,
	gitCli = null,
	profile,
}: EvaluateTaskQualityGateOptions = {}): TaskQualityGateResult {
	if (!worktreeDir || !targetPackage || !Array.isArray(authoredPaths) || authoredPaths.length === 0) {
		return { pass: true, findings: [] };
	}
	const { gateConfig, baselinePath, exceptionsPath } = resolveTaskQualityGatePaths(
		worktreeDir,
		profile,
	);
	if (!gateConfig || !baselinePath || !fs.existsSync(gateConfig) || !fs.existsSync(baselinePath)) {
		return { pass: true, findings: [] };
	}
	let baseline: QualityBaseline = {};
	try {
		baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as QualityBaseline;
	} catch {
		return { pass: true, findings: [] };
	}
	const allowedFingerprints = new Set<string>(baseline.fingerprints ?? []);
	if (exceptionsPath && fs.existsSync(exceptionsPath)) {
		try {
			const exceptions = JSON.parse(
				fs.readFileSync(exceptionsPath, 'utf8'),
			) as QualityExceptionsFile;
			for (const entry of exceptions.exceptions ?? exceptions.entries ?? []) {
				if (typeof entry?.fingerprint === 'string') {
					allowedFingerprints.add(entry.fingerprint);
				}
			}
		} catch {}
	}
	const canonicalPaths = authoredPaths
		.map((p) => safeCanonicalPath(p))
		.filter((p): p is string => Boolean(p));
	const findings: string[] = [];

	if (baseCommitSha && typeof gitCli === 'function') {
		for (const bFinding of baseline.findings ?? []) {
			if (bFinding?.tool !== 'jscpd' || typeof bFinding.location !== 'string') continue;
			const match = bFinding.location.match(/^(.*):(\d+)-(\d+)$/);
			if (!match) continue;
			const relFile = match[1] ?? '';
			const startStr = match[2] ?? '0';
			const endStr = match[3] ?? '0';
			if (!canonicalPaths.includes(relFile)) continue;
			const absFile = path.join(worktreeDir, relFile);
			if (!fs.existsSync(absFile)) continue;
			const startLine = Number.parseInt(startStr, 10);
			const endLine = Number.parseInt(endStr, 10);
			try {
				const origContent = gitCli('git', ['show', `${baseCommitSha}:${relFile}`], {
					cwd: worktreeDir,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
				});
				const origLines = String(origContent ?? '').split('\n');
				const origSlice = origLines.slice(startLine - 1, endLine).join('\n');
				const currLines = fs.readFileSync(absFile, 'utf8').split('\n');
				const currSliceAtOrig = currLines.slice(startLine - 1, endLine).join('\n');
				if (origSlice.length > 0 && currSliceAtOrig !== origSlice) {
					const span = endLine - startLine;
					for (let idx = 0; idx + span < currLines.length; idx += 1) {
						if (currLines.slice(idx, idx + span + 1).join('\n') === origSlice) {
							const newStart = idx + 1;
							const newEnd = newStart + span;
							findings.push(
								`[jscpd] clone ${relFile}:${newStart}-${newEnd} — baseline clone at ${relFile}:${startLine}-${endLine} shifted to lines ${newStart}-${newEnd}. Keep lines ${startLine}-${endLine} at their original line numbers (place new imports after line ${endLine}).`,
							);
							break;
						}
					}
				}
			} catch {}
		}
	}

	const pkgDir = path.join(worktreeDir, targetPackage);
	const eslintCandidates = [
		path.join(pkgDir, 'node_modules/.bin/eslint'),
		path.join(worktreeDir, 'node_modules/.bin/eslint'),
	];
	const eslintBin = eslintCandidates.find((candidate) => fs.existsSync(candidate));
	const tsFilesRelToPkg = canonicalPaths
		.filter(
			(relPath) =>
				relPath.startsWith(`${targetPackage}/src/`) &&
				relPath.endsWith('.ts') &&
				!/\.(?:spec|test|d)\.ts$/.test(relPath) &&
				fs.existsSync(path.join(worktreeDir, relPath)),
		)
		.map((relPath) => relPath.slice(targetPackage.length + 1));

	if (eslintBin && tsFilesRelToPkg.length > 0 && fs.existsSync(pkgDir)) {
		const res = spawnSync(
			eslintBin,
			['-c', gateConfig, '--no-eslintrc', '--format', 'json', ...tsFilesRelToPkg],
			{ cwd: pkgDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
		);
		if (res.stdout) {
			try {
				const parsed: unknown = JSON.parse(res.stdout);
				for (const fileResult of (Array.isArray(parsed) ? parsed : []) as readonly EslintFileResult[]) {
					const relFile = path
						.relative(worktreeDir, typeof fileResult.filePath === 'string' ? fileResult.filePath : '')
						.split(path.sep)
						.join('/');
					for (const msg of fileResult.messages ?? []) {
						if (!msg?.ruleId || !String(msg.ruleId).startsWith('sonarjs/')) continue;
						const loc = `${relFile}:${String(msg.line)}${msg.endLine != null ? `-${String(msg.endLine)}` : ''}`;
						const normMsg = String(msg.message || '')
							.replace(/\\/g, '/')
							.replace(/\s+/g, ' ')
							.trim()
							.toLowerCase();
						const payload = ['eslint', String(msg.ruleId), String(targetPackage), loc, normMsg].join(
							'\u0001',
						);
						const fp = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
						if (!allowedFingerprints.has(fp)) {
							findings.push(`[eslint] ${String(msg.ruleId)} ${loc} — ${String(msg.message)} (${fp})`);
						}
					}
				}
			} catch {}
		}
	}

	if (findings.length > 0) {
		return {
			pass: false,
			auditRequired: true,
			summary: [
				'quality-gate failed',
				...findings,
				'[note] quality-gate only re-evaluates when you emit {"kind":"complete","summary":"..."}. Once your edits and test runs pass, declare complete to re-run quality-gate.',
			].join('\n'),
			findings,
		};
	}
	return { pass: true, findings: [] };
}

export const runTaskQualityGate = evaluateTaskQualityGate;
