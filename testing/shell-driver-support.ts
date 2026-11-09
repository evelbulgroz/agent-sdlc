import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../cli/cli.ts';

interface GoalFileOptions {
	owningContext?: string;
	acceptanceCriteria?: string[];
}

export function makeTempDir(label: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `shell-driver-${label}-`));
}

export function writeGoalFile(dir: string, { owningContext = 'tools/agent-sdlc', acceptanceCriteria }: GoalFileOptions = {}): string {
	const acBlock = (
		acceptanceCriteria ?? [
			'AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.',
		]
	)
		.map((item, index) => `${index + 1}. ${item}`)
		.join('\n');
	const text = [
		'# Intent',
		'',
		'## Goal',
		'',
		'Ship the slice',
		'',
		'## Non-goals',
		'',
		'- No deploy',
		'',
		'## Owning context',
		'',
		owningContext,
		'',
		'## Touched surfaces',
		'',
		'- tools/agent-sdlc/cli/cli.mjs',
		'',
		'## Invariants and constraints',
		'',
		'- Fail closed',
		'',
		'## Public contract impact',
		'',
		'None. CLI only.',
		'',
		'## Acceptance criteria',
		'',
		acBlock,
		'',
		'## Failure defenses',
		'',
		'- Reject empty input',
		'',
		'## Verification plan',
		'',
		'- Run tests',
		'',
		'## Unresolved questions',
		'',
		'_None_',
		'',
		'## Assumptions',
		'',
		'_None_',
		'',
	].join('\n');
	const goalFile = path.join(dir, 'goal.md');
	fs.writeFileSync(goalFile, text);
	return goalFile;
}

export const SILENT_STREAMS = {
	stdin: { isTTY: false },
	stdout: { write() {} },
	stderr: { write() {} },
};

/** A governor stub that fails the test immediately if contacted. */
export function throwingGovernor() {
	return new Proxy(
		{},
		{
			get() {
				throw new Error('shell driver must not contact the model governor via check-spec');
			},
		},
	);
}

/**
 * Wraps the real `runCli` while recording every top-level command dispatched
 * through it, so tests can assert exactly which engine commands a driver
 * call produced (and, just as importantly, which ones it never produced).
 */
export function spyOnRunCli(realRunCliFn: typeof runCli = runCli) {
	const calls: Array<string | undefined> = [];
	async function spy(args: readonly string[], options?: Parameters<typeof runCli>[1]) {
		calls.push(args[0]);
		return realRunCliFn(args, options);
	}
	spy.calls = calls;
	return spy;
}

export function syntheticHostProfile(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: '1.3.0',
		profileId: 'default-host',
		repositoryId: 'fixture-repo',
		adapter: 'default',
		stateDir: 'tools/.agent-sdlc',
		reviewDir: 'tools/.review',
		specDraftDir: 'docs/specs/drafts',
		verify: {
			argv: ['pnpm', 'run', 'agent:verify', '--', '--base', '{baseSha}'],
			resultPath: 'tools/.agent-preflight-last.json',
		},
		hydration: {
			installArgv: ['pnpm', 'install', '--frozen-lockfile'],
			untrackedCopies: [],
			conditionalBuilds: [],
			packageArtifactCopies: [],
		},
		workspace: {
			packageRoots: ['packages'],
			allowedPathRoots: ['packages', 'tools', 'docs'],
		},
		prompts: {
			preset: 'default',
			pathScopedRules: [],
		},
		learnings: {
			filePath: '.agents/project-learnings.jsonl',
			scopes: ['repo-wide'],
			scopeInference: [],
		},
		...overrides,
	};
}

export function writeSyntheticHostProfile(rootDir: string, overrides: Record<string, unknown> = {}) {
	const profile = syntheticHostProfile(overrides);
	const profilePath = path.join(rootDir, '.agents/sdlc-host.json');
	fs.mkdirSync(path.dirname(profilePath), { recursive: true });
	fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, '\t')}\n`);
	return profile;
}

