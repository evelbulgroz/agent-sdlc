import fs from 'node:fs';
import path from 'node:path';
import { bytesHash, engineModule, fail, regularFile } from './primitives.ts';
import type {
	CommandPinRecord, CommandPretestStep, CommandRegistration, EvidenceAdapterProfile,
} from '../policy/contracts/quality-evidence-schema.ts';
import { executeOwned } from './process.ts';
import { COMMAND_PATH, namespaceArgv } from './sandbox.ts';
import {
	MAX_REPORT_BYTES, parseReport, prepareReportDirectory, readReportFile, selectCases,
} from './report-formats.ts';
import type { CaseResult, ReportFormat } from './report-formats.ts';
import type { AcceptanceConfig, CommandBlock, ExecuteOwned } from './types.ts';

type PinInput = NonNullable<CommandBlock['pins']>[number];

const EXTENSIONS: Record<ReportFormat, string> = { junit: 'xml', 'case-report': 'json' };
const NODE_DESTINATION = '/opt/sdlc/bin/node';
const CLOCK_TOLERANCE_MS = 20;

// `pm run <script>` implies a script pin; `node <file>` implies a file pin. Anything else needs explicit pins.
function defaultPins(argv: readonly string[]): PinInput[] {
	const runIndex = argv.indexOf('run');
	const [first = '', second, third] = argv;
	if (runIndex === 1 && third && !third.startsWith('-')) return [{ script: { file: 'package.json', name: third } }];
	if (!first.includes('/') && path.basename(first) === 'node' && second && !second.startsWith('-')) return [{ file: second }];
	return [];
}

/**
 * Builds `command` AdapterRegistrations from the profile's `commands` blocks. argv[0] is resolved here, in the
 * supervisor, and pinned by realpath and hash; pins are hashed from the frozen tree.
 */
export async function buildCommandRegistrations(
	root: string,
	config: Pick<AcceptanceConfig, 'packageRoot' | 'pretest' | 'commands' | 'caseManifest' | 'repositoryId'>,
	{ searchPath = process.env.PATH ?? '' }: { searchPath?: string } = {},
): Promise<CommandRegistration[]> {
	const { resolveExecutable, recordPins, commandBindingHash } = await engineModule('host/command-evidence');
	const frozen = (command: Pick<CommandBlock, 'argv' | 'cwd' | 'pins'>) => {
		const cwd = command.cwd ?? config.packageRoot;
		return { cwd, executable: resolveExecutable(command.argv[0], searchPath),
			pins: [...recordPins(root, cwd, command.pins ?? defaultPins(command.argv))] as CommandPinRecord[] };
	};
	const pretest = config.pretest.map((step): CommandPretestStep => {
		if (step.argv.some((token: string) => /\{[^{}]*\}/.test(token))) fail(`pretest step takes no placeholders: ${step.id}`);
		return { id: step.id, argv: [...step.argv], timeoutMs: step.timeoutMs ?? 120000, ...frozen(step) };
	});
	return Object.entries(config.commands).map(([layer, command]) => {
		const { cwd, executable, pins } = frozen(command);
		const known = new Set(pretest.map((step) => step.id));
		for (const id of command.pretest ?? []) if (!known.has(id)) fail(`command ${layer} names unknown pretest step: ${id}`);
		const wanted = command.pretest;
		const steps = wanted ? pretest.filter((step) => wanted.includes(step.id)) : pretest;
		pins.push({ kind: 'file', path: config.caseManifest, sha256: bytesHash(fs.readFileSync(regularFile(root, config.caseManifest))) });
		return {
			kind: 'command', adapterId: `${config.repositoryId}-${layer}`, protocolVersion: '1.0.0',
			argv: [...command.argv], cwd, reportFormat: command.format ?? 'junit', retries: command.retries ?? 0,
			executable, pins, ...(steps.length ? { pretest: steps } : {}),
			commandSha256: commandBindingHash(command.argv, executable.sha256, pins, steps),
			profiles: [{
				profileId: layer, layers: [command.layer ?? layer] as EvidenceAdapterProfile['layers'],
				capabilities: (command.capabilities ?? []) as EvidenceAdapterProfile['capabilities'],
			}],
			limits: { timeoutMs: command.timeoutMs ?? 120000, maxReportBytes: MAX_REPORT_BYTES, maxArtifactBytes: 16777216, maxArtifacts: 8 },
		};
	});
}

/** Admission check: whole-file pins (config, corpus, sentinel) may not lie inside the model's write scope. */
export function assertPinsOutsideWriteScope(registrations: readonly CommandRegistration[], allowedPathPrefixes: readonly string[]): void {
	const inside = (file: string): boolean => allowedPathPrefixes.some((prefix) => {
		const base = prefix.replace(/\/+$/, '');
		return base === '.' || file === base || file.startsWith(`${base}/`);
	});
	for (const registration of registrations) {
		for (const pin of [...registration.pins, ...(registration.pretest ?? []).flatMap((step) => step.pins)]) if (pin.kind === 'file' && inside(pin.path)) fail(`pinned file inside write scope: ${pin.path}`);
	}
}

/**
 * Supervisor-side run of one command registration: verifies the frozen state, runs the substituted argv in the
 * sandbox, verifies again, and returns the report bytes. The report is never read from stdout.
 */
export interface CommandRun {
	worktree: string;
	config: AcceptanceConfig;
	registration: CommandRegistration;
	baseSha: string;
	reportDirectory: string;
	timeoutMs: number;
	execute?: ExecuteOwned;
}

export async function runCommandInSandbox({ worktree, config, registration, baseSha, reportDirectory, timeoutMs, execute = executeOwned }: CommandRun): Promise<{ code: number | null; reportBytes: Buffer; stderr: string }> {
	const { substituteArgv, verifyCommandRegistration } = await engineModule('host/command-evidence');
	worktree = fs.realpathSync(worktree);
	verifyCommandRegistration(worktree, registration);
	const layer = (registration.profiles[0] as CommandRegistration['profiles'][number]).profileId;
	const name = `${layer}.${EXTENSIONS[registration.reportFormat]}`;
	const nodeReal = fs.realpathSync(config.node);
	const launch = (frozen: { executable: { path: string }; cwd: string }, argv: readonly string[], limit: number) => {
		const isNode = frozen.executable.path === nodeReal;
		const destination = isNode ? NODE_DESTINATION : frozen.executable.path;
		const binaries = [{ source: nodeReal, destination: NODE_DESTINATION }];
		if (!isNode) binaries.push({ source: frozen.executable.path, destination });
		return execute(namespaceArgv({ ...config, root: worktree }, [destination, ...argv.slice(1)], {
			command: { binaries, report: reportDirectory, cwd: frozen.cwd },
		}), { cwd: worktree, timeoutMs: limit, maxBytes: 1048576 });
	};
	prepareReportDirectory(reportDirectory);
	// Setup steps run first in the same sandbox; any failure stops the run before the command and its report.
	for (const step of registration.pretest ?? []) {
		const setup = await launch(step, step.argv, Math.min(step.timeoutMs, timeoutMs));
		if (setup.code !== 0) fail(`pretest step failed: ${step.id} (exit ${setup.code}) ${String(setup.stderr ?? '').slice(-512)}`);
	}
	const argv = substituteArgv(registration.argv, { reportPath: `/report/${name}`, baseSha });
	const startedMs = Date.now();
	const result = await launch(registration, argv, timeoutMs);
	verifyCommandRegistration(worktree, registration);
	const reportBytes = Buffer.from(readReportFile(reportDirectory, name, {
		maxBytes: registration.limits.maxReportBytes, runStartedMs: startedMs - CLOCK_TOLERANCE_MS,
	}), 'utf8');
	return { code: result.code, reportBytes, stderr: String(result.stderr ?? '').slice(-16384) };
}

/** Engine-child side: parses the brokered report bytes into per-case results. */
export function casesFromReport({ registration, selected, code, reportBytes }: {
	registration: Pick<CommandRegistration, 'reportFormat' | 'retries'>;
	selected: readonly string[];
	code: number | null;
	reportBytes: Buffer;
}): CaseResult[] {
	const rows = parseReport(registration.reportFormat, reportBytes.toString('utf8'));
	return selectCases({ rows, selected, exitCode: code, retries: registration.retries });
}

export { COMMAND_PATH };
