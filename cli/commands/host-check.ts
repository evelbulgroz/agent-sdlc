import path from 'node:path';
import { type HostProfile, loadHostProfile } from '../../host/host-profile.ts';
import type { ParsedArguments } from '../arguments.ts';
import type { CommandDispatchOptions } from './index.ts';

export function assertStartHostProfile(rootDir: string): HostProfile {
	return loadHostProfile(rootDir);
}

export function hostCheck(
	parsed: ParsedArguments,
	options: CommandDispatchOptions,
): Record<string, unknown> {
	const rawRoot = parsed.values.get('--root');
	const targetRoot = rawRoot
		? path.resolve(options.rootDir, rawRoot)
		: options.rootDir;
	const profile = loadHostProfile(targetRoot);
	return {
		profileId: profile.profileId,
		adapter: profile.adapter,
	};
}
