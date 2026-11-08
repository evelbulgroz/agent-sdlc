import fs from 'node:fs';
import path from 'node:path';

export interface ValidatedRun {
	slug: string;
	runDir: string;
	status: Record<string, unknown>;
}

/** Run slugs are a single safe path segment; `_example` is the template folder and never a run. */
export function isValidRunSlug(slug: unknown): slug is string {
	if (typeof slug !== 'string') return false;
	const trimmed = slug.trim();
	return /^[a-zA-Z0-9_-]+$/.test(trimmed) && !trimmed.startsWith('.') && trimmed !== '_example';
}

function nonEmpty(value: string | null | undefined): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Selector precedence: explicit argument, then AGENT_RUN_DIR, then AGENT_RUN_ID. */
export function resolveRunSelector(
	cliArg: string | null | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
	return nonEmpty(cliArg) ?? nonEmpty(env.AGENT_RUN_DIR) ?? nonEmpty(env.AGENT_RUN_ID);
}

/** Resolves a selector to a direct child of the runs directory whose status.json names the same run. */
export function resolveAndValidateRunDir(runSelector: string, rootDir: string, runsRelative: string): ValidatedRun {
	if (!runSelector || typeof runSelector !== 'string' || !runSelector.trim()) {
		throw new Error('Run selector must be a non-empty string');
	}
	const runsBaseDir = path.join(rootDir, runsRelative);
	if (!fs.existsSync(runsBaseDir)) throw new Error(`Runs directory '${runsBaseDir}' does not exist`);
	const realRunsBaseDir = fs.realpathSync(runsBaseDir);

	const prefixed = [`${runsRelative}/`, `./${runsRelative}/`].some((prefix) => runSelector.startsWith(prefix));
	let candidatePath: string;
	if (path.isAbsolute(runSelector) || prefixed || runSelector.startsWith('..')) {
		candidatePath = path.resolve(rootDir, runSelector);
	} else if (fs.existsSync(path.join(runsBaseDir, runSelector))) {
		candidatePath = path.join(runsBaseDir, runSelector);
	} else {
		candidatePath = path.resolve(rootDir, runSelector);
	}
	if (!fs.existsSync(candidatePath)) throw new Error(`Run directory '${candidatePath}' does not exist`);

	const realCandidate = fs.realpathSync(candidatePath);
	if (!fs.statSync(realCandidate).isDirectory()) throw new Error(`Run path '${candidatePath}' is not a directory`);
	if (path.dirname(realCandidate) !== realRunsBaseDir) {
		throw new Error(`Run directory '${candidatePath}' must be a direct subdirectory of '${runsBaseDir}'`);
	}
	const slug = path.basename(realCandidate);
	if (slug === '_example') {
		throw new Error(`Run directory '${slug}' is the _example template and cannot be used for active telemetry`);
	}
	if (!isValidRunSlug(slug)) throw new Error(`Run directory '${slug}' has invalid slug format`);

	const statusFile = path.join(realCandidate, 'status.json');
	if (!fs.existsSync(statusFile)) throw new Error(`Run directory '${candidatePath}' is missing status.json`);
	let statusData: unknown;
	try {
		statusData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
	} catch (error) {
		throw new Error(`Run directory '${candidatePath}' has invalid status.json: ${error instanceof Error ? error.message : String(error)}`);
	}
	const status = statusData && typeof statusData === 'object' ? statusData as Record<string, unknown> : null;
	if (!status || status.runId !== slug) {
		throw new Error(`Run directory '${candidatePath}' status.json runId '${String(status?.runId)}' does not match directory '${slug}'`);
	}
	return { slug, runDir: realCandidate, status };
}
