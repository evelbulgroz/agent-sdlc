import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { validateStatus } from '../agent-status-validate.ts';
import { SdlcError } from '../policy/errors.ts';

export const BUNDLED_RUN_TEMPLATES = path.join(import.meta.dirname, '..', 'run-templates');
const TEMPLATE_FILES = ['intent.md', 'plan.md', 'decisions.md', 'status.json'] as const;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const ORCHESTRATED_OWNER = 'orchestrator:agent-sdlc';

export interface RunInitOptions {
	rootDir: string;
	runsDir: string;
	slug: string;
	owner?: string;
	orchestrated?: boolean;
	resultFile?: string | null;
	now?: Date;
}

export interface RunInitResult {
	runId: string;
	runDir: string;
	activeOwner: string;
	headSha: string;
	branch: string;
}

function git(rootDir: string, args: string[]): string | null {
	try {
		return execFileSync('git', ['-C', rootDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return null;
	}
}

/** Host `<runsDir>/_example` wins when it carries the full template set; otherwise the bundled defaults apply. */
function templateDir(rootDir: string, runsDir: string): string {
	const hostDir = path.join(rootDir, runsDir, '_example');
	return TEMPLATE_FILES.every((file) => fs.existsSync(path.join(hostDir, file))) ? hostDir : BUNDLED_RUN_TEMPLATES;
}

export function initRun(options: RunInitOptions): RunInitResult {
	const { rootDir, runsDir, slug } = options;
	if (!SLUG_PATTERN.test(slug)) throw new SdlcError('INVALID_INPUT', `Slug must be kebab-case: ${slug}`);
	const owner = options.owner ?? (options.orchestrated ? ORCHESTRATED_OWNER : 'role:spec');
	const now = options.now ?? new Date();
	const runId = `${now.toISOString().slice(0, 10)}-${slug}`;
	const runsRoot = path.join(rootDir, runsDir);
	const dest = path.join(runsRoot, runId);
	const source = templateDir(rootDir, runsDir);

	fs.mkdirSync(runsRoot, { recursive: true });
	try {
		fs.mkdirSync(dest);
	} catch {
		throw new SdlcError('RUN_ALREADY_EXISTS', `Already exists: ${dest}`);
	}
	try {
		for (const file of ['intent.md', 'plan.md', 'decisions.md']) fs.copyFileSync(path.join(source, file), path.join(dest, file));
		const headSha = git(rootDir, ['rev-parse', 'HEAD']) ?? 'unknown';
		const branch = git(rootDir, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown';
		const dirty = (git(rootDir, ['status', '--porcelain']) ?? '') !== '';
		const status = JSON.parse(fs.readFileSync(path.join(source, 'status.json'), 'utf8')) as Record<string, unknown>;
		const verification = (status.verification ?? {}) as Record<string, unknown>;
		const preflight = (verification.preflight ?? {}) as Record<string, unknown>;
		Object.assign(status, {
			runId,
			revision: 1,
			updatedAt: now.toISOString().replace(/\.\d+Z$/, '.000Z'),
			git: { branch, headSha, worktreePath: null, dirty },
			activeOwner: owner,
			phase: 'spec',
			retry: { count: 0, maxRetries: 2, source: 'status.json' },
			verification: {
				lastCommand: null,
				lastResult: 'not_run',
				lastExitCode: null,
				lastRanAt: null,
				preflight: { status: null, changeClass: null, gitHeadSha: null, resultFile: options.resultFile ?? preflight.resultFile ?? null, finishedAt: null },
			},
		});
		const validation = validateStatus(status);
		if (!validation.ok) throw new SdlcError('INVALID_INPUT', `Initialized status.json is invalid: ${validation.errors.join('; ')}`);
		fs.writeFileSync(path.join(dest, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
		return { runId, runDir: path.relative(rootDir, dest), activeOwner: owner, headSha, branch };
	} catch (error) {
		fs.rmSync(dest, { recursive: true, force: true });
		throw error;
	}
}
