import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../policy/contracts/primitives.ts';
import type {
	AdapterRegistration, EvidenceReport, EvidenceRequest, CommandPinRecord, CommandPretestStep, CommandRegistration, ExecutableRegistration,
} from '../policy/contracts/quality-evidence-schema.ts';
import { hashEvidenceBytes, readEvidenceFile } from './evidence-files.ts';

export type PinSpec = { file: string } | { script: { file: string; name: string } };
export const PINNED_FILE_MODIFIED = 'PINNED_FILE_MODIFIED';

export const isCommandRegistration = (registration: AdapterRegistration): registration is CommandRegistration =>
	'kind' in registration && registration.kind === 'command';

/** Repository-relative files an evidence registration freezes, for containment checks. */
export function evidenceRegistrationFiles(registration: AdapterRegistration): { path: string }[] {
	if (isCommandRegistration(registration)) {
		return [...registration.pins, ...(registration.pretest ?? []).flatMap((step) => step.pins)]
			.map((pin) => ({ path: pin.kind === 'file' ? pin.path : pin.file }));
	}
	const executable = registration as ExecutableRegistration;
	return [
		...executable.bundleFiles, ...executable.dependencyFiles, ...executable.configurationFiles,
		...(executable.dependencyManifest ? [executable.dependencyManifest] : []),
	];
}

const PLACEHOLDER = /\{[^{}]*\}/g;

/** Substitutes `{reportPath}` and `{baseSha}` as a whole token or a `key=value` value; anything else throws. */
export function substituteArgv(argv: readonly string[], values: { reportPath: string; baseSha?: string }): string[] {
	return argv.map((token, index) => {
		const found = token.match(PLACEHOLDER);
		if (!found) return token;
		const name = found[0].slice(1, -1);
		const value = name === 'reportPath' ? values.reportPath : name === 'baseSha' ? values.baseSha : undefined;
		if (index === 0 || found.length !== 1 || value === undefined || !(token === found[0] || token.endsWith(`=${found[0]}`))) {
			throw new Error('invalid-command-placeholder');
		}
		return token.slice(0, token.length - found[0].length) + value;
	});
}

/** Resolves argv[0] outside the sandbox to a regular executable's realpath and hash. */
export function resolveExecutable(argv0: string, searchPath: string): { path: string; sha256: string } {
	const candidates = path.isAbsolute(argv0) ? [argv0]
		: argv0.includes('/') ? [] : searchPath.split(':').filter((entry) => path.isAbsolute(entry)).map((entry) => path.join(entry, argv0));
	for (const candidate of candidates) {
		let real: string;
		try { real = fs.realpathSync.native(candidate); } catch { continue; }
		const stat = fs.statSync(real);
		if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
		const bytes = readEvidenceFile(path.parse(real).root, real.slice(path.parse(real).root.length), Number.MAX_SAFE_INTEGER);
		return { path: real, sha256: hashEvidenceBytes(bytes) };
	}
	throw new Error('unresolvable-command-executable');
}

function scriptHash(root: string, file: string, name: string): string {
	const manifest = JSON.parse(readEvidenceFile(root, file, 1024 * 1024).toString('utf8')) as { scripts?: Record<string, unknown> };
	const scripts = manifest.scripts ?? {};
	if (typeof scripts[name] !== 'string') throw new Error(PINNED_FILE_MODIFIED);
	return sha256({ [name]: scripts[name], [`pre${name}`]: scripts[`pre${name}`] ?? null, [`post${name}`]: scripts[`post${name}`] ?? null });
}

/** Hashes each pin relative to `cwd`. A script pin covers `scripts[name]` and its pre/post hooks only. */
export function recordPins(root: string, cwd: string, pins: readonly PinSpec[]): CommandPinRecord[] {
	return pins.map((pin): CommandPinRecord => {
		if ('file' in pin) {
			const file = `${cwd}/${pin.file}`;
			return { kind: 'file', path: file, sha256: hashEvidenceBytes(readEvidenceFile(root, file, Number.MAX_SAFE_INTEGER)) };
		}
		const file = `${cwd}/${pin.script.file}`;
		return { kind: 'script', file, name: pin.script.name, sha256: scriptHash(root, file, pin.script.name) };
	});
}

export function verifyPins(root: string, pins: readonly CommandPinRecord[]): void {
	for (const pin of pins) {
		let actual: string;
		try {
			actual = pin.kind === 'file'
				? hashEvidenceBytes(readEvidenceFile(root, pin.path, Number.MAX_SAFE_INTEGER))
				: scriptHash(root, pin.file, pin.name);
		} catch { throw new Error(PINNED_FILE_MODIFIED); }
		if (actual !== pin.sha256) throw new Error(PINNED_FILE_MODIFIED);
	}
}

export const commandBindingHash = (
	argv: readonly string[], executableSha256: string, pins: readonly CommandPinRecord[],
	pretest: readonly CommandPretestStep[] = [],
): string => sha256(pretest.length ? { argv, executableSha256, pins, pretest } : { argv, executableSha256, pins });

function verifyExecutable(executable: { path: string; sha256: string }): void {
	const real = executable.path;
	const bytes = readEvidenceFile(path.parse(real).root, real.slice(path.parse(real).root.length), Number.MAX_SAFE_INTEGER);
	if (fs.realpathSync.native(real) !== real || hashEvidenceBytes(bytes) !== executable.sha256) {
		throw new Error('frozen-adapter-file-changed');
	}
}

/** Frozen-state check shared by the before-run and after-run verification. */
export function verifyCommandRegistration(root: string, registration: CommandRegistration): void {
	const pretest = registration.pretest ?? [];
	if (registration.commandSha256 !== commandBindingHash(registration.argv, registration.executable.sha256, registration.pins, pretest)) {
		throw new Error('frozen-adapter-file-changed');
	}
	verifyExecutable(registration.executable);
	verifyPins(root, registration.pins);
	for (const step of pretest) {
		verifyExecutable(step.executable);
		verifyPins(root, step.pins);
	}
}

export interface CommandCaseResult {
	identity: string;
	outcome: 'passed' | 'failed' | 'skipped' | 'not-run';
	message: string;
	attempts: number;
}

/** Corpus case identities (`AC-nn.m`) an evidence request selects. */
export function selectedCaseIdentities(request: EvidenceRequest): string[] {
	const ids = request.obligations.map((obligation) => obligation.caseId);
	if (ids.some((id) => id === null)) throw new Error('invalid-evidence');
	return [...new Set(ids as string[])];
}

/** Builds the standard EvidenceReport from the engine-parsed command report; it adds no trust of its own. */
export function synthesizeCommandReport(
	registration: CommandRegistration, request: EvidenceRequest, cases: readonly CommandCaseResult[],
): EvidenceReport {
	const byIdentity = new Map(cases.map((entry) => [entry.identity, entry]));
	const grouped = new Map<string, { file: string; caseKey: string; ids: string[]; capabilities: Set<string>; identity: string }>();
	for (const obligation of request.obligations) {
		for (const testCase of obligation.testCases) {
			const key = `${testCase.file}\0${testCase.caseKey}`;
			const item = grouped.get(key) ?? { file: testCase.file, caseKey: testCase.caseKey, ids: [], capabilities: new Set<string>(), identity: obligation.caseId as string };
			if (item.identity !== obligation.caseId) throw new Error('invalid-evidence');
			item.ids.push(obligation.obligationId);
			for (const capability of obligation.requiredCapabilities) item.capabilities.add(capability);
			grouped.set(key, item);
		}
	}
	return {
		schemaVersion: '1.0.0', operationId: request.operationId, requestHash: sha256(request),
		adapterBindingHash: request.adapterBindingHash, profileId: request.profileId, artifacts: [],
		cases: [...grouped.values()].map((item) => {
			const result = byIdentity.get(item.identity);
			if (!result) throw new Error('invalid-evidence');
			return {
				file: item.file, caseKey: item.caseKey, obligationIds: item.ids,
				exercisedCapabilities: result.outcome === 'passed' ? [...item.capabilities] : [],
				outcome: result.outcome,
				attempts: result.outcome === 'not-run' ? []
					: [{ index: 0, outcome: result.outcome, durationMs: 0, artifactPaths: [] }],
			} as EvidenceReport['cases'][number];
		}),
	};
}
