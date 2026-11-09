import fs from 'node:fs';
import path from 'node:path';
import type { TaskExecutorAuthorization, TaskExecutorOptions } from '../execution/task-executor.ts';
import { FakeModelGovernor, type FakeGovernorScriptItem } from './fake-model-governor.ts';
import { makeFixture } from './test-support-fixtures.ts';
import { TaskExecutor } from '../execution/task-executor.ts';

export const PRODUCT_IMPLEMENTER_PATH = 'services/billing/src/locked.ts';
export const PRODUCT_IMPLEMENTER_ORIGINAL = 'export const value = "before";\n';

export interface ProductImplementerOptions {
	label: string;
	script: FakeGovernorScriptItem[];
	sameTree?: boolean;
	executor?: 'minimal' | null;
	verificationCommand?: string[] | null;
	execCli?: TaskExecutorOptions['execCli'];
	diffFile?: string | null;
	runtime?: TaskExecutorOptions['runtime'];
	authoredPaths?: string[] | null;
	sliceId?: string | null;
}

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
}: ProductImplementerOptions) {
	const fixture = makeFixture(label, []);
	const baseCommitSha = 'a'.repeat(40);
	const baseTreeSha = 'b'.repeat(40);
	const newTreeSha = 'c'.repeat(40);
	let worktreeDir: string | null = null;
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
					title: 'Implement billing',
					targetPackage: 'services/billing',
					pathPrefixes: ['services/billing'],
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
		// Typed view without listDiagnostics: its record type lacks the index signature the executor interface declares.
		const runtimeStore: Omit<typeof fixture.store, 'listDiagnostics'> = fixture.store;
		const taskExecutor = new TaskExecutor({
			governor,
			runtimeStore,
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
		const authorization: TaskExecutorAuthorization & { allowedPathPrefixes: string[] } = {
			allowedPackages: ['services/billing'],
			allowedPathPrefixes: ['services/billing'],
		};
		let error: unknown = null;
		let planResult = null;
		try {
			planResult = await taskExecutor.executeTaskPlan({
				taskPlan,
				authorization,
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
	return (_command: string, args?: readonly string[]) => {
		if (args?.includes('test:unit')) {
			throw Object.assign(new Error('tests failed'), { status: 1, stdout: 'tests failed', stderr: '' });
		}
		return '';
	};
}

