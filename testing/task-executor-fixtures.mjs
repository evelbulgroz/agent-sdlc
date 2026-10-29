import fs from 'node:fs';
import path from 'node:path';
import { FakeModelGovernor } from './fake-model-governor.mjs';
import { makeFixture } from './test-support.mjs';
import { TaskExecutor } from '../execution/task-executor.ts';

export const PRODUCT_IMPLEMENTER_PATH = 'apps/services/conditioning/src/locked.ts';
export const PRODUCT_IMPLEMENTER_ORIGINAL = 'export const value = "before";\n';

export async function runProductImplementer({
	label,
	script,
	sameTree = false,
	executor = null,
	verificationCommand = null,
	execCli = () => '',
	diffFile = null,
	runtime = null,
	authoredPaths = null,
	sliceId = null,
}) {
	const fixture = makeFixture(label, []);
	const baseCommitSha = 'a'.repeat(40);
	const baseTreeSha = 'b'.repeat(40);
	const newTreeSha = 'c'.repeat(40);
	let worktreeDir = null;
	const governor = new FakeModelGovernor(script);
	try {
		fixture.runtime.initialize({
			runId: fixture.runId,
			goal: label,
		});
		const taskPlan = {
			schemaVersion: '1.0.0',
			runId: fixture.runId,
			planPolicyHash: '1'.repeat(64),
			baseCommitSha,
			isParallel: false,
			tasks: [
				{
					taskId: 'task-0',
					title: 'Implement conditioning',
					targetPackage: 'apps/services/conditioning',
					pathPrefixes: ['apps/services/conditioning'],
					dependsOn: [],
					status: 'pending',
					integrationOrder: 0,
					worktreeSubdir: 'worktree',
					baseCommitSha,
					parentTreeSha: null,
					targetTreeSha: null,
					patchHash: null,
					failurePacketArtifact: null,
					repairCount: 0,
					...(verificationCommand ? { verificationCommand } : {}),
					...(authoredPaths ? { authoredPaths } : {}),
					...(sliceId ? { sliceId } : {}),
				},
			],
			integrationOrder: ['task-0'],
			createdAt: new Date().toISOString(),
		};
		fixture.store.saveTaskPlan(taskPlan);
		if (executor) {
			const originalGetRun = fixture.store.getRun.bind(fixture.store);
			fixture.store.getRun = (id) => ({ ...originalGetRun(id), executor });
		}
		const taskExecutor = new TaskExecutor({
			governor,
			runtimeStore: fixture.store,
			artifactStore: fixture.artifacts,
			roleRegistry: fixture.registry,
			capabilityId: 'controlled-tool-loop-v1',
			programmerTurn: true,
			runtime,
			gitCli: (_cmd, args) => {
				if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${baseCommitSha}\n`;
				if (args[0] === 'rev-parse' && String(args[1]).includes('^{tree}')) {
					return `${baseTreeSha}\n`;
				}
				if (args[0] === 'worktree' && args[1] === 'add') {
					worktreeDir = args[3];
					const absolute = path.join(worktreeDir, PRODUCT_IMPLEMENTER_PATH);
					fs.mkdirSync(path.dirname(absolute), { recursive: true });
					fs.writeFileSync(absolute, PRODUCT_IMPLEMENTER_ORIGINAL);
					return '';
				}
				if (args[0] === 'diff-index') {
					return sameTree ? '' : `${diffFile ?? PRODUCT_IMPLEMENTER_PATH}\n`;
				}
				if (args[0] === 'write-tree') return `${sameTree ? baseTreeSha : newTreeSha}\n`;
				if (args[0] === 'diff-tree') return sameTree ? '' : 'diff --git a/locked.ts\n';
				return '';
			},
			execCli,
			runTaskTests: false,
		});
		let error = null;
		let planResult = null;
		try {
			planResult = await taskExecutor.executeTaskPlan({
				taskPlan,
				authorization: {
					allowedPackages: ['apps/services/conditioning'],
					allowedPathPrefixes: ['apps/services/conditioning'],
				},
				snapshot: { taskPlanFrozen: true },
				specSummary: 'Product implementer',
				acceptanceCriteria: ['AC-01'],
			});
		} catch (caught) {
			error = caught;
		}
		const task = fixture.store.getTask(fixture.runId, 'task-0');
		return {
			governor,
			error,
			planResult,
			task,
			content: worktreeDir
				? fs.readFileSync(path.join(worktreeDir, PRODUCT_IMPLEMENTER_PATH), 'utf8')
				: null,
		};
	} finally {
		fixture.close();
		if (worktreeDir) fs.rmSync(path.dirname(worktreeDir), { recursive: true, force: true });
	}
}

export const POST_IMPLEMENT_RUNTIME = {
	registry: {
		loadPipeline() {
			throw new Error('post-implement ran');
		},
	},
};

export function failingVerificationExec() {
	return (_command, args) => {
		if (args?.includes('test:unit')) {
			const error = new Error('tests failed');
			error.status = 1;
			error.stdout = 'tests failed';
			error.stderr = '';
			throw error;
		}
		return '';
	};
}

