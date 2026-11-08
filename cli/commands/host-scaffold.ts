import path from 'node:path';
import { scaffoldHost } from '../../host/scaffold.ts';
import { SdlcError } from '../../policy/errors.ts';
import type { ParsedArguments } from '../arguments.ts';
import type { CommandDispatchOptions } from './index.ts';

export function hostScaffold(parsed: ParsedArguments, options: CommandDispatchOptions): Record<string, unknown> {
	const rawRoot = parsed.values.get('--root');
	const packageRoot = parsed.values.get('--package');
	if (!packageRoot) throw new SdlcError('INVALID_INPUT', 'host scaffold requires --package <repository-relative directory>');
	const profileId = parsed.values.get('--profile-id');
	return { ...scaffoldHost({
		rootDir: rawRoot ? path.resolve(options.rootDir, rawRoot) : options.rootDir,
		packageRoot,
		...(profileId ? { profileId } : {}),
		overwrite: parsed.booleans.has('--overwrite'),
		dryRun: parsed.booleans.has('--dry-run'),
	}) };
}
