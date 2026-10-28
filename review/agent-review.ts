#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sha256, validateRunId } from '../policy/contracts.ts';
import { SdlcError, asSdlcError } from '../policy/errors.ts';
import { canonicalizeAuthorVendor } from './author-vendor.ts';
import {
	CriticReviewAdapter,
	type CriticFinding,
	type CriticGovernorLike,
} from './critic-review.ts';
import { RepositoryModelGovernor } from '../adapters/model-governor.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

export type GitCliFn = (
	command: string,
	args: readonly string[],
	options: { cwd: string; encoding: 'utf8'; stdio: ['ignore', 'pipe', 'pipe'] },
) => string;

export interface TerminalReportInput {
	status: string;
	phase: string;
	runId: string;
	reviewerVendor: string;
	reviewerModel: string;
	operationId: string;
	reportPath: string;
	findingsCount: number;
	findings: readonly CriticFinding[];
}

export function isSecretOrExcludedPath(relPath: unknown): boolean {
	if (typeof relPath !== 'string') return true;
	const normalized = relPath.split(path.sep).join('/').replace(/^\.\//, '');
	if (
		normalized === 'security-config' ||
		normalized.startsWith('security-config/') ||
		normalized.endsWith('.security.config.ts') ||
		normalized === '.env' ||
		normalized.startsWith('.env') ||
		normalized.includes('/.env')
	) {
		return true;
	}
	if (
		normalized.endsWith('.key') ||
		normalized.endsWith('.pem') ||
		normalized.endsWith('.cert') ||
		normalized.endsWith('.crt')
	) {
		return true;
	}
	return /(?:^|\/)(?:dist|build|\.cache|coverage|node_modules)(?:\/|$)/.test(normalized);
}

const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.svgz', '.pdf', '.zip', '.tar', '.gz',
	'.tgz', '.sqlite', '.db', '.wasm', '.bin', '.exe', '.so', '.dylib', '.woff', '.woff2',
	'.ttf', '.eot',
]);

export function isBinaryFile(fullPath: string): boolean {
	if (BINARY_EXTENSIONS.has(path.extname(fullPath).toLowerCase())) return true;
	try {
		const fd = fs.openSync(fullPath, 'r');
		const buffer = Buffer.alloc(4096);
		const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
		fs.closeSync(fd);
		for (let i = 0; i < bytesRead; i++) {
			if (buffer[i] === 0) return true;
		}
	} catch {
		// Ignore unreadable files or directory checks
	}
	return false;
}

export function extractDiffPaths(firstLine: string): { relA: string; relB: string } {
	const line = firstLine.trim();
	if (line.startsWith('"') && line.endsWith('"')) {
		const parts = line.slice(1, -1).split('" "');
		if (parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined) {
			return { relA: parts[0].replace(/^a\//, ''), relB: parts[1].replace(/^b\//, '') };
		}
	}
	const match = line.match(/^a\/(.+?)\s+b\/(.+)$/);
	if (match && match[1] !== undefined && match[2] !== undefined) {
		return { relA: match[1], relB: match[2] };
	}
	return { relA: '', relB: '' };
}

export function filterTrackedDiff(
	diffOutput: unknown,
	rootDir: string = REPOSITORY_ROOT,
): { diff: string; touchedFiles: string[] } {
	if (!diffOutput || typeof diffOutput !== 'string') {
		return { diff: '', touchedFiles: [] };
	}
	const rawSections = diffOutput.split(/^diff --git /m);
	const filteredSections: string[] = [];
	const touchedFiles: string[] = [];

	for (const section of rawSections) {
		if (!section.trim()) continue;
		const fullSection = `diff --git ${section}`;
		const firstLine = section.split('\n', 1)[0] ?? '';
		let { relA, relB } = extractDiffPaths(firstLine);

		if (!relA || !relB) {
			const lineA = section.match(/^---\s+(?:a\/)?(.+)$/m);
			const lineB = section.match(/^\+\+\+\s+(?:b\/)?(.+)$/m);
			if (lineA && lineA[1]) relA = lineA[1].trim();
			if (lineB && lineB[1]) relB = lineB[1].trim();
		}
		if (
			(relA && relA !== '/dev/null' && isSecretOrExcludedPath(relA)) ||
			(relB && relB !== '/dev/null' && isSecretOrExcludedPath(relB))
		) {
			continue;
		}
		if (/^Binary files /m.test(fullSection)) continue;

		const targetRel = relB && relB !== '/dev/null' ? relB : relA;
		if (targetRel && targetRel !== '/dev/null' && rootDir) {
			const targetAbs = path.join(rootDir, targetRel);
			if (fs.existsSync(targetAbs) && isBinaryFile(targetAbs)) continue;
		}
		filteredSections.push(fullSection.trimEnd());
		if (targetRel && targetRel !== '/dev/null') touchedFiles.push(targetRel);
	}
	return { diff: filteredSections.join('\n\n'), touchedFiles };
}

export function resolveContainedPath(
	rootDir: string,
	userPath: unknown,
	{ flagName = '--target' }: { flagName?: string } = {},
): { absPath: string; relPath: string } {
	if (typeof userPath !== 'string' || !userPath.trim()) {
		throw new SdlcError('INVALID_INPUT', `${flagName} is required`);
	}
	const resolvedRoot = path.resolve(rootDir);
	const resolved = path.resolve(rootDir, userPath);
	const isWithin = (base: string, candidate: string): boolean =>
		candidate === base || candidate.startsWith(`${base}${path.sep}`);

	if (!isWithin(resolvedRoot, resolved)) {
		throw new SdlcError('PATH_OUTSIDE_ROOT', `${flagName} path escapes repository root: ${userPath}`);
	}
	const lexicalRel = path.relative(resolvedRoot, resolved);
	if (isSecretOrExcludedPath(lexicalRel)) {
		throw new SdlcError('INVALID_INPUT', `${flagName} path is a protected or secret path: ${userPath}`);
	}
	if (!fs.existsSync(resolved)) {
		throw new SdlcError('INVALID_INPUT', `${flagName} file not found: ${userPath}`);
	}

	let realCandidate: string;
	let realRoot: string;
	try {
		realCandidate = fs.realpathSync(resolved);
		realRoot = fs.realpathSync(rootDir);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new SdlcError('PATH_OUTSIDE_ROOT', `Cannot resolve realpath for ${userPath}: ${message}`, {}, { cause: err });
	}
	if (!isWithin(realRoot, realCandidate)) {
		throw new SdlcError('PATH_OUTSIDE_ROOT', `${flagName} path escapes repository root: ${userPath}`);
	}
	const relPath = path.relative(realRoot, realCandidate);
	if (isSecretOrExcludedPath(relPath)) {
		throw new SdlcError('INVALID_INPUT', `${flagName} path is a protected or secret path: ${userPath}`);
	}
	return { absPath: realCandidate, relPath };
}

export function collectCodeDiff({
	rootDir = REPOSITORY_ROOT,
	scope = '',
	staged = false,
	gitCli = execFileSync,
}: {
	rootDir?: string;
	scope?: string;
	staged?: boolean;
	gitCli?: GitCliFn;
} = {}): { diff: string; touchedFiles: string[] } {
	const gitArgs = staged ? ['diff', '--cached'] : ['diff', 'HEAD'];
	if (scope) gitArgs.push('--', scope);
	let trackedRaw = '';
	try {
		trackedRaw = gitCli('git', gitArgs, {
			cwd: rootDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new SdlcError('CRITIC_REVIEW_FAILED', `Git diff execution failed: ${message}`, {}, { cause: err });
	}

	const { diff: trackedDiff, touchedFiles: trackedFiles } = filterTrackedDiff(trackedRaw, rootDir);

	const lsArgs = ['ls-files', '--others', '--exclude-standard'];
	if (scope) lsArgs.push('--', scope);
	let untrackedLines: string[] = [];
	try {
		const out = gitCli('git', lsArgs, {
			cwd: rootDir,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		untrackedLines = out.split('\n').map((l) => l.trim()).filter(Boolean);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new SdlcError('CRITIC_REVIEW_FAILED', `Git ls-files execution failed: ${message}`, {}, { cause: err });
	}

	const syntheticHunks: string[] = [];
	const untrackedFiles: string[] = [];

	for (const relFile of untrackedLines) {
		if (isSecretOrExcludedPath(relFile)) continue;
		const fullPath = path.join(rootDir, relFile);
		if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) continue;
		if (isBinaryFile(fullPath)) continue;

		try {
			const content = fs.readFileSync(fullPath, 'utf8');
			const lines = content.split('\n');
			const hunk = [
				`diff --git a/${relFile} b/${relFile}`,
				'new file mode 100644',
				'--- /dev/null',
				`+++ b/${relFile}`,
				`@@ -0,0 +1,${lines.length} @@`,
				...lines.map((l) => `+${l}`),
			].join('\n');
			syntheticHunks.push(hunk);
			untrackedFiles.push(relFile);
		} catch {
			// Skip unreadable files
		}
	}

	const fullDiff = [trackedDiff.trim(), ...syntheticHunks].filter(Boolean).join('\n\n');
	const allTouchedFiles = Array.from(new Set([...trackedFiles, ...untrackedFiles]));
	return { diff: fullDiff, touchedFiles: allTouchedFiles };
}

export function formatTerminalReport(result: TerminalReportInput): string {
	const lines: string[] = [];
	const statusBadge = result.status === 'PASS' ? 'PASS' : 'FAIL';
	lines.push(`=== Critic Review Result: ${statusBadge} ===`);
	lines.push(`Phase:            ${result.phase}`);
	lines.push(`Run ID:           ${result.runId}`);
	lines.push(`Reviewer:         ${result.reviewerVendor} (${result.reviewerModel})`);
	lines.push(`Operation ID:     ${result.operationId}`);
	lines.push(`Report:           ${result.reportPath}`);
	lines.push(
		`Total Findings:   ${result.findingsCount} (P1: ${result.findings.filter((f) => f.severity === 'P1').length})`,
	);
	lines.push('');

	if (result.findings.length === 0) {
		lines.push('No findings identified. The target satisfies all phase invariants.');
	} else {
		for (const [idx, f] of result.findings.entries()) {
			const severityTag =
				f.severity === 'P1' ? '[P1 - BLOCKING]' : f.severity === 'P2' ? '[P2 - ADVISORY]' : '[P3 - INFO]';
			lines.push(`--- Finding #${idx + 1}: ${severityTag} (${f.category}) ---`);
			lines.push(`File:        ${f.file}${f.lineRange ? `:${f.lineRange}` : ''}`);
			lines.push(`Evidence:    ${f.evidence ?? ''}`);
			lines.push(`Impact:      ${f.impact ?? ''}`);
			lines.push(`Remedy:      ${f.remediation ?? ''}`);
			lines.push('');
		}
	}
	return lines.join('\n');
}

export async function runReviewCli(
	argv: string[],
	{
		rootDir = REPOSITORY_ROOT,
		governor,
		gitCli,
		reviewBaseDir,
	}: {
		rootDir?: string;
		governor?: CriticGovernorLike;
		gitCli?: GitCliFn;
		reviewBaseDir?: string;
	} = {},
): Promise<number> {
	const cliOptions = {
		phase: { type: 'string' as const },
		'author-vendor': { type: 'string' as const },
		target: { type: 'string' as const },
		'test-output': { type: 'string' as const },
		staged: { type: 'boolean' as const, default: false },
		scope: { type: 'string' as const },
		'reviewer-route': { type: 'string' as const },
		run: { type: 'string' as const },
		json: { type: 'boolean' as const, default: false },
		help: { type: 'boolean' as const, short: 'h', default: false },
	};

	let parsed;
	try {
		parsed = parseArgs({ args: argv, options: cliOptions, allowPositionals: true });
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new SdlcError('INVALID_INPUT', `CLI argument parsing error: ${message}`, {}, { cause: err });
	}

	const { values } = parsed;

	if (values.help) {
		console.log(`Usage: agent-review --phase <spec|plan|code|qa> --author-vendor <vendor> [options]

Required Options:
  --phase <phase>              Review phase: 'spec', 'plan', 'code', or 'qa'
  --author-vendor <vendor>     Author model vendor (e.g. 'google', 'openai', 'anthropic', 'xai', 'deepseek', 'meta')

Target Options:
  --target <file>              Target specification or plan markdown file (required for spec, plan, qa)
  --test-output <file>         Path to test execution log output (required for qa)

Diff Options (for code phase):
  --scope <path>               Restrict diff inspection to a package or directory prefix
  --staged                     Inspect staged changes only instead of full working tree vs HEAD

General Options:
  --reviewer-route <route-id>  Preferred governor route ID
  --run <run-id>               Run identifier (defaults to YYYY-MM-DD-review-<slug>)
  --json                       Emit raw JSON matching CRITIC_FINDINGS_SCHEMA
  --help, -h                   Show this help message
`);
		return 0;
	}

	const phase = values.phase;
	if (!phase || !['spec', 'plan', 'code', 'qa'].includes(phase)) {
		throw new SdlcError(
			'INVALID_INPUT',
			"Missing or invalid --phase (must be 'spec', 'plan', 'code', or 'qa')",
		);
	}

	const rawAuthorVendor = values['author-vendor'];
	if (!rawAuthorVendor) {
		throw new SdlcError('AUTHOR_VENDOR_UNKNOWN', 'Missing required --author-vendor flag');
	}
	const canonicalAuthor = canonicalizeAuthorVendor(rawAuthorVendor);

	const dateStr = new Date().toISOString().slice(0, 10);
	const runId = values.run || `${dateStr}-review-${crypto.randomUUID().slice(0, 8)}`;
	validateRunId(runId);

	let documentText = '';
	let specSummary = '';
	const acceptanceCriteria: string[] = [];
	let testOutputText = '';
	let diff = '';
	let touchedFiles: string[] = [];
	let scope = values.scope || '';

	if (phase === 'spec' || phase === 'plan' || phase === 'qa') {
		const { absPath, relPath } = resolveContainedPath(rootDir, values.target, { flagName: '--target' });
		const fileContent = fs.readFileSync(absPath, 'utf8');
		if (phase === 'spec' || phase === 'plan') {
			documentText = fileContent;
		} else {
			specSummary = fileContent;
		}
		if (!scope) scope = relPath;
	}

	if (phase === 'qa') {
		const { absPath } = resolveContainedPath(rootDir, values['test-output'], { flagName: '--test-output' });
		testOutputText = fs.readFileSync(absPath, 'utf8');
	}

	if (phase === 'code') {
		const collected = collectCodeDiff({ rootDir, scope, staged: Boolean(values.staged), gitCli });
		diff = collected.diff;
		touchedFiles = collected.touchedFiles;
	}

	const modelGovernor: CriticGovernorLike = governor || new RepositoryModelGovernor({ rootDir });
	const adapter = new CriticReviewAdapter({ rootDir, governor: modelGovernor, reviewBaseDir });
	const preferredRouteIds = values['reviewer-route'] ? [values['reviewer-route']] : [];
	const artifactHash = sha256(documentText || diff || specSummary || '');
	const result = await adapter.executeReview({
		runId,
		phase,
		scope,
		authorVendor: canonicalAuthor,
		documentText,
		specSummary,
		acceptanceCriteria,
		diff,
		touchedFiles,
		testOutput: testOutputText,
		preferredRouteIds,
		artifactHash,
		attemptKey: `cli:${runId}:${phase}`,
	});

	if (values.json) {
		console.log(JSON.stringify({ status: result.status, findings: result.findings }, null, 2));
	} else {
		console.log(formatTerminalReport(result));
	}
	return result.hasP1 ? 1 : 0;
}

export async function main(): Promise<void> {
	try {
		const exitCode = await runReviewCli(process.argv.slice(2));
		process.exit(exitCode);
	} catch (error: unknown) {
		const err = asSdlcError(error);
		console.error(`agent-review error: ${err.message}`);
		process.exit(2);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main();
}
