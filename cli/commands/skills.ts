import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { REPOSITORY_ROOT } from '../../persistence/run-paths.ts';
import {
	AppliedSkillsRegistrySchema,
	applyPatchToContent,
	validateFindingKey,
} from '../../policy/contracts.ts';
import { SdlcError } from '../../policy/errors.ts';
import {
	aggregateSkillsTrends,
	renderSkillsHuman,
} from '../../scripts/aggregate-critic-trends.ts';
import {
	type TraceAuditorGovernorLike,
	runTraceSkillAuditor,
} from '../../scripts/trace-skill-auditor.ts';
import { readFleetFrictionSummary } from '../../workflow/fleet.ts';
import type { ParsedArguments } from '../arguments.ts';
import type { CliStreams, RunCliFn } from '../shell-driver.ts';

export type CreateReadlineFn = (options: {
	input: CliStreams['stdin'];
	output: CliStreams['stdout'];
}) => {
	question?(prompt: string): Promise<string>;
	close?(): void;
};

export async function executeSkills(
	parsed: ParsedArguments,
	options: {
		rootDir?: string;
		streams: CliStreams;
		governor?: TraceAuditorGovernorLike | null;
		createReadline?: CreateReadlineFn | null;
	},
): Promise<Record<string, unknown>> {
	const rootDir = options.rootDir ?? REPOSITORY_ROOT;
	const runId = parsed.values.get('--run');
	const isApply = parsed.booleans.has('--apply');
	const key = parsed.values.get('--key');
	const isYes = parsed.booleans.has('--yes');

	if (runId) {
		const auditResult = await runTraceSkillAuditor({
			runId,
			rootDir,
			governor: options.governor ?? undefined,
		});
		return {
			command: 'skills',
			state: 'DONE',
			findingsCount: auditResult.findings?.length ?? 0,
			...auditResult,
			message: `Trace skill attribution complete for run ${runId}. Persisted ${auditResult.findings?.length ?? 0} finding(s). Sync artifact: ${auditResult.syncArtifactPath}`,
		};
	}

	if (isApply) {
		if (!key) {
			throw new SdlcError('INVALID_INPUT', 'Missing required flag --key for skills --apply');
		}

		validateFindingKey(key);

		// Re-evaluate trends across local SQLite and git artifacts
		const trendsResult = aggregateSkillsTrends({ rootDir });
		const trend = trendsResult.trends.find((t) => t.key === key);

		if (!trend || trend.status !== 'RECOMMENDED') {
			throw new SdlcError(
				'POLICY_VIOLATION',
				`Cannot apply finding: key "${key}" has not reached the recommendation threshold (runCount < 3).`,
				{ exitCode: 70 },
			);
		}

		if (trend.attributionLayer !== 'layer3') {
			throw new SdlcError(
				'POLICY_VIOLATION',
				'Cannot apply finding: issue has been attributed to Layer 1 (tooling/scripts). Under the Ratchet Pattern, deterministic checks take precedence over prompt modifications.',
				{ exitCode: 70 },
			);
		}

		const promptRelPath = path.join('.agents/workflows/prompts', `${trend.roleId}.md`);
		const promptFullPath = path.join(rootDir, promptRelPath);

		// Find proposal diff
		const proposal = trendsResult.recommendedProposals.find((p) => p.key === key);
		const diffText =
			proposal?.proposedDiff ??
			`+<!-- Learned SDLC Rule: ${key} -->\n+- Invariant [${trend.category}]: Always verify ${trend.category} constraints before completing action.\n`;

		options.streams.stdout.write(`\nProposed changes to ${promptRelPath}:\n${diffText}\n\n`);

		if (!isYes) {
			if (!options.streams.stdin?.isTTY && !options.createReadline) {
				return {
					command: 'skills',
					applied: false,
					key,
					message: 'Apply aborted: non-interactive environment without --yes.',
				};
			}
			let answer = '';
			if (options.createReadline) {
				const rl = options.createReadline({
					input: options.streams.stdin,
					output: options.streams.stdout,
				});
				if (typeof rl.question === 'function') {
					answer = await rl.question('Apply this prompt modification? [y/N]: ');
				}
				rl.close?.();
			} else {
				const rawOut: unknown = options.streams.stdout;
				const rl = readline.createInterface({
					input: options.streams.stdin,
					output: rawOut as NodeJS.WritableStream,
				});
				try {
					answer = await rl.question('Apply this prompt modification? [y/N]: ');
				} finally {
					rl.close();
				}
			}
			if (answer.trim().toLowerCase() !== 'y' && answer.trim().toLowerCase() !== 'yes') {
				return {
					command: 'skills',
					applied: false,
					key,
					message: 'Apply cancelled by operator.',
				};
			}
		}

		// Apply the patch
		fs.mkdirSync(path.dirname(promptFullPath), { recursive: true });
		let promptContent = fs.existsSync(promptFullPath)
			? fs.readFileSync(promptFullPath, 'utf8')
			: `# ${trend.roleId} Role Prompt\n`;
		const ruleComment = `<!-- Learned SDLC Rule: ${key} -->`;
		if (!promptContent.includes(ruleComment)) {
			promptContent = applyPatchToContent(promptContent, diffText);
			fs.writeFileSync(promptFullPath, promptContent, 'utf8');
		}

		// Update .agents/applied-skills.json
		const registryPath = path.join(rootDir, '.agents/applied-skills.json');
		let registry: {
			schemaVersion: string;
			applied: Array<{ findingKey: string; appliedAt: string; promptFile: string }>;
		} = { schemaVersion: '1.0.0', applied: [] };
		if (fs.existsSync(registryPath)) {
			try {
				registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as typeof registry;
			} catch {}
		}
		if (!Array.isArray(registry.applied)) {
			registry.applied = [];
		}
		const alreadyApplied = registry.applied.some((entry) => entry.findingKey === key);
		if (!alreadyApplied) {
			registry.applied.push({
				findingKey: key,
				appliedAt: new Date().toISOString(),
				promptFile: promptRelPath,
			});
			AppliedSkillsRegistrySchema.parse(registry);
			fs.mkdirSync(path.dirname(registryPath), { recursive: true });
			fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
		}

		return {
			command: 'skills',
			applied: true,
			key,
			promptFile: promptRelPath,
			message: `Successfully applied learning ${key} to ${promptRelPath}.`,
		};
	}

	// Default: list skills trends
	const trendsResult = aggregateSkillsTrends({ rootDir });
	return {
		command: 'skills',
		message: renderSkillsHuman(trendsResult),
		...trendsResult,
	};
}

export async function maybePromptLearningDebt({
	command,
	result,
	rootDir = REPOSITORY_ROOT,
	streams = {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
	},
	parsedJson = false,
	createReadline = null,
	runCliFn,
}: {
	command: string;
	result: { state?: unknown; runId?: unknown; [key: string]: unknown };
	rootDir?: string;
	streams?: CliStreams;
	parsedJson?: boolean;
	createReadline?: CreateReadlineFn | null;
	runCliFn?: RunCliFn;
}): Promise<void> {
	if (typeof runCliFn !== 'function') {
		throw new SdlcError('INVALID_INPUT', 'runCliFn is required');
	}
	const eligibleCommands = ['start', 'resume', 'authorize'];
	if (!eligibleCommands.includes(command)) return;
	if (result.state !== 'READY_FOR_GIT_APPROVAL' && result.state !== 'DONE') return;
	if (parsedJson) return;

	let summary: ReturnType<typeof readFleetFrictionSummary>;
	try {
		summary = readFleetFrictionSummary({ rootDir });
	} catch {
		return;
	}

	const needsFrictionReview = summary.unreviewedFrictionCount >= 3;
	const needsStaleReview = summary.staleRecommendationsCount >= 1;
	if (!needsFrictionReview && !needsStaleReview) return;

	// Non-TTY fallback: write informational advisory and exit cleanly (AC-15)
	if (!streams.stdin?.isTTY) {
		if (needsFrictionReview) {
			streams.stdout.write(
				`⚠️  SDLC Learning Debt: ${summary.unreviewedFrictionCount} run(s) with unanalyzed friction. Run 'agent-sdlc skills' to analyze.\n`,
			);
		} else if (needsStaleReview) {
			streams.stdout.write(
				`⚡ SDLC Learning Debt: Recommended prompt update available. Run 'agent-sdlc skills --apply' to update.\n`,
			);
		}
		return;
	}

	// Interactive TTY mode (AC-14)
	let promptText: string;
	let action: 'analyze' | 'apply';
	if (needsFrictionReview) {
		promptText = `⚠️  SDLC Learning Debt: ${summary.unreviewedFrictionCount} run(s) with unanalyzed friction. Run trace attribution now? [y/N]: `;
		action = 'analyze';
	} else {
		promptText = `⚡ SDLC Learning Debt: Recommended prompt update available. Apply now? [y/N]: `;
		action = 'apply';
	}

	let answer = '';
	try {
		if (createReadline) {
			const rl = createReadline({ input: streams.stdin, output: streams.stdout });
			if (typeof rl.question === 'function') {
				answer = await rl.question(promptText);
			}
			rl.close?.();
		} else {
			const rawOut: unknown = streams.stdout;
			const rl = readline.createInterface({
				input: streams.stdin,
				output: rawOut as NodeJS.WritableStream,
			});
			answer = await rl.question(promptText);
			rl.close();
		}
	} catch {
		return;
	}

	if (answer.trim().toLowerCase() === 'y') {
		try {
			if (action === 'analyze') {
				const runIdStr = typeof result.runId === 'string' ? result.runId : '';
				const targetRunId = summary.unreviewedRunIds.includes(runIdStr)
					? runIdStr
					: summary.unreviewedRunIds[0];
				if (targetRunId) {
					await runCliFn(['skills', '--run', targetRunId], { rootDir, streams });
				}
			} else if (action === 'apply') {
				const targetKey = summary.recommendedKeys[0];
				if (targetKey) {
					await runCliFn(['skills', '--apply', '--key', targetKey], { rootDir, streams });
				}
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			streams.stderr?.write?.(`${message}\n`);
		}
	}
}
