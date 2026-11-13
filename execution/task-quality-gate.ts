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

const DECLARATION_LINE =
	/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:class|function)\s+[A-Za-z_$][\w$]*/;
const NON_PRODUCTION_TS = /\.(?:spec|test|d)\.ts$/;
const SKIP_CLONE_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

interface CloneSource {
	readonly rel: string;
	readonly lines: readonly string[];
	readonly declarations: readonly number[];
}

interface CloneSpan {
	readonly file: string;
	readonly start: number;
	readonly end: number;
}

function stripCloneLine(line: string): string {
	return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function cloneLines(content: string): string[] {
	const lines = content.split('\n').map(stripCloneLine);
	if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	return lines;
}

function readCloneMinLines(gateConfig: string): number {
	try {
		const parsed: unknown = JSON.parse(
			fs.readFileSync(path.join(path.dirname(gateConfig), 'jscpd.json'), 'utf8'),
		);
		const minLines =
			parsed && typeof parsed === 'object' ? (parsed as { minLines?: unknown }).minLines : undefined;
		if (typeof minLines === 'number' && Number.isInteger(minLines) && minLines > 0) return minLines;
	} catch {
		// A missing or unreadable jscpd minLines config uses 8 and does not throw.
	}
	return 8;
}

function readProductionSources(worktreeDir: string, targetPackage: string): CloneSource[] {
	const sources: CloneSource[] = [];
	const stack = [path.join(worktreeDir, targetPackage)];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (!SKIP_CLONE_DIRS.has(entry.name)) stack.push(full);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith('.ts') || NON_PRODUCTION_TS.test(entry.name)) continue;
			let text = '';
			try {
				text = fs.readFileSync(full, 'utf8');
			} catch {
				continue;
			}
			const lines = cloneLines(text);
			const declarations: number[] = [];
			for (let index = 0; index < lines.length; index += 1) {
				if (DECLARATION_LINE.test(lines[index] ?? '')) declarations.push(index);
			}
			if (declarations.length === 0) continue;
			sources.push({
				rel: path.relative(worktreeDir, full).split(path.sep).join('/'),
				lines,
				declarations,
			});
		}
	}
	sources.sort((left, right) => left.rel.localeCompare(right.rel));
	return sources;
}

function baselineCloneSpans(baseline: QualityBaseline): CloneSpan[] {
	const spans: CloneSpan[] = [];
	for (const finding of baseline.findings ?? []) {
		if (finding?.tool !== 'jscpd' || typeof finding.location !== 'string') continue;
		const match = finding.location.match(/^(.*):(\d+)-(\d+)$/);
		if (!match) continue;
		spans.push({
			file: match[1] ?? '',
			start: Number.parseInt(match[2] ?? '0', 10),
			end: Number.parseInt(match[3] ?? '0', 10),
		});
	}
	return spans;
}

function spanOverlaps(file: string, start: number, end: number, spans: readonly CloneSpan[]): boolean {
	return spans.some((span) => span.file === file && start <= span.end && end >= span.start);
}

function identicalRunLength(
	left: readonly string[],
	leftStart: number,
	right: readonly string[],
	rightStart: number,
): number {
	let length = 0;
	while (
		leftStart + length < left.length &&
		rightStart + length < right.length &&
		left[leftStart + length] === right[rightStart + length]
	) {
		length += 1;
	}
	return length;
}

function containsLineRun(content: string, run: readonly string[]): boolean {
	if (run.length === 0) return false;
	const lines = cloneLines(content);
	for (let index = 0; index + run.length <= lines.length; index += 1) {
		let same = true;
		for (let offset = 0; offset < run.length; offset += 1) {
			if (lines[index + offset] !== run[offset]) {
				same = false;
				break;
			}
		}
		if (same) return true;
	}
	return false;
}

function showAtBase(
	gitCli: GitShowFn,
	worktreeDir: string,
	baseCommitSha: string,
	relFile: string,
): string | null {
	try {
		return String(
			gitCli('git', ['show', `${baseCommitSha}:${relFile}`], {
				cwd: worktreeDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			}) ?? '',
		);
	} catch {
		return null;
	}
}

function cachedShow(
	gitCli: GitShowFn,
	worktreeDir: string,
	baseCommitSha: string,
	cache: Map<string, string | null>,
	relFile: string,
): string | null {
	const cached = cache.get(relFile);
	if (cached !== undefined) return cached;
	const shown = showAtBase(gitCli, worktreeDir, baseCommitSha, relFile);
	cache.set(relFile, shown);
	return shown;
}

function sameRunAtBase(
	gitCli: GitShowFn,
	worktreeDir: string,
	baseCommitSha: string,
	cache: Map<string, string | null>,
	left: CloneSource,
	leftStart: number,
	rightRel: string,
	length: number,
): boolean {
	const run = left.lines.slice(leftStart, leftStart + length);
	const leftBase = cachedShow(gitCli, worktreeDir, baseCommitSha, cache, left.rel);
	const rightBase = cachedShow(gitCli, worktreeDir, baseCommitSha, cache, rightRel);
	return (
		leftBase !== null &&
		rightBase !== null &&
		containsLineRun(leftBase, run) &&
		containsLineRun(rightBase, run)
	);
}

function collectNewCloneFindings(
	worktreeDir: string,
	targetPackage: string,
	authoredPaths: readonly string[],
	baseline: QualityBaseline,
	baseCommitSha: string | null,
	gitCli: GitShowFn | null,
	gateConfig: string,
): string[] {
	const sources = readProductionSources(worktreeDir, targetPackage);
	const authored = new Set(authoredPaths);
	const spans = baselineCloneSpans(baseline);
	const minLines = readCloneMinLines(gateConfig);
	const baseCache = new Map<string, string | null>();
	const findings: string[] = [];
	const seen = new Set<string>();
	for (let leftIndex = 0; leftIndex < sources.length; leftIndex += 1) {
		for (let rightIndex = leftIndex + 1; rightIndex < sources.length; rightIndex += 1) {
			const left = sources[leftIndex];
			const right = sources[rightIndex];
			if (!left || !right || (!authored.has(left.rel) && !authored.has(right.rel))) continue;
			for (const leftStart of left.declarations) {
				for (const rightStart of right.declarations) {
					const length = identicalRunLength(left.lines, leftStart, right.lines, rightStart);
					if (length < minLines) continue;
					const leftLine = leftStart + 1;
					const rightLine = rightStart + 1;
					const leftEnd = leftStart + length;
					const rightEnd = rightStart + length;
					if (
						spanOverlaps(left.rel, leftLine, leftEnd, spans) ||
						spanOverlaps(right.rel, rightLine, rightEnd, spans)
					) {
						continue;
					}
					if (
						baseCommitSha &&
						typeof gitCli === 'function' &&
						sameRunAtBase(
							gitCli,
							worktreeDir,
							baseCommitSha,
							baseCache,
							left,
							leftStart,
							right.rel,
							length,
						)
					) {
						continue;
					}
					const key = `${left.rel}:${leftLine}-${leftEnd}|${right.rel}:${rightLine}-${rightEnd}`;
					if (seen.has(key)) continue;
					seen.add(key);
					findings.push(
						`[jscpd] new clone ${left.rel}:${leftLine}-${leftEnd} — ${right.rel}:${rightLine}-${rightEnd}`,
					);
				}
			}
		}
	}
	return findings;
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
								`[jscpd] clone ${relFile}:${newStart}-${newEnd} — baseline clone at ${relFile}:${startLine}-${endLine} shifted to lines ${newStart}-${newEnd}. Lines ${startLine}-${endLine} must stay byte-for-byte. A deletion above that range needs the same number of replacement lines.`,
							);
							break;
						}
					}
				}
			} catch {}
		}
	}

	findings.push(
		...collectNewCloneFindings(
			worktreeDir,
			targetPackage,
			canonicalPaths,
			baseline,
			baseCommitSha,
			gitCli,
			gateConfig,
		),
	);

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
