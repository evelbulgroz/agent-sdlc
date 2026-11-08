import fs from 'node:fs';
import path from 'node:path';
import { bytesHash, engineModule, fail, regularFile } from './primitives.mjs';
import { executeOwned } from './process.mjs';
import { COMMAND_PATH, namespaceArgv } from './sandbox.mjs';
import {
	MAX_REPORT_BYTES, parseReport, prepareReportDirectory, readReportFile, selectCases,
} from './report-formats.mjs';

const EXTENSIONS = { junit: 'xml', 'case-report': 'json' };
const NODE_DESTINATION = '/opt/sdlc/bin/node';
const CLOCK_TOLERANCE_MS = 20;

// `pm run <script>` implies a script pin; `node <file>` implies a file pin. Anything else needs explicit pins.
function defaultPins(argv) {
	const runIndex = argv.indexOf('run');
	if (runIndex === 1 && argv[2] && !argv[2].startsWith('-')) return [{ script: { file: 'package.json', name: argv[2] } }];
	if (!argv[0].includes('/') && path.basename(argv[0]) === 'node' && argv[1] && !argv[1].startsWith('-')) return [{ file: argv[1] }];
	return [];
}

/**
 * Builds `command` AdapterRegistrations from the profile's `commands` blocks. argv[0] is resolved here, in the
 * supervisor, and pinned by realpath and hash; pins are hashed from the frozen tree.
 */
export async function buildCommandRegistrations(root, config, { searchPath = process.env.PATH ?? '' } = {}) {
	const { resolveExecutable, recordPins, commandBindingHash } = await engineModule('host/command-evidence');
	return Object.entries(config.commands).map(([layer, command]) => {
		const cwd = command.cwd ?? config.packageRoot;
		const executable = resolveExecutable(command.argv[0], searchPath);
		const pins = [...recordPins(root, cwd, command.pins ?? defaultPins(command.argv))];
		pins.push({ kind: 'file', path: config.caseManifest, sha256: bytesHash(fs.readFileSync(regularFile(root, config.caseManifest))) });
		return {
			kind: 'command', adapterId: `${config.repositoryId}-${layer}`, protocolVersion: '1.0.0',
			argv: [...command.argv], cwd, reportFormat: command.format ?? 'junit', retries: command.retries ?? 0,
			executable, pins, commandSha256: commandBindingHash(command.argv, executable.sha256, pins),
			profiles: [{ profileId: layer, layers: [layer], capabilities: command.capabilities ?? [] }],
			limits: { timeoutMs: command.timeoutMs ?? 120000, maxReportBytes: MAX_REPORT_BYTES, maxArtifactBytes: 16777216, maxArtifacts: 8 },
		};
	});
}

/** Admission check: whole-file pins (config, corpus, sentinel) may not lie inside the model's write scope. */
export function assertPinsOutsideWriteScope(registrations, allowedPathPrefixes) {
	const inside = (file) => allowedPathPrefixes.some((prefix) => {
		const base = prefix.replace(/\/+$/, '');
		return base === '.' || file === base || file.startsWith(`${base}/`);
	});
	for (const registration of registrations) {
		for (const pin of registration.pins) if (pin.kind === 'file' && inside(pin.path)) fail(`pinned file inside write scope: ${pin.path}`);
	}
}

/**
 * Supervisor-side run of one command registration: verifies the frozen state, runs the substituted argv in the
 * sandbox, verifies again, and returns the report bytes. The report is never read from stdout.
 */
export async function runCommandInSandbox({ worktree, config, registration, baseSha, reportDirectory, timeoutMs, execute = executeOwned }) {
	const { substituteArgv, verifyCommandRegistration } = await engineModule('host/command-evidence');
	worktree = fs.realpathSync(worktree);
	verifyCommandRegistration(worktree, registration);
	const layer = registration.profiles[0].profileId;
	const name = `${layer}.${EXTENSIONS[registration.reportFormat]}`;
	const argv = substituteArgv(registration.argv, { reportPath: `/report/${name}`, baseSha });
	const executable = registration.executable.path;
	const isNode = executable === fs.realpathSync(config.node);
	const destination = isNode ? NODE_DESTINATION : executable;
	const binaries = [{ source: fs.realpathSync(config.node), destination: NODE_DESTINATION }];
	if (!isNode) binaries.push({ source: executable, destination });
	prepareReportDirectory(reportDirectory);
	const startedMs = Date.now();
	const result = await execute(namespaceArgv({ ...config, root: worktree }, [destination, ...argv.slice(1)], {
		command: { binaries, report: reportDirectory, cwd: registration.cwd },
	}), { cwd: worktree, timeoutMs, maxBytes: 1048576 });
	verifyCommandRegistration(worktree, registration);
	const reportBytes = Buffer.from(readReportFile(reportDirectory, name, {
		maxBytes: registration.limits.maxReportBytes, runStartedMs: startedMs - CLOCK_TOLERANCE_MS,
	}), 'utf8');
	return { code: result.code, reportBytes, stderr: String(result.stderr ?? '').slice(-16384) };
}

/** Engine-child side: parses the brokered report bytes into per-case results. */
export function casesFromReport({ registration, selected, code, reportBytes }) {
	const rows = parseReport(registration.reportFormat, reportBytes.toString('utf8'));
	return selectCases({ rows, selected, exitCode: code, retries: registration.retries });
}

export { COMMAND_PATH };
