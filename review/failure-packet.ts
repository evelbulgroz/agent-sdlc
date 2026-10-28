// Failure classification and failure-packet building for preflight verification.
// Leaf module: it never imports the verifier.

import fs from 'node:fs';
import path from 'node:path';
import {
	type HostProfile,
	loadHostProfileOrFallback,
} from '../host/host-profile.ts';
import {
	validateFailurePacket,
	validateRunId,
	type FailureClassification,
	type FailurePacketRecord,
} from '../policy/contracts.ts';
import { extractSnippets, sanitize, truncateBody } from '@evelbulgroz/model-usage-govenor/sanitize-failure-text';

// A busy port or similar host condition cannot be fixed by editing source.
const ENVIRONMENT_FAILURE =
	/EADDRINUSE|port \d+ (?:is )?already in use|collection-failed/i;

export function isEnvironmentFailure(output: unknown): boolean {
	return ENVIRONMENT_FAILURE.test(String(output ?? ''));
}

export function classifyFailure(output: unknown): FailureClassification {
	const text = String(output ?? '');
	if (isEnvironmentFailure(text)) return 'infrastructure_failure';
	if (/quality|eslint|biome|prettier|jscpd|semgrep/i.test(text)) {
		return 'quality_failure';
	}
	if (/build|compile|TS\d{3,5}|tsc/i.test(text)) {
		return 'build_failure';
	}
	if (/verify|test|spec|FAIL|AssertionError|not ok/i.test(text)) {
		return 'test_failure';
	}
	if (/ENOENT|EACCES|spawn|command not found|exit code 127/i.test(text)) {
		return 'infrastructure_failure';
	}
	return 'test_failure';
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function packageRoots(
	values: readonly unknown[],
	options: { rootDir?: string; profile?: Readonly<HostProfile> } = {},
): Set<string> {
	const resolvedProfile = options.profile ?? loadHostProfileOrFallback(options.rootDir);
	const configuredRoots = resolvedProfile.workspace?.packageRoots ?? ['packages'];
	const alternation = configuredRoots
		.map((r) => escapeRegex(r.replace(/\/+$/, '')))
		.filter(Boolean)
		.join('|');
	if (!alternation) return new Set<string>();
	const pattern = new RegExp(
		`(?:^|[^A-Za-z0-9_.-])((?:${alternation})\\/[A-Za-z0-9_.-]+)`,
		'g',
	);
	const roots = new Set<string>();
	for (const value of values) {
		for (const match of String(value ?? '').matchAll(pattern)) {
			if (match[1]) roots.add(match[1]);
		}
	}
	return roots;
}

export function failureReferencesAuthorizedPackage({
	output,
	targetPaths = [],
	rootDir,
	profile,
}: {
	output: unknown;
	targetPaths?: readonly string[];
	rootDir?: string;
	profile?: Readonly<HostProfile>;
}): boolean {
	const failureRoots = packageRoots([output], { rootDir, profile });
	if (failureRoots.size === 0) return true;
	const authorizedRoots = packageRoots(targetPaths, { rootDir, profile });
	if (authorizedRoots.size === 0) return true;
	return [...failureRoots].some((root) => authorizedRoots.has(root));
}

export function enrichFailureOutputWithAuthorizedExcerpts({
	output,
	worktreeDir,
	allowedPathPrefixes = [],
	packagePath = null,
	contextLines = 4,
	maxExcerpts = 2,
	maxCharacters = 4000,
}: {
	output: unknown;
	worktreeDir?: string | null;
	allowedPathPrefixes?: readonly string[];
	packagePath?: string | null;
	contextLines?: number;
	maxExcerpts?: number;
	maxCharacters?: number;
}): string {
	const raw = String(output ?? '');
	if (!worktreeDir || !Array.isArray(allowedPathPrefixes)) return raw;
	const root = fs.realpathSync(path.resolve(worktreeDir));
	const normalizedPrefixes = allowedPathPrefixes.map((prefix) =>
		String(prefix).replaceAll('\\', '/').replace(/^\.?\//, '').replace(/\/+$/, ''),
	);
	const isAllowed = (relativePath: string): boolean =>
		normalizedPrefixes.some(
			(prefix) =>
				relativePath === prefix || relativePath.startsWith(`${prefix}/`),
		);
	const references = [
		...raw.matchAll(
			/(?:^|\s)([A-Za-z0-9_./\\-]+\.(?:spec|test)?\.?[cm]?[jt]sx?):(\d+)(?::\d+)?/gm,
		),
	];
	const excerpts: string[] = [];
	const seen = new Set<string>();
	for (const reference of references) {
		if (excerpts.length >= maxExcerpts) break;
		const rawPath = reference[1];
		const rawLine = reference[2];
		if (!rawPath || !rawLine) continue;
		const reportedPath = rawPath.replaceAll('\\', '/');
		const lineNumber = Number.parseInt(rawLine, 10);
		if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) continue;
		const candidates = path.isAbsolute(reportedPath)
			? [reportedPath]
			: [
					path.resolve(root, reportedPath),
					...(packagePath
						? [path.resolve(root, packagePath, reportedPath)]
						: []),
				];
		const resolved = candidates
			.map((candidate) => {
				try {
					return fs.realpathSync(path.resolve(candidate));
				} catch {
					return null;
				}
			})
			.find((absolute): absolute is string => {
				if (!absolute) return false;
				if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
					return false;
				}
				if (!fs.statSync(absolute).isFile()) return false;
				const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
				return isAllowed(relative);
			});
		if (!resolved) continue;
		const relative = path.relative(root, resolved).replaceAll(path.sep, '/');
		const key = `${relative}:${lineNumber}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const lines = fs.readFileSync(resolved, 'utf8').split('\n');
		const start = Math.max(1, lineNumber - contextLines);
		const end = Math.min(lines.length, lineNumber + contextLines);
		const body = lines
			.slice(start - 1, end)
			.map((line, index) => `${start + index}: ${line}`)
			.join('\n');
		excerpts.push(`--- ${relative}:${lineNumber} ---\n${body}`);
	}
	if (excerpts.length === 0) return raw;
	return `${raw}\n\nAuthorized failure context:\n${excerpts.join('\n')}`.slice(
		0,
		raw.length + maxCharacters,
	);
}

export function buildFailurePacket({
	runId,
	generation = 0,
	failedCommand,
	exitCode,
	output,
	targetPaths = [],
	baseCommitSha,
	rootDir,
	profile,
}: {
	runId: string;
	generation?: number;
	failedCommand: string;
	exitCode?: number | null;
	output: unknown;
	targetPaths?: readonly string[];
	baseCommitSha: string;
	rootDir?: string;
	profile?: Readonly<HostProfile>;
}): Readonly<FailurePacketRecord> {
	validateRunId(runId);
	const sanitized = sanitize(output);
	const snippets = extractSnippets(sanitized);
	const sanitizedSnippetText =
		snippets.length > 0
			? snippets.join('\n')
			: truncateBody(sanitized, 4000);

	const classification = classifyFailure(sanitized);
	const callerPaths = Array.isArray(targetPaths) ? targetPaths : [];
	const resolvedProfile = profile ?? loadHostProfileOrFallback(rootDir);
	const fallbackTargetPaths = resolvedProfile.policy?.defaultFailureTargetPaths ?? ['packages/**'];

	return validateFailurePacket({
		schemaVersion: '1.0.0',
		runId,
		generation,
		failedCommand,
		exitCode: typeof exitCode === 'number' && Number.isInteger(exitCode) ? exitCode : 1,
		sanitizedOutput: sanitizedSnippetText,
		classification,
		targetPaths: callerPaths.length > 0 ? callerPaths : [...fallbackTargetPaths],
		baseCommitSha,
		timestamp: new Date().toISOString(),
	});
}
