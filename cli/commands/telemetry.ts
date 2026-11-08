import path from 'node:path';
import { loadHostProfileOrFallback } from '../../host/host-profile.ts';
import { runsRootDir } from '../../persistence/run-paths.ts';
import { SdlcError } from '../../policy/errors.ts';
import { recordPreflightTelemetry } from '../../telemetry/record.ts';
import { exportTelemetrySnapshot } from '../../telemetry/store.ts';
import type { ParsedArguments } from '../arguments.ts';
import type { CommandDispatchOptions } from './index.ts';

function telemetryContext(parsed: ParsedArguments, options: CommandDispatchOptions) {
	const rawRoot = parsed.values.get('--root');
	const rootDir = rawRoot ? path.resolve(options.rootDir, rawRoot) : options.rootDir;
	const profile = loadHostProfileOrFallback(rootDir);
	return {
		rootDir,
		profile,
		runsDir: path.relative(rootDir, runsRootDir(rootDir)),
		telemetryDir: profile.telemetry?.dir ?? path.posix.join(profile.stateDir, 'telemetry'),
	};
}

/** Fail-safe by design: preflight discards the output and ignores the exit status, so problems are reported in the result. */
export function telemetryRecord(parsed: ParsedArguments, options: CommandDispatchOptions): Record<string, unknown> {
	const { rootDir, profile, runsDir, telemetryDir } = telemetryContext(parsed, options);
	const run = parsed.values.get('--run');
	const result = parsed.values.get('--result') ?? profile.verify.resultPath;
	return { ...recordPreflightTelemetry({
		rootDir,
		runsDir,
		telemetryDir,
		runSelector: run ?? null,
		resultFile: result ?? null,
		stdin: parsed.booleans.has('--stdin'),
	}) };
}

export function telemetryExport(parsed: ParsedArguments, options: CommandDispatchOptions): Record<string, unknown> {
	const slug = parsed.values.get('--slug');
	if (!slug) throw new SdlcError('INVALID_INPUT', 'telemetry export requires --slug <run slug>');
	const { rootDir, telemetryDir } = telemetryContext(parsed, options);
	const dest = parsed.values.get('--dest');
	try {
		const envelope = exportTelemetrySnapshot(slug, {
			telemetryDir: path.resolve(rootDir, telemetryDir),
			...(dest ? { dest: path.resolve(options.rootDir, dest) } : {}),
		});
		return { ...envelope, exported: dest ?? null };
	} catch (error) {
		throw new SdlcError('INVALID_INPUT', error instanceof Error ? error.message : String(error));
	}
}
