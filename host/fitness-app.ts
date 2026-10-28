import { validateCommandAllowlist } from '../execution/tool-commands.ts';
import { hydrateWorktree, type HydrationRunnerFn } from '../workflow/hydration.ts';

export { hydrateWorktree, validateCommandAllowlist };

export function validateCommand(command: unknown, args: readonly unknown[]): void {
	validateCommandAllowlist(command, args);
}

export async function hydrate({
	worktreeDir,
	allowedPackages = null,
	targetPackage = null,
	metadataDir = null,
	runner,
	now,
}: {
	worktreeDir: string;
	allowedPackages?: string | readonly string[] | null;
	targetPackage?: string | null;
	metadataDir?: string | null;
	runner?: HydrationRunnerFn;
	now?: Date;
}): Promise<{ status: 'CACHED' | 'HYDRATED'; fingerprint: string; stepsCompleted: string[] }> {
	return hydrateWorktree({
		worktreeDir,
		allowedPackages,
		targetPackage,
		metadataDir,
		...(runner ? { runner } : {}),
		...(now ? { now } : {}),
	});
}
