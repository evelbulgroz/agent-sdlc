// Host `verificationPreparation` schema: explicit prerequisite builds that run before consumer verification.
// Structural checks (ids, dependencies, cycles, lexical path shape) live here and import nothing from the
// engine, so host-profile.ts can depend on this module without creating an import cycle.
import { z } from 'zod';

const Token = z.string().min(1);

export const VerificationPreparationBuildSchema = z.strictObject({
	id: Token,
	targetPackages: z.array(Token).min(1),
	packagePath: Token,
	argv: z.array(Token).min(1),
	outputPathPrefixes: z.array(Token).min(1),
	dependsOn: z.array(Token).optional(),
});

export type VerificationPreparationBuild = z.infer<typeof VerificationPreparationBuildSchema>;

/** Returns a reason when `candidate` is not a clean relative POSIX path, or null when it is. */
export function relativePathProblem(candidate: string, { allowDot = false }: { allowDot?: boolean } = {}): string | null {
	if (candidate.startsWith('/') || candidate.includes('\\') || /^[A-Za-z]:/.test(candidate)) return 'must be relative';
	if (candidate === '.') return allowDot ? null : "cannot be '.'";
	const segments = candidate.replace(/\/+$/, '').split('/');
	if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
		return 'contains an invalid path segment';
	}
	return null;
}

/**
 * Orders the given build ids topologically (dependencies first), breaking ties by id.
 * Throws when a dependency is unresolved or the graph has a cycle.
 */
export function orderPreparationBuilds(
	builds: readonly { readonly id: string; readonly dependsOn?: readonly string[] }[],
	selectedIds: Iterable<string> = builds.map((build) => build.id),
): string[] {
	const byId = new Map(builds.map((build) => [build.id, build]));
	const ordered: string[] = [];
	const state = new Map<string, 'visiting' | 'done'>();
	const visit = (id: string, trail: readonly string[]): void => {
		const build = byId.get(id);
		if (!build) throw new Error(`unresolved dependency '${id}'${trail.length ? ` (from '${trail.at(-1)}')` : ''}`);
		const current = state.get(id);
		if (current === 'done') return;
		if (current === 'visiting') throw new Error(`dependency cycle: ${[...trail, id].join(' -> ')}`);
		state.set(id, 'visiting');
		for (const dep of [...new Set(build.dependsOn ?? [])].sort()) visit(dep, [...trail, id]);
		state.set(id, 'done');
		ordered.push(id);
	};
	for (const id of [...new Set(selectedIds)].sort()) visit(id, []);
	return ordered;
}

export const VerificationPreparationSchema = z
	.strictObject({ builds: z.array(VerificationPreparationBuildSchema) })
	.superRefine((value, ctx) => {
		const seen = new Set<string>();
		value.builds.forEach((build, index) => {
			const at = (field: string): (string | number)[] => ['builds', index, field];
			if (seen.has(build.id)) ctx.addIssue({ code: 'custom', path: at('id'), message: `duplicate build id '${build.id}'` });
			seen.add(build.id);
			const pkgProblem = relativePathProblem(build.packagePath, { allowDot: true });
			if (pkgProblem) ctx.addIssue({ code: 'custom', path: at('packagePath'), message: `packagePath ${pkgProblem}` });
			for (const target of build.targetPackages) {
				const problem = relativePathProblem(target, { allowDot: true });
				if (problem) ctx.addIssue({ code: 'custom', path: at('targetPackages'), message: `target '${target}' ${problem}` });
			}
			for (const output of build.outputPathPrefixes) {
				const problem = relativePathProblem(output);
				if (problem) ctx.addIssue({ code: 'custom', path: at('outputPathPrefixes'), message: `output '${output}' ${problem}` });
			}
		});
		if (seen.size !== value.builds.length) return;
		try {
			orderPreparationBuilds(value.builds);
		} catch (error: unknown) {
			ctx.addIssue({ code: 'custom', path: ['builds'], message: (error as Error).message });
		}
	});

export type VerificationPreparationConfig = z.infer<typeof VerificationPreparationSchema>;

/** Repository-relative paths that host-profile.ts checks for symlink containment. */
export function preparationContainmentPaths(
	config: VerificationPreparationConfig | undefined,
): [candidate: string, field: string][] {
	const paths: [string, string][] = [];
	for (const build of config?.builds ?? []) {
		paths.push([build.packagePath, 'verificationPreparation.builds.packagePath']);
		for (const output of build.outputPathPrefixes) {
			const joined = build.packagePath === '.' ? output : `${build.packagePath}/${output}`;
			paths.push([joined.replace(/\/+$/, ''), 'verificationPreparation.builds.outputPathPrefixes']);
		}
	}
	return paths;
}
