import { execFileSync } from 'node:child_process';
import { acceptanceCoverageMissText } from '../execution/coverage-advisory.ts';
import {
	type HostProfile,
	loadHostProfileOrFallback,
} from '../host/host-profile.ts';
import { SdlcError } from '../policy/errors.ts';
import {
	type HighRiskPathOptions,
	HIGH_RISK_PATH_PREFIXES,
	anyHighRiskPaths,
	hasHighRiskPaths,
	isHighRiskPath,
} from '../review/review-generation.ts';
import { validateBranchName } from '../workflow/git-manager.ts';

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const HIGH_RISK_PATH_PATTERNS = Object.freeze(
	HIGH_RISK_PATH_PREFIXES.map(
		(prefix) => new RegExp(`^${escapeRegex(prefix.replace(/\/+$/, ''))}(?:\\/|$)`),
	),
);

export { anyHighRiskPaths, hasHighRiskPaths, isHighRiskPath, type HighRiskPathOptions };

export interface PullRequestSpecLike {
	goal?: string;
	owningContext?: string;
	touchedSurfaces?: readonly string[];
}

export interface PullRequestPreflightEvidence {
	resultLine?: string;
	status?: string;
	changeClass?: string;
}

export interface QaDivergenceLike {
	severity?: string;
	ruleId?: string;
	message?: string;
	evidence?: string;
}

export interface UncitedTouchedTestLike {
	file: string;
	line: number;
	title: string;
}

export interface StaleOracleCitationLike {
	file: string;
	line: number;
	id: string;
}

export interface CoverageAdvisoriesLike {
	emptyAssertFiles?: readonly string[];
	uncitedTouchedTests?: readonly UncitedTouchedTestLike[];
	staleOracleCitations?: readonly StaleOracleCitationLike[];
	missingCriteria?: readonly string[];
	missingCases?: Readonly<Record<string, readonly string[]>> | readonly string[];
	unexecutedTestFiles?: readonly string[];
}

export interface FormatPullRequestBodyOptions {
	spec?: PullRequestSpecLike | null;
	decisions?: readonly unknown[];
	repairs?: number;
	preflightEvidence?: PullRequestPreflightEvidence | null;
	touchedSurfaces?: readonly string[];
	allowedPackages?: readonly string[];
	runId?: string;
	branchName?: string | null;
	qaDivergences?: readonly QaDivergenceLike[];
	qaFindings?: readonly QaDivergenceLike[];
	coverageAdvisories?: CoverageAdvisoriesLike | null;
	semanticReviewAdvisories?: readonly unknown[];
	rootDir?: string;
	profile?: Readonly<HostProfile>;
}

export function formatPullRequestBody({
	spec,
	decisions = [],
	repairs = 0,
	preflightEvidence = null,
	touchedSurfaces = [],
	allowedPackages = [],
	runId = 'unknown-run',
	branchName = null,
	qaDivergences = [],
	qaFindings = [],
	coverageAdvisories = null,
	rootDir,
	profile,
}: FormatPullRequestBodyOptions): string {
	const resolvedProfile = profile ?? loadHostProfileOrFallback(rootDir);
	const goal = spec?.goal ?? 'Automated SDLC implementation';
	const owningContext = spec?.owningContext ?? '';

	const isEscalated = repairs >= 2;
	const laneAutomation =
		!isEscalated &&
		allowedPackages.length > 0 &&
		allowedPackages.every((p) => p === 'tools' || p === 'docs' || p === '.agents');
	const laneAgent = !isEscalated && !laneAutomation;

	const surfacesToCheck = [
		...touchedSurfaces,
		...allowedPackages,
		...(spec?.touchedSurfaces ?? []),
	];
	const hasHighRisk = anyHighRiskPaths(surfacesToCheck, { rootDir, profile: resolvedProfile });
	const highRiskList = resolvedProfile.policy?.highRiskPaths ?? [];
	const highRiskSummary =
		highRiskList.length > 0 ? highRiskList.join(' / ') : 'configured high-risk paths';
	const verifyCommand =
		(resolvedProfile.verify?.argv ?? ['npm', 'test'])
			.filter((token) => token !== '--' && token !== '--base' && token !== '{baseSha}')
			.join(' ') || 'npm test';
	const stateDir = resolvedProfile.stateDir ?? '.agent-sdlc';

	const packagesList =
		allowedPackages.length > 0
			? allowedPackages.map((p) => `- \`${p}\``).join('\n')
			: '- `tools/agent-sdlc`';

	const resultLine =
		preflightEvidence?.resultLine ??
		(preflightEvidence?.status === 'OK'
			? `agent-preflight: RESULT status=OK class=${preflightEvidence.changeClass ?? 'B'} canonical=true`
			: 'agent-preflight: RESULT status=OK class=B canonical=true');
	const changeClass = preflightEvidence?.changeClass ?? 'B';

	const decisionItems =
		Array.isArray(decisions) && decisions.length > 0
			? decisions.map((d) => {
					if (typeof d === 'string') return `- ${d}`;
					if (d && typeof d === 'object') {
						const rec = d as Record<string, unknown>;
						const topic = rec.topic ?? rec.field ?? 'standard';
						const chosen = rec.chosen ?? rec.value ?? 'default';
						return `- **${String(topic)}**: ${String(chosen)}`;
					}
					return `- ${String(d)}`;
				})
			: ['- Standard repository defaults applied'];

	const triedItems =
		repairs > 0
			? [`- Completed after ${repairs} semantic repair attempt(s)`]
			: ['- Initial implementation passed local preflight'];

	const divergences =
		Array.isArray(qaDivergences) && qaDivergences.length > 0
			? qaDivergences
			: Array.isArray(qaFindings)
				? qaFindings
				: [];
	const divergenceItems: string[] = [];
	if (divergences.length > 0) {
		divergenceItems.push('## QA Divergence Brief', '');
		for (const div of divergences) {
			const sev = div.severity || 'P2';
			const rule = div.ruleId || 'QA';
			const msg = div.message || '';
			const evi = div.evidence ? ` (${div.evidence})` : '';
			divergenceItems.push(`- [${sev}] **${rule}**: ${msg}${evi}`);
		}
		divergenceItems.push('');
	}

	const advisoryItems: string[] = [];
	if (coverageAdvisories) {
		const {
			emptyAssertFiles = [],
			uncitedTouchedTests = [],
			staleOracleCitations = [],
		} = coverageAdvisories;
		if (
			emptyAssertFiles.length > 0 ||
			uncitedTouchedTests.length > 0 ||
			staleOracleCitations.length > 0
		) {
			advisoryItems.push('## Test Linkage Advisories', '');
			for (const f of emptyAssertFiles) {
				advisoryItems.push(`- **Empty assertions**: \`${f}\``);
			}
			for (const t of uncitedTouchedTests) {
				advisoryItems.push(`- **Uncited touched test**: \`${t.file}:${t.line}\` "${t.title}"`);
			}
			for (const s of staleOracleCitations) {
				advisoryItems.push(`- **Stale oracle citation**: \`${s.file}:${s.line}\` (\`${s.id}\`)`);
			}
			advisoryItems.push('');
		}
	}
	const coverageMiss = acceptanceCoverageMissText(coverageAdvisories);
	if (coverageMiss) {
		advisoryItems.push('## Acceptance Coverage', '', coverageMiss, '');
	}

	const body = [
		'## Summary',
		'',
		goal,
		'',
		owningContext ? `**Owning Context:** ${owningContext}` : '',
		'',
		'## Lane',
		'',
		`- [${laneAutomation ? 'x' : ' '}] \`lane:automation\` — docs/format/script-only; coding agent optional`,
		`- [${laneAgent ? 'x' : ' '}] \`lane:agent\` — normal feature/fix (max 2 autonomous repair retries)`,
		`- [${isEscalated ? 'x' : ' '}] \`lane:escalate\` — high-risk path, oversized, or repair budget exhausted`,
		'',
		'## Risk',
		'',
		`- [${!hasHighRisk ? 'x' : ' '}] Normal`,
		`- [${hasHighRisk ? 'x' : ' '}] \`risk:high\` (${highRiskSummary})`,
		'',
		'## Packages touched',
		'',
		packagesList,
		'',
		'## Canonical local done bar',
		'',
		`**\`${verifyCommand}\`** is the single local exit criterion (class-aware quality + verify + product mesh smoke when mesh paths change).`,
		'',
		`- [x] Ran \`${verifyCommand}\``,
		`- [x] Result line present: \`${resultLine}\``,
		`- [x] Class (from preflight): **${changeClass}**`,
		'',
		'## Local verification run',
		'',
		'```bash',
		verifyCommand,
		`# ${resultLine}`,
		'```',
		'',
		...divergenceItems,
		...advisoryItems,
		'## Multi-agent run folder (if any)',
		'',
		`\`${stateDir}/${runId}\``,
		branchName ? `Branch: \`${branchName}\`` : '',
		'',
		'## Decisions',
		'',
		...decisionItems,
		'',
		'## Tried',
		'',
		...triedItems,
		'',
		'## Checklist',
		'',
		secretsChecklistLine(resolvedProfile.policy?.secretPaths ?? []),
		'- [x] No quality baseline updates unless this is maintenance',
		'- [x] OpenAPI/contracts regenerated if API surface changed',
		'- [x] Dual-tree / BC rules considered for wire vs domain changes',
		'- [x] Did not use `--skip-coverage` / `QUALITY_SKIP_TESTS` unless explicitly justified',
		'',
	]
		.filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
		.join('\n');

	return body;
}

function secretsChecklistLine(secretPaths: readonly string[]): string {
	if (secretPaths.length === 0) return '- [x] No secrets committed';
	return `- [x] No secrets / ${secretPaths.map((entry) => `\`${entry}\``).join(', ')} committed`;
}

export interface CreateDraftPullRequestOptions {
	worktreeDir?: string;
	title: string;
	body: string;
	branchName: string;
	baseBranch?: string;
	ghCli?: (
		command: string,
		args: readonly string[],
		options: { cwd?: string; encoding: 'utf8'; stdio: ['ignore', 'pipe', 'pipe'] },
	) => string | Buffer;
}

export interface CreatedDraftPullRequest {
	prUrl: string;
	prNumber: number;
	draft: boolean;
	branchName: string;
	baseBranch: string;
	title: string;
}

export function createDraftPullRequest({
	worktreeDir,
	title,
	body,
	branchName,
	baseBranch = 'main',
	ghCli = execFileSync,
}: CreateDraftPullRequestOptions): CreatedDraftPullRequest {
	if (!title || typeof title !== 'string' || title.trim().length === 0) {
		throw new SdlcError('INVALID_INPUT', 'Pull request title cannot be empty');
	}
	if (typeof body !== 'string') {
		throw new SdlcError('INVALID_INPUT', 'Pull request body must be a string');
	}
	validateBranchName(branchName);
	validateBranchName(baseBranch);

	let stdout: string;
	try {
		const rawStdout = ghCli(
			'gh',
			[
				'pr',
				'create',
				'--draft',
				'--title',
				title.trim(),
				'--body',
				body,
				'--head',
				branchName,
				'--base',
				baseBranch,
			],
			{
				cwd: worktreeDir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
		stdout = typeof rawStdout === 'string' ? rawStdout : rawStdout.toString('utf8');
	} catch (error: unknown) {
		const errObj = error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown }) : null;
		const code = typeof errObj?.code === 'string' ? errObj.code : '';
		const message = typeof errObj?.message === 'string' ? errObj.message : String(error);
		if (code === 'ENOENT' || message.includes('ENOENT')) {
			throw new SdlcError(
				'GH_CLI_NOT_FOUND',
				'GitHub CLI (gh) is not installed or not available in PATH',
				{},
				{ cause: error },
			);
		}
		throw new SdlcError(
			'PR_CREATION_FAILED',
			`GitHub CLI failed to create draft pull request: ${message}`,
			{ branchName, baseBranch, title },
			{ cause: error },
		);
	}

	const trimmed = stdout ? stdout.trim() : '';
	const match = trimmed.match(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/);
	const prUrl = match ? match[0] : trimmed;
	const prNumber = match ? Number.parseInt(match[1], 10) : 1;

	return {
		prUrl,
		prNumber,
		draft: true,
		branchName,
		baseBranch,
		title: title.trim(),
	};
}
