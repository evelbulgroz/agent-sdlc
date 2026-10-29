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
				targetPackage: 'services/billing',
				authoredPaths: ['services/billing/src/billing/domain'],
				pathPrefixes: ['services/billing/src/billing/domain'],
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
					'@fixture/billing-service',
					'test',
				],
				generatorCommand: null,
			},
			{
				taskId: 'behavior-activation',
				sliceId: 'behavior',
				targetPackage: 'services/billing',
				authoredPaths: ['services/billing/src/billing/domain'],
				pathPrefixes: ['services/billing/src/billing/domain'],
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
					'@fixture/billing-service',
					'test',
				],
				generatorCommand: null,
			},
		],
		...overrides,
	};
}

export const DEMO_DRIFT_SCRIPT =
	'bash ../../../tools/check-contract-drift.sh services/demo openapi/demo.openapi.json contracts/generated-api.ts';

export const DEMO_CONTRACT_SCRIPTS = {
	test: 'node --test',
	'build:contracts': 'node build.mjs',
	'check:contract-drift': DEMO_DRIFT_SCRIPT,
};

export function demoPackages(scripts) {
	return {
		packageMap: new Map([
			[
				'@fixture/demo-service',
				{
					packagePath: 'services/demo',
					pkgJson: {
						name: '@fixture/demo-service',
						scripts,
					},
				},
			],
		]),
		pathToPackage: new Map([['services/demo', '@fixture/demo-service']]),
	};
}

export function demoTask(overrides = {}) {
	return {
		taskId: 'sink-task',
		sliceId: 'behavior',
		targetPackage: 'services/demo',
		authoredPaths: ['services/demo/src'],
		pathPrefixes: ['services/demo/src'],
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
		verificationCommand: ['pnpm', '--filter', '@fixture/demo-service', 'test'],
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
	const src = path.join(rootDir, 'services/demo/src');
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
			touchedSurfaces: ['services/demo'],
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
		verificationCommand: ['pnpm', 'run', 'test:unit'],
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
		packagePath: 'services/assessment',
		pkgJson: {
			name: '@fixture/assessment-service',
			scripts: { test: 'node --test' },
		},
	};
	const billing = {
		packagePath: 'services/billing',
		pkgJson: {
			name: '@fixture/billing-service',
			scripts: { test: 'node --test' },
			dependencies: {},
		},
	};
	return {
		draft: { title: 'Refactor independent services' },
		authorization: {
			runId: RUN_ID,
			baseCommitSha: BASE_COMMIT_SHA,
			allowedPackages: ['services/assessment', 'services/billing'],
			allowedPathPrefixes: [
				'services/assessment/src/',
				'services/billing/src/',
			],
		},
		workspacePackages: {
			packageMap: new Map([
				[assessment.pkgJson.name, assessment],
				[billing.pkgJson.name, billing],
			]),
			pathToPackage: new Map([
				[assessment.packagePath, assessment.pkgJson.name],
				[billing.packagePath, billing.pkgJson.name],
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
