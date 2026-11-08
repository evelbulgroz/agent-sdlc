import path from 'node:path';
import { loadHostProfileOrFallback } from '../../host/host-profile.ts';
import { runsRootDir } from '../../persistence/run-paths.ts';
import { SdlcError } from '../../policy/errors.ts';
import { initRun } from '../../telemetry/run-init.ts';
import type { ParsedArguments } from '../arguments.ts';
import type { CommandDispatchOptions } from './index.ts';

export function runInit(parsed: ParsedArguments, options: CommandDispatchOptions): Record<string, unknown> {
	const slug = parsed.values.get('--slug');
	if (!slug) throw new SdlcError('INVALID_INPUT', 'run init requires --slug <kebab-case slug>');
	const rawRoot = parsed.values.get('--root');
	const rootDir = rawRoot ? path.resolve(options.rootDir, rawRoot) : options.rootDir;
	const profile = loadHostProfileOrFallback(rootDir);
	const owner = parsed.values.get('--owner');
	return { ...initRun({
		rootDir,
		runsDir: path.relative(rootDir, runsRootDir(rootDir)),
		slug,
		...(owner ? { owner } : {}),
		orchestrated: parsed.booleans.has('--orchestrated'),
		resultFile: profile.verify.resultPath ?? null,
	}) };
}
