import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ArtifactStore } from '../persistence/artifacts.ts';
import { SdlcWorkflowRuntime } from '../workflow/graph.ts';
import { RoleRegistry } from '../roles/role-registry.ts';
import { RuntimeStore } from '../persistence/runtime-store.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { FakeModelGovernor } from './fake-model-governor.mjs';

// hydration paths resolve against the root, critic reports go to
// tools/.review, and ledgers to tools/.model-usage.
function testRunLocations(runId) {
	return [
		path.join(REPOSITORY_ROOT, 'docs/specs/runs', runId),
		path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId),
		path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', runId),
		path.join(REPOSITORY_ROOT, 'tools/.review', runId),
		path.join(REPOSITORY_ROOT, 'tools/.model-usage/runs', `${runId}.json`),
		path.join(REPOSITORY_ROOT, 'tools/.model-usage/archive', `${runId}.json`),
	];
}

export function removeTestRunArtifacts(runId) {
	for (const location of testRunLocations(runId)) {
		fs.rmSync(location, { recursive: true, force: true });
	}
}

const trackedTestRunTokens = new Set();

/**
 * Registers a test run id, or the random slug a CLI run id ends with, so the
 * process fails at exit if anything keyed by it is left behind.
 */
export function trackTestRun(token) {
	trackedTestRunTokens.add(token);
	return token;
}

export function findLeakedTestRunArtifacts(tokens = trackedTestRunTokens) {
	const leaked = [];
	if (tokens.size === 0) return leaked;
	const roots = [
		'docs/specs/runs',
		'tools/.agent-sdlc',
		'tools/.agent-sdlc/test-fixtures',
		'tools/.review',
		'tools/.model-usage/runs',
		'tools/.model-usage/archive',
	];
	for (const root of roots) {
		const directory = path.join(REPOSITORY_ROOT, root);
		if (!fs.existsSync(directory)) continue;
		for (const name of fs.readdirSync(directory)) {
			const base = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
			for (const token of tokens) {
				if (base === token || base.endsWith(`-${token}`)) leaked.push(path.join(root, name));
			}
		}
	}
	return leaked;
}

process.once('exit', () => {
	const leaked = findLeakedTestRunArtifacts();
	if (leaked.length === 0) return;
	process.stderr.write(
		`agent-sdlc tests left run artifacts under the repository root:\n${leaked.map((entry) => `  ${entry}`).join('\n')}\n`,
	);
	process.exitCode = 1;
});

export function makeFixture(label, script = []) {
	const id = crypto.randomUUID().slice(0, 8);
	const safeLabel = label
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-|-$/g, '');
	const runId = trackTestRun(`${new Date().toISOString().slice(0, 10)}-${safeLabel}-${id}`);
	const runtimeDir = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc/test-fixtures', runId);
	fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	const store = new RuntimeStore(path.join(runtimeDir, 'runtime.sqlite'));
	const registry = new RoleRegistry({ rootDir: REPOSITORY_ROOT });
	const loaded = registry.load();
	const artifacts = new ArtifactStore({
		artifactsDir: path.join(runtimeDir, 'artifacts'),
		runtimeStore: store,
		maxArtifactBytes: loaded.workflow.limits.maxArtifactBytes,
	});
	const governor = new FakeModelGovernor(script);
	const runtime = new SdlcWorkflowRuntime({
		runtimeStore: store,
		artifactStore: artifacts,
		registry,
		governor,
	});
	return {
		runId,
		runtimeDir,
		store,
		registry,
		artifacts,
		governor,
		runtime,
		close() {
			try {
				store.close();
			} finally {
				removeTestRunArtifacts(runId);
			}
		},
	};
}

export function completeProposal(overrides = {}) {
	return {
		patch: [
			{ field: 'nonGoals', operation: 'set', value: ['Do not mutate code'] },
			{
				field: 'owningContext',
				operation: 'set',
				value: overrides.owningContext ?? 'Monorepo Tooling',
			},
			{
				field: 'touchedSurfaces',
				operation: 'set',
				value: overrides.touchedSurfaces ?? ['tools/example.mjs'],
			},
			{
				field: 'invariantsAndConstraints',
				operation: 'set',
				value: ['All model calls use the governor'],
			},
			{
				field: 'publicContractImpact',
				operation: 'set',
				value: 'No public API change',
			},
		],
		questions: [
			{
				questionId: 'acceptance',
				targets: ['acceptanceCriteria'],
				prompt: 'What observable outcome proves success?',
				responseKind: 'text',
				options: [],
				required: true,
				rationale: 'Acceptance criteria are missing.',
			},
			{
				questionId: 'failure',
				targets: ['failureDefenses'],
				prompt: 'What failure must fail closed?',
				responseKind: 'text',
				options: [],
				required: true,
				rationale: 'Failure defenses are missing.',
			},
			{
				questionId: 'verification',
				targets: ['verificationPlan'],
				prompt: 'How will the outcome be verified?',
				responseKind: 'text',
				options: [],
				required: true,
				rationale: 'Verification is missing.',
			},
		],
	};
}

export const EXAMPLE_ACCEPTANCE_CRITERION =
	'AC-01: An exact spec is approved. Given a complete grammatical draft and operator approval. Then approvedSpecHash equals the draft hash.';

export function grammaticalAcceptance(outcome) {
	const text = String(outcome).trim().replace(/\.+$/, '');
	return `AC-01: ${text}. Given the specification interview is complete. Then the operator may approve the draft.`;
}

export const CITING_SPEC_PATH = 'services/billing/src/feature.spec.ts';

export function citingSpecSource(acId = 'AC-01') {
	return `it('holds the approved outcome @ac ${acId}', () => {\n  expect(true).toBe(true);\n});\n`;
}

export function leanWriteAction(filePath, content) {
	return {
		action: {
			kind: 'tool_call',
			toolName: 'write_file',
			parameters: {
				path: filePath,
				content,
			},
		},
	};
}

export function leanReplaceAction(filePath, oldString, newString, expectedFileHash = '0'.repeat(64)) {
	return {
		action: {
			kind: 'tool_call',
			toolName: 'replace_in_file',
			parameters: {
				path: filePath,
				old_string: oldString,
				new_string: newString,
				expected_file_hash: expectedFileHash,
			},
		},
	};
}

export function programmerWriteAction(filePath, content, verificationCommand = null) {
	return {
		action: {
			kind: 'programmer_turn',
			edits: [
				{
					toolName: 'write_file',
					path: filePath,
					old_string: null,
					new_string: null,
					content,
				},
			],
			verificationCommand,
		},
	};
}

export function programmerReplaceAction(filePath, oldString, newString, verificationCommand = null) {
	return {
		action: {
			kind: 'programmer_turn',
			edits: [
				{
					toolName: 'replace_in_file',
					path: filePath,
					old_string: oldString,
					new_string: newString,
					content: null,
				},
			],
			verificationCommand,
		},
	};
}

export function programmerGatherAction(toolName, gatherPath, query = null) {
	return {
		action: {
			kind: 'programmer_turn',
			edits: [],
			verificationCommand: null,
			gather: {
				toolName,
				path: gatherPath,
				query,
			},
		},
	};
}

export function citingSpecWriteAction(specPath = CITING_SPEC_PATH, acId = 'AC-01') {
	return leanWriteAction(specPath, citingSpecSource(acId));
}

const CITING_SPEC_FILE = /\.(spec|test|e2e-spec)\.[cm]?[jt]sx?$/;

// A package test is green only after some spec in the worktree cites an
// acceptance criterion. The programmer role finishes on that green command,
// so a feature-only write must keep the role open.
export function worktreeCitesAcceptanceCriterion(cwd) {
	if (!cwd || !fs.existsSync(cwd)) return false;
	const stack = [cwd];
	while (stack.length > 0) {
		const current = stack.pop();
		let entries = [];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.name === 'node_modules' || entry.name === '.git') continue;
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (!CITING_SPEC_FILE.test(entry.name)) continue;
			try {
				if (/@ac\s+AC-/.test(fs.readFileSync(full, 'utf8'))) return true;
			} catch {
				// An unreadable file is not a citation.
			}
		}
	}
	return false;
}

export function uncitedPackageTestError(cmd, args = [], opts = {}) {
	if (cmd !== 'pnpm' || !args.includes('test')) return null;
	if (worktreeCitesAcceptanceCriterion(opts.cwd)) return null;
	const error = new Error('Command failed: pnpm test');
	error.status = 1;
	error.stdout = '';
	error.stderr = 'Missing @ac AC-01';
	return error;
}

export function seedCitingSpecs(worktreeDir, acId = 'AC-01') {
	if (!worktreeDir) return;
	const paths = [
		CITING_SPEC_PATH,
		'services/billing/src/feat1.spec.ts',
		'services/assessment/src/feat2.spec.ts',
		'services/authentication/src/feat2.spec.ts',
		'packages/shared-base/src/feature.spec.ts',
	];
	for (const relative of paths) {
		const absolute = path.join(worktreeDir, relative);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, citingSpecSource(acId));
	}
}

export function seedWorkspacePackageManifest(
	worktreeDir,
	packagePath = 'services/billing',
) {
	const source = path.join(REPOSITORY_ROOT, packagePath, 'package.json');
	const destination = path.join(worktreeDir, packagePath, 'package.json');
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	if (fs.existsSync(source)) {
		fs.copyFileSync(source, destination);
	} else {
		const pkgName = packagePath.startsWith('services/')
			? `@fixture/${path.basename(packagePath)}-service`
			: `@fixture/${path.basename(packagePath)}`;
		fs.writeFileSync(
			destination,
			JSON.stringify(
				{
					name: pkgName,
					version: '1.0.0',
					type: 'module',
					scripts: { test: 'pnpm test' },
					dependencies: { '@fixture/shared-base': 'workspace:*' },
				},
				null,
				2,
			) + '\n',
		);
	}
	for (const relFile of [
		'services/billing/src/main.ts',
		'packages/shared-base/src/index.ts',
	]) {
		const fullFile = path.join(worktreeDir, relFile);
		if (!fs.existsSync(fullFile)) {
			fs.mkdirSync(path.dirname(fullFile), { recursive: true });
			fs.writeFileSync(fullFile, 'export const ready = true;\n');
		}
	}
}
