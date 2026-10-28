import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../cli/cli.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { SdlcError } from '../policy/errors.ts';
import { removeTestRunArtifacts, trackTestRun } from './test-support.mjs';

export function slug(label) {
	return `sdlc-test-${label}-${trackTestRun(crypto.randomUUID().slice(0, 8))}`;
}


export function cleanupRun(runId) {
	removeTestRunArtifacts(runId);
}


export async function checkpointState(runtime, state) {
	const tuple = await runtime.checkpointer.getTuple(runtime.configFor(state));
	await runtime.checkpointer.put(
		tuple?.config ?? runtime.configFor(state),
		{
			...(tuple?.checkpoint ?? {
				v: 1,
				ts: new Date().toISOString(),
				channel_versions: {},
				versions_seen: {},
				pending_sends: [],
			}),
			id: `zz-${crypto.randomUUID()}`,
			channel_values: {
				...(tuple?.checkpoint?.channel_values ?? {}),
				snapshot: state,
			},
		},
		tuple?.metadata ?? {},
	);
}


export function writeResponse(runId, name, value) {
	const filename = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, `${name}.json`);
	fs.writeFileSync(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	return filename;
}


export function throwingGovernor() {
	return {
		assertAvailable() {
			throw new SdlcError('GOVERNOR_UNAVAILABLE', 'must not contact governor');
		},
		async execute() {
			throw new SdlcError('GOVERNOR_UNAVAILABLE', 'must not contact governor');
		},
	};
}


export function runInventory(rootDir = REPOSITORY_ROOT) {
	const list = (rel) => {
		const dir = path.join(rootDir, rel);
		if (!fs.existsSync(dir)) return [];
		return fs.readdirSync(dir).sort();
	};
	return { runs: list('docs/specs/runs'), runtime: list('tools/.agent-sdlc') };
}


export function completeSpecMarkdown({
	nonGoals = ['No deploy'],
	acceptanceCriteria = [
		'AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.',
	],
} = {}) {
	const nonGoalBlock =
		nonGoals.length > 0 ? nonGoals.map((item) => `- ${item}`).join('\n') : '';
	const acBlock = acceptanceCriteria
		.map((item, index) => `${index + 1}. ${item}`)
		.join('\n');
	return [
		'# Intent',
		'',
		'## Goal',
		'',
		'Ship the slice',
		'',
		'## Non-goals',
		'',
		nonGoalBlock,
		'',
		'## Owning context',
		'',
		'tools/agent-sdlc',
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
}


export function completeSpecJson(overrides = {}) {
	return {
		goal: 'Ship the slice',
		nonGoals: ['No deploy'],
		owningContext: 'tools/agent-sdlc',
		touchedSurfaces: ['tools/agent-sdlc/cli/cli.mjs'],
		invariantsAndConstraints: ['Fail closed'],
		publicContractImpact: 'None. CLI only.',
		acceptanceCriteria: [
			'AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.',
		],
		failureDefenses: ['Reject empty input'],
		verificationPlan: ['Run tests'],
		unresolvedQuestions: [],
		assumptions: [],
		...overrides,
	};
}


export async function runCheckSpec(args) {
	const before = runInventory();
	const outcome = await runCli(['check-spec', ...args], {
		rootDir: REPOSITORY_ROOT,
		governor: throwingGovernor(),
	});
	assert.deepEqual(runInventory(), before);
	return outcome;
}


export function seedSkillsRun(tempRoot, runId, findings) {
	const runDir = path.join(tempRoot, 'tools/.agent-sdlc', runId);
	fs.mkdirSync(runDir, { recursive: true });
	const store = new RuntimeStore(path.join(runDir, 'runtime.sqlite'));
	store.database
		.prepare(
			`INSERT INTO runs (run_id, thread_id, runtime_revision, state, state_hash, state_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			runId,
			`thread-${runId}`,
			1,
			'DONE',
			'hash',
			'{}',
			new Date().toISOString(),
			new Date().toISOString(),
		);
	for (const f of findings) {
		store.insertPromptFrictionFinding({
			findingId: f.findingId ?? `f-${crypto.randomUUID()}`,
			runId,
			roleId: f.roleId ?? 'implementer',
			signalType: f.signalType ?? 'tool_failure',
			category: f.category ?? 'test-runner-lookup',
			findingKey: f.findingKey ?? '[implementer] tool_failure:test-runner-lookup',
			status: f.status ?? 'RECOMMENDED',
			attributionLayer: f.attributionLayer ?? 'layer3',
			evidence: f.evidence ?? {},
			proposedDiff: f.proposedDiff ?? null,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
	}
	store.close();
}


export function readyGoalFile(dir) {
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
		'tools/agent-sdlc',
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
		'1. AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.',
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


export async function readStoredExecutor(runId) {
	const store = new RuntimeStore(path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId, 'runtime.sqlite'));
	try {
		return store.getRun(runId);
	} finally {
		store.close();
	}
}


export function syntheticHostProfile(overrides = {}) {
	return {
		schemaVersion: '1.3.0',
		profileId: 'default-host',
		repositoryId: 'fixture-repo',
		adapter: 'default',
		stateDir: 'tools/.agent-sdlc',
		reviewDir: 'tools/.review',
		specDraftDir: 'docs/specs/drafts',
		verify: {
			argv: ['pnpm', 'run', 'agent:preflight', '--', '--base', '{baseSha}'],
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


export function writeSyntheticHostProfile(rootDir, overrides = {}) {
	const profile = syntheticHostProfile(overrides);
	const profilePath = path.join(rootDir, '.agents/sdlc-host.json');
	fs.mkdirSync(path.dirname(profilePath), { recursive: true });
	fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, '\t')}\n`);
	return profile;
}

