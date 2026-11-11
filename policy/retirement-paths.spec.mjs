import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkSpecRun } from '../cli/commands/maintenance.ts';
import { hashTaskPlanProjection } from './contracts.ts';
import { evaluatePolicyGate } from './policy-gate.ts';
import { expandRetirementPaths } from './retirement-paths.ts';
import { staticImportScanCount } from './static-import-graph.ts';
import { planTaskDag } from './task-planner.ts';

const SHA = 'a'.repeat(40);

function tempTree(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retirement-paths-'));
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
	}
	return root;
}

function task(overrides = {}) {
	return {
		taskId: 'retire-route',
		targetPackage: 'pkg/billing',
		pathPrefixes: ['pkg/billing/src/retire.ts'],
		authoredPaths: ['pkg/billing/src/retire.ts'],
		integrationOrder: 0,
		dependsOn: [],
		retirement: true,
		...overrides,
	};
}

function shadowPaths() {
	return {
		unhappy: 'rejected mutation',
		timeout: 'deadline exceeded',
		empty: 'no delta',
		boundary: 'scope escape',
	};
}

function workspaceFor(packagePath) {
	return {
		packageMap: new Map([
			['@fixture/billing', {
				packagePath,
				pkgJson: { name: '@fixture/billing', scripts: { test: 'node --test' } },
			}],
		]),
		pathToPackage: new Map([[packagePath, '@fixture/billing']]),
	};
}

function manifestFor(retirement) {
	const taskBody = {
		taskId: 'retire-route',
		sliceId: 'behavior',
		targetPackage: 'pkg/billing',
		authoredPaths: ['pkg/billing/src/retire.ts'],
		pathPrefixes: ['pkg/billing/src/retire.ts'],
		generatedOutputs: [],
		dependsOn: [],
		deliveryLayers: ['application'],
		dependencyMutations: [],
		shadowPaths: shadowPaths(),
		verificationCommand: ['pnpm', '--filter', '@fixture/billing', 'test'],
		generatorCommand: null,
	};
	if (retirement !== undefined) taskBody.retirement = retirement;
	return {
		schemaVersion: '1.0.0',
		slices: [{
			sliceId: 'behavior',
			kind: 'vertical',
			goal: 'Retire one route',
			acceptanceCriteria: ['AC-01'],
			dependsOn: [],
		}],
		tasks: [taskBody],
	};
}

function planRetired(root, retirement) {
	return planTaskDag({
		draft: {
			goal: 'Retire one route',
			touchedSurfaces: ['pkg/billing'],
			acceptanceCriteria: [
				'AC-01: The sibling joins the retirement task. Given one importer. Then the path is expanded.',
			],
		},
		taskManifest: manifestFor(retirement),
		authorization: {
			runId: '2026-11-11-retirement-plan',
			baseCommitSha: SHA,
			taskManifestHash: 'c'.repeat(64),
			allowedPackages: ['pkg/billing'],
			allowedPathPrefixes: ['pkg/billing'],
		},
		rootDir: root,
		workspacePackages: workspaceFor('pkg/billing'),
		now: () => '2026-11-11T12:00:00.000Z',
	});
}

test('@ac AC-01 @case AC-01.1 a single retirement importer receives the sibling before the plan hash', () => {
	const root = tempTree({
		'pkg/billing/src/retire.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const expanded = planRetired(root, true);
		const omitted = planRetired(root, undefined);
		const owner = expanded.tasks[0];
		assert.equal(owner.authoredPaths.includes('pkg/billing/src/orphan.ts'), true);
		assert.equal(owner.pathPrefixes.includes('pkg/billing/src/orphan.ts'), true);
		assert.equal(omitted.tasks[0].authoredPaths.includes('pkg/billing/src/orphan.ts'), false);
		assert.notEqual(expanded.planPolicyHash, omitted.planPolicyHash);
		assert.equal(hashTaskPlanProjection(expanded), expanded.planPolicyHash);
		assert.equal(planRetired(root, true).planPolicyHash, expanded.planPolicyHash);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.2 a sibling that is already listed stays once', () => {
	const root = tempTree({
		'pkg/billing/src/retire.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const result = expandRetirementPaths({
			tasks: [task({
				pathPrefixes: ['pkg/billing/src/retire.ts', 'pkg/billing/src/orphan.ts'],
				authoredPaths: ['pkg/billing/src/retire.ts', 'pkg/billing/src/orphan.ts'],
			})],
			rootDir: root,
			allowedPathPrefixes: ['pkg/billing'],
		});
		assert.deepEqual(result.tasks[0].pathPrefixes, [
			'pkg/billing/src/retire.ts',
			'pkg/billing/src/orphan.ts',
		]);
		assert.equal(result.blockers.length, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.3 an importer outside the retirement union keeps the sibling out', () => {
	const root = tempTree({
		'pkg/billing/src/retire.ts': 'export const retired = 1;\n',
		'pkg/billing/src/feature.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const result = expandRetirementPaths({
			tasks: [
				task(),
				task({
					taskId: 'feature-route',
					retirement: false,
					pathPrefixes: ['pkg/billing/src/feature.ts'],
					authoredPaths: ['pkg/billing/src/feature.ts'],
					integrationOrder: 1,
				}),
			],
			rootDir: root,
			allowedPathPrefixes: ['pkg/billing'],
		});
		assert.equal(result.tasks[0].pathPrefixes.includes('pkg/billing/src/orphan.ts'), false);
		assert.equal(result.tasks[1].pathPrefixes.includes('pkg/billing/src/orphan.ts'), false);
		assert.equal(result.blockers.length, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.4 a spec importer counts as a reference', () => {
	const root = tempTree({
		'pkg/billing/src/retire.spec.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const result = expandRetirementPaths({
			tasks: [task({
				pathPrefixes: ['pkg/billing/src/retire.spec.ts'],
				authoredPaths: ['pkg/billing/src/retire.spec.ts'],
			})],
			rootDir: root,
			allowedPathPrefixes: ['pkg/billing'],
		});
		assert.equal(result.tasks[0].authoredPaths.includes('pkg/billing/src/orphan.ts'), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-01 @case AC-01.5 the task with more importers wins and a tie uses integrationOrder', () => {
	const majorityRoot = tempTree({
		'pkg/billing/src/early.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/late-a.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/late-b.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/orphan.ts': 'export const orphan = 1;\n',
	});
	const tieRoot = tempTree({
		'pkg/billing/src/early.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/late-a.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const majority = expandRetirementPaths({
			tasks: [
				task({
					taskId: 'early-task',
					integrationOrder: 0,
					pathPrefixes: ['pkg/billing/src/early.ts'],
					authoredPaths: ['pkg/billing/src/early.ts'],
				}),
				task({
					taskId: 'late-task',
					integrationOrder: 1,
					pathPrefixes: ['pkg/billing/src/late-a.ts', 'pkg/billing/src/late-b.ts'],
					authoredPaths: ['pkg/billing/src/late-a.ts', 'pkg/billing/src/late-b.ts'],
				}),
			],
			rootDir: majorityRoot,
			allowedPathPrefixes: ['pkg/billing'],
		});
		assert.equal(majority.tasks[0].authoredPaths.includes('pkg/billing/src/orphan.ts'), false);
		assert.equal(majority.tasks[1].authoredPaths.includes('pkg/billing/src/orphan.ts'), true);
		const tied = expandRetirementPaths({
			tasks: [
				task({
					taskId: 'early-task',
					integrationOrder: 0,
					pathPrefixes: ['pkg/billing/src/early.ts'],
					authoredPaths: ['pkg/billing/src/early.ts'],
				}),
				task({
					taskId: 'late-task',
					integrationOrder: 1,
					pathPrefixes: ['pkg/billing/src/late-a.ts'],
					authoredPaths: ['pkg/billing/src/late-a.ts'],
				}),
			],
			rootDir: tieRoot,
			allowedPathPrefixes: ['pkg/billing'],
		});
		assert.equal(tied.tasks[0].authoredPaths.includes('pkg/billing/src/orphan.ts'), true);
		assert.equal(tied.tasks[1].authoredPaths.includes('pkg/billing/src/orphan.ts'), false);
	} finally {
		fs.rmSync(majorityRoot, { recursive: true, force: true });
		fs.rmSync(tieRoot, { recursive: true, force: true });
	}
});

test('@ac AC-02 @case AC-02.1 a non-literal import is unresolved and adds no path', () => {
	const root = tempTree({
		'pkg/billing/src/retire.ts': "import { orphan } from './orphan.ts';\nexport const value = import(name);\n",
		'pkg/billing/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const before = task();
		const result = expandRetirementPaths({
			tasks: [before],
			rootDir: root,
			allowedPathPrefixes: ['pkg/billing'],
		});
		assert.equal(result.blockers.some((blocker) => blocker.kind === 'unresolved_import'), true);
		assert.deepEqual(result.tasks[0].pathPrefixes, before.pathPrefixes);
		assert.deepEqual(result.tasks[0].authoredPaths, before.authoredPaths);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-02 @case AC-02.3 a sibling outside allowedPathPrefixes is refused and named on the P1', () => {
	const root = tempTree({
		'pkg/billing/src/retire.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const result = expandRetirementPaths({
			tasks: [task()],
			rootDir: root,
			allowedPathPrefixes: ['pkg/other'],
		});
		assert.equal(result.tasks[0].pathPrefixes.includes('pkg/billing/src/orphan.ts'), false);
		assert.equal(
			result.blockers.some((blocker) => blocker.kind === 'outside_allowed_prefixes' && blocker.path === 'pkg/billing/src/orphan.ts'),
			true,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.1 check-spec on retirement prose performs no scan', () => {
	const before = staticImportScanCount();
	const reads = [];
	const original = fs.readFileSync;
	fs.readFileSync = (...args) => {
		reads.push(String(args[0]));
		return original.apply(fs, args);
	};
	try {
		const result = checkSpecRun({
			command: 'check-spec',
			values: new Map([['--goal', '# Intent\n\nRetire the route and leave the sibling behind.\n']]),
			booleans: new Set(),
		}, { rootDir: process.cwd() });
		assert.equal(result.taskReadiness, null);
	} finally {
		fs.readFileSync = original;
	}
	assert.equal(staticImportScanCount(), before);
	assert.equal(reads.some((file) => /\/(services|packages)\//.test(file)), false);
});

test('@ac AC-03 @case AC-03.2 retirement false skips that task', () => {
	const root = tempTree({
		'pkg/billing/src/retire.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const before = staticImportScanCount();
		const result = expandRetirementPaths({
			tasks: [task({ retirement: false })],
			rootDir: root,
			allowedPathPrefixes: ['pkg/billing'],
		});
		assert.equal(staticImportScanCount(), before);
		assert.equal(result.tasks[0].pathPrefixes.includes('pkg/billing/src/orphan.ts'), false);
		assert.equal(result.blockers.length, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.3 a non-retirement task that holds the only importer gains no sibling', () => {
	const root = tempTree({
		'pkg/billing/src/feature.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const result = expandRetirementPaths({
			tasks: [task({
				retirement: undefined,
				pathPrefixes: ['pkg/billing/src/feature.ts'],
				authoredPaths: ['pkg/billing/src/feature.ts'],
			})],
			rootDir: root,
			allowedPathPrefixes: ['pkg/billing'],
		});
		assert.equal(result.tasks[0].authoredPaths.includes('pkg/billing/src/orphan.ts'), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-04 @case AC-04.1 a method-only retirement adds no sibling', () => {
	const root = tempTree({
		'pkg/billing/src/retire.ts': 'export class Route { private retire() { return 1; } }\n',
		'pkg/billing/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const result = expandRetirementPaths({
			tasks: [task()],
			rootDir: root,
			allowedPathPrefixes: ['pkg/billing'],
		});
		assert.equal(result.tasks[0].pathPrefixes.includes('pkg/billing/src/orphan.ts'), false);
		assert.equal(result.blockers.length, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('@ac AC-04 @case AC-04.2 overlap after expansion fails before PLAN_FROZEN', () => {
	const root = tempTree({
		'pkg/a/src/retire.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/a/src/orphan.ts': 'export const orphan = 1;\n',
	});
	try {
		const tasks = [
			task({
				taskId: 'retire-route',
				targetPackage: 'pkg/a',
				pathPrefixes: ['pkg/a/src/retire.ts'],
				authoredPaths: ['pkg/a/src/retire.ts'],
				integrationOrder: 0,
			}),
			task({
				taskId: 'other-route',
				targetPackage: 'pkg/b',
				retirement: false,
				pathPrefixes: ['pkg/b/src/keep.ts'],
				authoredPaths: ['pkg/b/src/keep.ts'],
				integrationOrder: 1,
			}),
		];
		const authorization = { allowedPackages: ['pkg/a', 'pkg/b'] };
		const order = ['retire-route', 'other-route'];
		assert.doesNotThrow(() => evaluatePolicyGate({
			taskPlan: { tasks, integrationOrder: order },
			authorization,
			workspacePackages: { packageMap: new Map(), pathToPackage: new Map() },
		}));
		tasks[1] = task({
			taskId: 'other-route',
			targetPackage: 'pkg/b',
			retirement: false,
			pathPrefixes: ['pkg/a/src/orphan.ts'],
			authoredPaths: ['pkg/a/src/orphan.ts'],
			integrationOrder: 1,
		});
		const expanded = expandRetirementPaths({
			tasks,
			rootDir: root,
			allowedPathPrefixes: ['pkg/a', 'pkg/b'],
		});
		assert.equal(expanded.tasks[0].pathPrefixes.includes('pkg/a/src/orphan.ts'), true);
		assert.throws(
			() => evaluatePolicyGate({
				taskPlan: { tasks: expanded.tasks, integrationOrder: order },
				authorization,
				workspacePackages: { packageMap: new Map(), pathToPackage: new Map() },
			}),
			/overlapping owned paths/,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('null and empty task lists do not scan', () => {
	const before = staticImportScanCount();
	assert.deepEqual(expandRetirementPaths({ tasks: null, rootDir: os.tmpdir(), allowedPathPrefixes: [] }).tasks, []);
	assert.deepEqual(expandRetirementPaths({ tasks: [], rootDir: os.tmpdir(), allowedPathPrefixes: null }).blockers, []);
	assert.equal(staticImportScanCount(), before);
});
