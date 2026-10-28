import fs from 'node:fs';
import path from 'node:path';
import { RepositoryModelGovernor } from '../../adapters/model-governor.ts';
import { archiveCompletedLedgerRuns } from '../../persistence/ledger-archive.ts';
import { createRuntimeDirectory, liveRunRoot, runsRootDir } from '../../persistence/run-paths.ts';
import { SdlcError } from '../../policy/errors.ts';
import {
	evaluateCanaryEligibility,
	evaluateCurrentCanaryGate,
} from '../../policy/reliability.ts';
import { evaluateTaskReadiness } from '../../policy/task-planner.ts';
import {
	canonicalizeAuthorVendor,
	resolveAuthorVendor,
} from '../../review/author-vendor.ts';
import { RoleRegistry } from '../../roles/role-registry.ts';
import { evaluateAcceptanceCriteriaQuality } from '../../workflow/acceptance-criteria.ts';
import {
	evaluateCompleteness,
	parseSpecification,
	taskManifestHash,
} from '../../workflow/specification.ts';
import type { ParsedArguments } from '../arguments.ts';
import {
	type OpenContextOptions,
	openContext,
	resolveGoalText,
	resolveTaskManifest,
} from '../run-context.ts';
import type { CliStreams } from '../shell-driver.ts';

export function resolveExecutorSelection(
	parsed: { values?: ReadonlyMap<string, string> } | null | undefined,
	env: NodeJS.ProcessEnv = process.env,
): 'minimal' {
	const flag = parsed?.values?.get?.('--executor');
	const fromFlag = flag == null || flag === '' ? null : flag;
	const rawEnv = env?.AGENT_SDLC_EXECUTOR;
	const fromEnv = rawEnv == null || rawEnv === '' ? null : rawEnv;
	if (fromFlag && fromEnv && fromFlag !== fromEnv) {
		throw new SdlcError('INVALID_INPUT', 'AGENT_SDLC_EXECUTOR and --executor disagree');
	}
	const selected = fromFlag ?? fromEnv;
	if (selected == null) return 'minimal';
	if (selected !== 'minimal') {
		throw new SdlcError('INVALID_INPUT', 'executor must be minimal');
	}
	return selected;
}

function cryptoRandomSuffix(): string {
	return globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 8);
}

export async function startRun(
	parsed: ParsedArguments,
	{
		rootDir,
		streams,
		governor: injectedGovernor,
		onBoundary,
		gitCli,
		execCli,
		ghCli,
		env = process.env,
	}: {
		rootDir: string;
		streams?: CliStreams;
		governor?: OpenContextOptions['governor'];
		onBoundary?: OpenContextOptions['onBoundary'];
		gitCli?: OpenContextOptions['gitCli'];
		execCli?: OpenContextOptions['execCli'];
		ghCli?: OpenContextOptions['ghCli'];
		env?: NodeJS.ProcessEnv;
	},
): Promise<Record<string, unknown>> {
	const executor = resolveExecutorSelection(parsed, env);
	const registry = new RoleRegistry({ rootDir });
	const loaded = registry.load();
	const governor = injectedGovernor ?? new RepositoryModelGovernor({ rootDir });
	const goal = resolveGoalText(parsed, {
		rootDir,
		maxGoalBytes: loaded.workflow.limits.maxGoalBytes,
		command: 'start',
	});
	const draft = parseSpecification(goal);
	const completeness = evaluateCompleteness(draft);
	const acceptanceCriteriaQuality = evaluateAcceptanceCriteriaQuality(draft);
	const taskManifest = resolveTaskManifest(parsed, {
		rootDir,
		maxBytes: loaded.workflow.limits.maxGoalBytes,
	});
	if (taskManifest && (!completeness.complete || !acceptanceCriteriaQuality.complete)) {
		throw new SdlcError(
			'TASK_PLAN_INVALID',
			'--task-plan-file requires a complete goal with frozen acceptance criteria',
		);
	}
	let taskReadiness: ReturnType<typeof evaluateTaskReadiness> | null = null;
	if (taskManifest || (completeness.complete && acceptanceCriteriaQuality.complete)) {
		taskReadiness = evaluateTaskReadiness({ draft, taskManifest, rootDir });
	}
	if (
		taskManifest &&
		taskReadiness &&
		!evaluateCanaryEligibility(taskReadiness).eligible &&
		!parsed.booleans.has('--skip-canary')
	) {
		const canaryGate = evaluateCurrentCanaryGate(rootDir);
		if (!canaryGate.current) {
			throw new SdlcError(
				canaryGate.status === 'CANARY_STALE' ? 'CANARY_STALE' : 'CANARY_REQUIRED',
				`A current passing hosted canary is required before starting this larger task plan (${canaryGate.reason})`,
				{ canaryGate },
			);
		}
	}
	if (typeof governor.assertAvailable === 'function') {
		await governor.assertAvailable();
	}
	const slug = parsed.values.get('--slug') ?? `sdlc-${cryptoRandomSuffix()}`;
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
		throw new SdlcError('INVALID_INPUT', 'Slug must be kebab-case');
	}
	const runId = `${new Date().toISOString().slice(0, 10)}-${slug}`;
	const runDir = path.join(runsRootDir(rootDir), runId);
	const runtimeDir = path.join(liveRunRoot(rootDir), runId);
	const colocatedRunDir = path.resolve(runDir) === path.resolve(runtimeDir);
	let createdRunDir = false;
	let createdRuntimeDir = false;
	let canonicalInitializationCommitted = false;
	try {
		if (fs.existsSync(runDir)) {
			throw new SdlcError(
				'RUN_ALREADY_EXISTS',
				`Run directory already exists for slug '${slug}'`,
				{ slug },
			);
		}
		if (colocatedRunDir) {
			createRuntimeDirectory(runId, rootDir);
			createdRuntimeDir = true;
			createdRunDir = true;
		} else {
			fs.mkdirSync(runDir, { recursive: true });
			createdRunDir = true;
			createRuntimeDirectory(runId, rootDir);
			createdRuntimeDir = true;
		}
		fs.writeFileSync(
			path.join(runDir, 'plan.md'),
			`# Execution Plan: ${runId}\n\n## Status\n- Orchestrated run initialized.\n`,
			'utf8',
		);
		const staleLedgerPath = path.join(rootDir, 'tools/.model-usage/runs', `${runId}.json`);
		if (fs.existsSync(staleLedgerPath)) {
			fs.unlinkSync(staleLedgerPath);
		}
		// Auto-archive completed/stale model-usage runs to maintain instance token headroom
		const autoArchive = archiveCompletedLedgerRuns(rootDir, { currentRunId: runId });
		if (autoArchive.archived.length > 0) {
			streams?.stderr?.write?.(
				`[agent-sdlc] Auto-archived ${autoArchive.archived.length} completed model-usage run(s) (${autoArchive.freedTokens} tokens freed)\n`,
			);
		}
		const context = openContext({
			rootDir,
			runId,
			governor,
			registry,
			onBoundary,
			gitCli,
			execCli,
			ghCli,
		});
		try {
			let initial;
			try {
				const rawAuthorVendor = parsed.values.get('--author-vendor');
				const authorVendor = rawAuthorVendor
					? canonicalizeAuthorVendor(rawAuthorVendor)
					: resolveAuthorVendor({ authorVendor: null });
				initial = context.runtime.initialize({
					runId,
					goal,
					authorVendor,
					taskManifest,
					expectedTaskManifestHash:
						taskManifest === null ? null : taskManifestHash(taskManifest),
					...(executor ? { executor } : {}),
				});
				canonicalInitializationCommitted = true;
			} catch (error: unknown) {
				canonicalInitializationCommitted = context.store.hasRun(runId);
				throw error;
			}
			const state = await context.runtime.start(initial);
			await context.projection.reconcile();
			return { ...context.projection.readStatusResult(), state: state.state };
		} finally {
			context.store.close();
		}
	} catch (error: unknown) {
		if (
			!canonicalInitializationCommitted &&
			createdRuntimeDir &&
			fs.existsSync(runtimeDir)
		) {
			fs.rmSync(runtimeDir, { recursive: true, force: true });
		}
		if (!canonicalInitializationCommitted && createdRunDir && fs.existsSync(runDir)) {
			fs.rmSync(runDir, { recursive: true, force: true });
		}
		throw error;
	}
}
