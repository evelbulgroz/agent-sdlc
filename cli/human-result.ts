import {
	type CoverageAdvisorySource,
	acceptanceCoverageMissText,
} from '../execution/coverage-advisory.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { readFleetFrictionSummary } from '../workflow/fleet.ts';
import { usage } from './arguments.ts';

export interface HumanResultInput extends Record<string, unknown> {
	ready?: boolean;
	missingFields?: readonly string[];
	owningContext?: string | null;
	briefHash?: string;
	acceptanceCriteria?: readonly string[];
	completeness?: {
		complete?: boolean;
		missingFields?: readonly string[];
		ambiguousFields?: readonly string[];
	} | null;
	status?: string;
	passed?: number;
	total?: number;
	providerOperations?: number;
	evidence?: { runs?: number; tasks?: number };
	preferredRoute?: string | null;
	violations?: ReadonlyArray<{ dimension: string; actual: unknown; maximum: unknown }>;
	runId?: string;
	inconclusiveCause?: string | null;
	acceptanceCriteriaQuality?: {
		complete?: boolean;
		errors?: ReadonlyArray<{ message?: string } | null | undefined>;
	} | null;
	taskReadiness?: {
		tasks: ReadonlyArray<{
			taskId: string;
			sliceId?: string | null;
			complexityScore?: number | null;
			highRisk?: boolean;
		}>;
	} | null;
	fixture?: { roleId?: string } | null;
	sourceStatus?: string;
	roleId?: string;
	providerCalls?: number;
	editsApplied?: number;
	state?: string | null;
	message?: string;
	learning?: { key?: string; scope?: string };
	runs?: ReadonlyArray<{ runId: string; state: string }>;
	destination?: string;
	pullRequest?: {
		url: string;
		number: number;
		branchName?: string;
		baseBranch?: string;
		draft?: boolean;
	} | null;
	pushed?: boolean;
	runtimeRevision?: number;
	verificationEvidenceHash?: string | null;
	worktreePath?: string | null;
	baseCommitSha?: string | null;
	targetTreeSha?: string | null;
	patchSummary?: string | null;
	branch?: string | null;
	commitSha?: string | null;
	optionalRoles?: ReadonlyArray<{
		roleId: string;
		insertionPoint: string;
		status: string;
	}>;
	semanticRepairsCount?: number;
	tasks?: ReadonlyArray<{
		id: string;
		status: string;
		package?: string;
		title: string;
		sliceId?: string | null;
		complexityScore?: number | null;
	}>;
	taskProgress?: {
		nextReadyTask?: string | null;
		featureNonExposed?: boolean;
		completedCheckpoints: ReadonlyArray<{ taskId: string }>;
	} | null;
	pendingInterrupt?: {
		interruptId: string;
		kind: string;
		request: {
			questions?: ReadonlyArray<{ questionId: string; prompt: string }>;
			approval?: { approvalHash?: string };
			baseCommitSha?: string;
			failingTaskId?: string;
			conflictDetails?: string;
		} & Record<string, unknown>;
	} | null;
	hostInvocation?: { argv?: readonly string[] } | null;
	blockedReason?: string | null;
	continuation?: { action?: string; reason?: string } | null;
	criticFailures?: ReadonlyArray<{ phase: string; message: string; code: string }>;
	qaDivergences?: ReadonlyArray<{
		severity?: string;
		ruleId?: string;
		message?: string;
		evidence?: string;
	}>;
	coverageAdvisories?:
		| (CoverageAdvisorySource & {
				emptyAssertFiles?: readonly string[];
				uncitedTouchedTests?: ReadonlyArray<{ file: string; line: number; title: string }>;
				staleOracleCitations?: ReadonlyArray<{ file: string; line: number; id: string }>;
		  })
		| null;
	frictionAdvisory?: string | null;
}

function formatQaDivergencesAndAdvisories(result: HumanResultInput): string[] {
	const lines: string[] = [];
	if (Array.isArray(result.criticFailures) && result.criticFailures.length > 0) {
		lines.push('');
		lines.push('Critic Alerts:');
		for (const failure of result.criticFailures) {
			lines.push(`  - ${failure.phase}: ${failure.message} (${failure.code})`);
		}
	}
	if (Array.isArray(result.qaDivergences) && result.qaDivergences.length > 0) {
		lines.push('');
		lines.push('QA Divergence Brief:');
		for (const div of result.qaDivergences) {
			const sev = div.severity || 'P2';
			const rule = div.ruleId || 'QA';
			const msg = div.message || '';
			const evi = div.evidence ? ` - ${div.evidence}` : '';
			lines.push(`  - [${sev}] ${rule}: ${msg}${evi}`);
		}
	}
	if (result.coverageAdvisories) {
		const {
			emptyAssertFiles = [],
			uncitedTouchedTests = [],
			staleOracleCitations = [],
		} = result.coverageAdvisories;
		if (
			emptyAssertFiles.length > 0 ||
			uncitedTouchedTests.length > 0 ||
			staleOracleCitations.length > 0
		) {
			lines.push('');
			lines.push('Advisories:');
			for (const f of emptyAssertFiles) {
				lines.push(`  - Empty assertions: ${f}`);
			}
			for (const t of uncitedTouchedTests) {
				lines.push(`  - Uncited touched test: ${t.file}:${t.line} "${t.title}"`);
			}
			for (const s of staleOracleCitations) {
				lines.push(`  - Stale oracle citation: ${s.file}:${s.line} (${s.id})`);
			}
		}
	}
	const coverageMiss = acceptanceCoverageMissText(result.coverageAdvisories);
	if (coverageMiss) {
		lines.push('');
		lines.push(coverageMiss);
	}
	return lines;
}

function appendLearningOutcomeLines(
	lines: string[],
	command: string,
	result: HumanResultInput,
	rootDir: string,
): void {
	if (result.frictionAdvisory) {
		lines.push('');
		lines.push(result.frictionAdvisory);
	}
	if (['start', 'resume', 'authorize'].includes(command) && rootDir) {
		try {
			const summary = readFleetFrictionSummary({ rootDir });
			if (summary.recommendedKeys.length > 0) {
				const count = summary.recommendedKeys.length;
				const issueWord = count === 1 ? 'recurring issue' : 'recurring issues';
				const topKey = summary.recommendedKeys[0];
				lines.push('');
				lines.push(
					`⚡ SDLC Skill Learning Alert: ${count} ${issueWord} observed across ≥3 runs has reached the recommended threshold. Run 'agent-sdlc-trends --skills' to inspect, or 'agent-sdlc skills --apply --key "${topKey}"' to update prompts.`,
				);
			}
		} catch {
			// Non-fatal if fleet scan fails
		}
	}
}

export function humanResult(
	command: string,
	resultInput: Record<string, unknown>,
	rootDir = REPOSITORY_ROOT,
): string {
	const result = resultInput as HumanResultInput;
	if (command === 'host check') {
		return JSON.stringify({
			profileId: resultInput.profileId,
			adapter: resultInput.adapter,
		});
	}
	if (command === 'shell start' && typeof result.ready === 'boolean') {
		if (!result.ready) {
			return `shell start: not ready, missing=[${(result.missingFields ?? []).join(', ')}]`;
		}
		return [
			`shell start: brief ready (owningContext=${result.owningContext ?? 'unknown'})`,
			`briefHash: ${result.briefHash}`,
			'acceptanceCriteria:',
			...(result.acceptanceCriteria ?? []).map((criterion) => `- ${criterion}`),
			'Resubmit shell start with --response-file {"confirm":true,"briefHash":"<briefHash>"} to start the run.',
		].join('\n');
	}
	if (command === 'check-spec') {
		const lines = [`check-spec: ready=${result.ready}`];
		if (result.completeness) {
			lines.push(
				`completeness: complete=${result.completeness.complete} missing=[${(result.completeness.missingFields ?? []).join(', ')}] ambiguous=[${(result.completeness.ambiguousFields ?? []).join(', ')}]`,
			);
		}
		if (result.acceptanceCriteriaQuality) {
			const errors = result.acceptanceCriteriaQuality.errors ?? [];
			lines.push(
				`acceptanceCriteriaQuality: complete=${result.acceptanceCriteriaQuality.complete} errors=${errors.length}`,
			);
			for (const error of errors) {
				if (error?.message) lines.push(`  - ${error.message}`);
			}
		}
		if (result.taskReadiness) {
			for (const task of result.taskReadiness.tasks) {
				lines.push(
					`task ${task.taskId}: slice=${task.sliceId} score=${task.complexityScore} highRisk=${task.highRisk}`,
				);
			}
		}
		return lines.join('\n');
	}
	if (command === 'reliability replay') {
		return `reliability replay: ${result.status} (${result.passed}/${result.total}, providerOperations=${result.providerOperations})`;
	}
	if (command === 'reliability report') {
		return `reliability report: ${result.status} (${result.evidence?.runs} runs, ${result.evidence?.tasks} tasks)`;
	}
	if (command === 'reliability routes') {
		return `reliability routes: ${result.status}${result.preferredRoute ? ` preferred=${result.preferredRoute}` : ''}`;
	}
	if (command === 'canary check') {
		const lines = [`canary check: ${result.status}`];
		for (const violation of result.violations ?? []) {
			lines.push(
				`  - ${violation.dimension}: actual=${violation.actual} maximum=${violation.maximum}`,
			);
		}
		return lines.join('\n');
	}
	if (command === 'canary qualify') {
		return `canary qualify: ${result.status} run=${result.runId}${result.inconclusiveCause ? ` cause=${result.inconclusiveCause}` : ''}`;
	}
	if (command === 'canary step') {
		if (result.fixture) {
			return `canary step: exported role=${result.fixture.roleId} source=${result.sourceStatus}`;
		}
		return `canary step: role=${result.roleId} providerCalls=${result.providerCalls} editsApplied=${result.editsApplied}`;
	}
	if (command === 'help' || result.state === 'HELP') {
		return result.message || usage();
	}
	if (command === 'prune-runs') {
		return result.message ?? '';
	}
	if (command === 'post-mortem') {
		return `Post-mortem learning staged: ${result.learning?.key} (${result.learning?.scope})`;
	}
	if (command === 'skills') {
		return result.message || '';
	}
	if (command === 'list') {
		const runs = result.runs ?? [];
		return runs.length === 0
			? 'No local orchestrated runs.'
			: runs.map((run) => `${run.runId} ${run.state}`).join('\n');
	}
	if (command === 'export') return `Exported ${result.runId} to ${result.destination}`;
	if (command === 'pr') {
		if (result.pullRequest) {
			return `Draft pull request opened: ${result.pullRequest.url} (#${result.pullRequest.number})\nBranch: ${result.pullRequest.branchName} -> ${result.pullRequest.baseBranch}`;
		}
		if (result.pushed) {
			return `Branch pushed to origin. PR body prepared at tools/.agent-sdlc/${result.runId}/artifacts/pr-body.md`;
		}
		return `PR body prepared at tools/.agent-sdlc/${result.runId}/artifacts/pr-body.md`;
	}
	if (result.state === 'READY_FOR_GIT_APPROVAL') {
		const lines = [
			`Run ID:        ${result.runId}`,
			`State:         ${result.state} (Revision ${result.runtimeRevision})`,
			`Outcome:       Preflight PASSED (status=OK, canonical=true)`,
		];
		if (result.verificationEvidenceHash) {
			lines.push(`Evidence:      ${result.verificationEvidenceHash}`);
		}
		if (result.worktreePath) lines.push(`Worktree:      ${result.worktreePath}`);
		if (result.baseCommitSha) lines.push(`Base SHA:      ${result.baseCommitSha}`);
		if (result.targetTreeSha) lines.push(`Tree SHA:      ${result.targetTreeSha}`);
		lines.push(...formatQaDivergencesAndAdvisories(result));
		if (result.patchSummary) {
			lines.push('');
			lines.push('Changes:');
			lines.push(result.patchSummary);
		}
		lines.push('');
		lines.push('Action Required: Local Git operations are not authorized.');
		lines.push('To review and commit these changes:');
		if (result.worktreePath) lines.push(`  cd ${result.worktreePath}`);
		lines.push('  git diff origin/main');
		lines.push('  git checkout -b <branch-name>');
		lines.push('  git commit -m "<commit-message>"');
		appendLearningOutcomeLines(lines, command, result, rootDir);
		return lines.join('\n');
	}
	if (result.state === 'DONE') {
		const lines = [
			`Run ID:        ${result.runId}`,
			`State:         ${result.state} (Revision ${result.runtimeRevision})`,
			`Outcome:       Preflight PASSED on committed tree (status=OK, canonical=true)`,
		];
		if (result.branch) lines.push(`Branch:        ${result.branch}`);
		if (result.commitSha) lines.push(`Commit:        ${result.commitSha}`);
		if (result.pullRequest) {
			lines.push(`Pull Request:  ${result.pullRequest.url} (#${result.pullRequest.number}) [draft]`);
		}
		if (result.worktreePath) lines.push(`Worktree:      ${result.worktreePath}`);
		if (result.baseCommitSha) lines.push(`Base SHA:      ${result.baseCommitSha}`);
		if (result.targetTreeSha) lines.push(`Tree SHA:      ${result.targetTreeSha}`);
		if (result.verificationEvidenceHash) {
			lines.push(`Evidence:      ${result.verificationEvidenceHash}`);
		}
		lines.push(...formatQaDivergencesAndAdvisories(result));
		if (Array.isArray(result.optionalRoles) && result.optionalRoles.length > 0) {
			lines.push('');
			lines.push('Optional Roles:');
			for (const role of result.optionalRoles) {
				lines.push(`  - ${role.roleId} (${role.insertionPoint}): ${role.status}`);
			}
		}
		appendLearningOutcomeLines(lines, command, result, rootDir);
		return lines.join('\n');
	}
	const lines = [`${result.runId}: ${result.state}`];
	if (result.worktreePath) lines.push(`worktree: ${result.worktreePath}`);
	if (result.baseCommitSha) lines.push(`baseSha: ${result.baseCommitSha}`);
	if (result.targetTreeSha) lines.push(`treeSha: ${result.targetTreeSha}`);
	if (result.semanticRepairsCount !== undefined && result.semanticRepairsCount > 0) {
		lines.push(`repairs: ${result.semanticRepairsCount} / 2`);
	}
	if (Array.isArray(result.tasks) && result.tasks.length > 0) {
		lines.push('');
		lines.push('Tasks:');
		for (const task of result.tasks) {
			const icon =
				task.status === 'completed'
					? '✔'
					: task.status === 'in_progress'
						? '▶'
						: task.status === 'blocked'
							? '✖'
							: '○';
			const slice = task.sliceId ? ` slice=${task.sliceId}` : '';
			const score = Number.isInteger(task.complexityScore)
				? ` score=${task.complexityScore}`
				: '';
			lines.push(
				`  ${icon} [${task.id}] ${task.package || ''}: ${task.status} - ${task.title}${slice}${score}`,
			);
		}
	}
	if (result.taskProgress) {
		lines.push(`nextReadyTask: ${result.taskProgress.nextReadyTask ?? 'none'}`);
		lines.push(`featureNonExposed: ${result.taskProgress.featureNonExposed}`);
		if (result.taskProgress.completedCheckpoints.length > 0) {
			lines.push(
				`completedCheckpoints: ${result.taskProgress.completedCheckpoints
					.map((checkpoint) => checkpoint.taskId)
					.join(', ')}`,
			);
		}
	}
	if (result.pendingInterrupt) {
		lines.push(
			`interrupt: ${result.pendingInterrupt.interruptId} (${result.pendingInterrupt.kind})`,
		);
		const questions = result.pendingInterrupt.request.questions ?? [];
		for (const question of questions) lines.push(`- ${question.questionId}: ${question.prompt}`);
		if (result.pendingInterrupt.kind === 'approval') {
			lines.push(`approvalHash: ${result.pendingInterrupt.request.approval?.approvalHash}`);
		}
		if (result.pendingInterrupt.kind === 'authorization') {
			lines.push(`baseCommitSha: ${result.pendingInterrupt.request.baseCommitSha}`);
		}
		if (result.pendingInterrupt.kind === 'reconciliation_conflict') {
			lines.push('');
			lines.push('Reconciliation Conflict Detected!');
			lines.push(`Failing Task: ${result.pendingInterrupt.request.failingTaskId}`);
			if (result.pendingInterrupt.request.conflictDetails) {
				lines.push(`Details: ${result.pendingInterrupt.request.conflictDetails}`);
			}
		}
	}
	if (Array.isArray(result.hostInvocation?.argv) && result.hostInvocation.argv.length > 0) {
		lines.push('');
		lines.push(result.hostInvocation.argv.join(' '));
	}
	if (result.blockedReason) lines.push(`blocked: ${result.blockedReason}`);
	if (result.continuation?.action) {
		lines.push(`continuation: ${result.continuation.action} (${result.continuation.reason})`);
	}
	return lines.join('\n');
}
