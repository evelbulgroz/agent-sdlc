// Shared builders for the task-planner specs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateTaskReadiness } from '../policy/task-planner/task-readiness.ts';

export const BASE_COMMIT_SHA = 'a'.repeat(40);
export const RUN_ID = '2026-09-07-test-planner-run';

export function readinessDraft(overrides = {}) {
	return {
		goal: 'Deliver bounded behavior',
		touchedSurfaces: ['tools/agent-sdlc/policy/task-planner.mjs'],
		acceptanceCriteria: [
			'AC-01: Bounded behavior is planned. Given a complete host specification. Then readiness is deterministic.',
		],
		...overrides,
	};
}

export function serialManifest(overrides = {}) {
	return {
		schemaVersion: '1.0.0',
		slices: [
			{
				sliceId: 'behavior',
				kind: 'vertical',
				goal: 'Deliver behavior',
				acceptanceCriteria: ['AC-01'],
				dependsOn: [],
			},
		],
		tasks: [
			{
				taskId: 'behavior-foundation',
				sliceId: 'behavior',
				targetPackage: 'apps/services/conditioning',
				authoredPaths: ['apps/services/conditioning/src/conditioning/domain'],
				pathPrefixes: ['apps/services/conditioning/src/conditioning/domain'],
				generatedOutputs: [],
				dependsOn: [],
				deliveryLayers: ['domain'],
				dependencyMutations: [],
				shadowPaths: {
					unhappy: 'rejected mutation',
					timeout: 'deadline exceeded',
					empty: 'no delta',
					boundary: 'scope escape',
				},
				verificationCommand: [
					'pnpm',
					'--filter',
					'@example/conditioning-service',
					'test',
				],
				generatorCommand: null,
			},
			{
				taskId: 'behavior-activation',
				sliceId: 'behavior',
				targetPackage: 'apps/services/conditioning',
				authoredPaths: ['apps/services/conditioning/src/conditioning/domain'],
				pathPrefixes: ['apps/services/conditioning/src/conditioning/domain'],
				generatedOutputs: [],
				dependsOn: ['behavior-foundation'],
				deliveryLayers: ['domain'],
				dependencyMutations: [],
				shadowPaths: {
					unhappy: 'rejected mutation',
					timeout: 'deadline exceeded',
					empty: 'no delta',
					boundary: 'scope escape',
				},
				verificationCommand: [
					'pnpm',
					'--filter',
					'@example/conditioning-service',
					'test',
				],
				generatorCommand: null,
			},
		],
		...overrides,
	};
}

export const DEMO_DRIFT_SCRIPT =
	'bash ../../../tools/check-contract-drift.sh apps/services/demo openapi/demo.openapi.json contracts/generated-api.ts';

export const DEMO_CONTRACT_SCRIPTS = {
	test: 'node --test',
	'build:contracts': 'node build.mjs',
	'check:contract-drift': DEMO_DRIFT_SCRIPT,
};

export function demoPackages(scripts) {
	return {
		packageMap: new Map([
			[
				'@example/demo-service',
				{
					packagePath: 'apps/services/demo',
					pkgJson: {
						name: '@example/demo-service',
						scripts,
					},
				},
			],
		]),
		pathToPackage: new Map([['apps/services/demo', '@example/demo-service']]),
	};
}

export function demoTask(overrides = {}) {
	return {
		taskId: 'sink-task',
		sliceId: 'behavior',
		targetPackage: 'apps/services/demo',
		authoredPaths: ['apps/services/demo/src'],
		pathPrefixes: ['apps/services/demo/src'],
		generatedOutputs: [],
		dependsOn: [],
		deliveryLayers: ['contracts'],
		dependencyMutations: [],
		shadowPaths: {
			unhappy: 'rejected mutation',
			timeout: 'deadline exceeded',
			empty: 'no delta',
			boundary: 'scope escape',
		},
		verificationCommand: ['pnpm', '--filter', '@example/demo-service', 'test'],
		generatorCommand: null,
		...overrides,
	};
}

export function demoManifest(tasks) {
	return {
		schemaVersion: '1.0.0',
		slices: [
			{
				sliceId: 'behavior',
				kind: 'vertical',
				goal: 'Deliver behavior',
				acceptanceCriteria: ['AC-01'],
				dependsOn: [],
			},
		],
		tasks,
	};
}

export function writeDemoControllers(rootDir) {
	const src = path.join(rootDir, 'apps/services/demo/src');
	fs.mkdirSync(src, { recursive: true });
	fs.writeFileSync(path.join(src, 'a.controller.ts'), 'export class A {}\n');
	fs.writeFileSync(path.join(src, 'b.controller.ts'), 'export class B {}\n');
	fs.writeFileSync(path.join(src, 'a.controller.spec.ts'), 'test\n');
	fs.writeFileSync(path.join(src, 'notes.md'), 'not a controller\n');
}

export function withDemoRoot(run) {
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-plan-'));
	try {
		writeDemoControllers(rootDir);
		return run(rootDir);
	} finally {
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
}

export function evaluateDemo({ criteria, scripts = DEMO_CONTRACT_SCRIPTS, tasks, rootDir, criterionIds = ['AC-01'] }) {
	return evaluateTaskReadiness({
		draft: {
			goal: 'Keep the public contract',
			touchedSurfaces: ['apps/services/demo'],
			acceptanceCriteria: criteria,
		},
		taskManifest: {
			...demoManifest(tasks),
			slices: [
				{
					...demoManifest(tasks).slices[0],
					acceptanceCriteria: criterionIds,
				},
			],
		},
		rootDir,
		workspacePackages: demoPackages(scripts),
	});
}

export function emptyWorkspacePackages() {
	return { packageMap: new Map(), pathToPackage: new Map() };
}

export function pinnedClock() {
	return '2026-09-07T09:00:00.000Z';
}

function toolsTask(overrides = {}) {
	return {
		taskId: 'behavior-task',
		sliceId: 'behavior',
		targetPackage: 'tools',
		authoredPaths: ['tools/agent-sdlc/policy/task-planner.mjs'],
		pathPrefixes: ['tools/agent-sdlc/policy'],
		generatedOutputs: [],
		dependsOn: [],
		deliveryLayers: ['tooling'],
		dependencyMutations: [],
		shadowPaths: {
			unhappy: 'rejected mutation',
			timeout: 'deadline exceeded',
			empty: 'no delta',
			boundary: 'scope escape',
		},
		verificationCommand: ['pnpm', 'run', 'agent:test-sdlc'],
		generatorCommand: null,
		...overrides,
	};
}

export function pinnedToolsManifest(tasks = [toolsTask()]) {
	return {
		schemaVersion: '1.0.0',
		slices: [
			{
				sliceId: 'behavior',
				kind: 'vertical',
				goal: 'Deliver behavior',
				acceptanceCriteria: ['AC-01'],
				dependsOn: [],
			},
		],
		tasks,
	};
}

export function pinnedAuthorization(overrides = {}) {
	return {
		runId: RUN_ID,
		baseCommitSha: BASE_COMMIT_SHA,
		allowedPackages: ['tools'],
		allowedPathPrefixes: ['tools/agent-sdlc'],
		...overrides,
	};
}

export function pinnedManifestPlanInput() {
	return {
		draft: readinessDraft(),
		taskManifest: pinnedToolsManifest(),
		authorization: pinnedAuthorization({ taskManifestHash: 'c'.repeat(64) }),
		workspacePackages: emptyWorkspacePackages(),
		now: () => pinnedClock(),
	};
}

export function pinnedSinglePlanInput() {
	return {
		draft: readinessDraft(),
		authorization: pinnedAuthorization(),
		workspacePackages: emptyWorkspacePackages(),
		now: () => pinnedClock(),
	};
}

export function pinnedMultiPlanInput() {
	const assessment = {
		packagePath: 'apps/services/assessment',
		pkgJson: {
			name: '@example/assessment-service',
			scripts: { test: 'node --test' },
		},
	};
	const conditioning = {
		packagePath: 'apps/services/conditioning',
		pkgJson: {
			name: '@example/conditioning-service',
			scripts: { test: 'node --test' },
			dependencies: {},
		},
	};
	return {
		draft: { title: 'Refactor independent services' },
		authorization: {
			runId: RUN_ID,
			baseCommitSha: BASE_COMMIT_SHA,
			allowedPackages: ['apps/services/assessment', 'apps/services/conditioning'],
			allowedPathPrefixes: [
				'apps/services/assessment/src/',
				'apps/services/conditioning/src/',
			],
		},
		workspacePackages: {
			packageMap: new Map([
				[assessment.pkgJson.name, assessment],
				[conditioning.pkgJson.name, conditioning],
			]),
			pathToPackage: new Map([
				[assessment.packagePath, assessment.pkgJson.name],
				[conditioning.packagePath, conditioning.pkgJson.name],
			]),
		},
		now: () => pinnedClock(),
	};
}

export function pinnedManifestlessReadinessInput() {
	return {
		draft: readinessDraft(),
		workspacePackages: emptyWorkspacePackages(),
		rootDir: '/tmp/agent-sdlc-readiness-pin',
	};
}

export function pinnedManifestReadinessInput() {
	return {
		draft: readinessDraft(),
		taskManifest: pinnedToolsManifest(),
		workspacePackages: emptyWorkspacePackages(),
		rootDir: '/tmp/agent-sdlc-readiness-pin',
	};
}

export function nineAuthoredPathReadinessInput() {
	return {
		draft: readinessDraft({ touchedSurfaces: ['tools/agent-sdlc'] }),
		taskManifest: pinnedToolsManifest([
			toolsTask({
				authoredPaths: Array.from(
					{ length: 9 },
					(_, index) => `tools/agent-sdlc/file-${index}.mjs`,
				),
				pathPrefixes: ['tools/agent-sdlc'],
			}),
		]),
		workspacePackages: emptyWorkspacePackages(),
		rootDir: '/tmp/agent-sdlc-readiness-pin',
	};
}
