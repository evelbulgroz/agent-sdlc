import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../cli/cli.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { FakeModelGovernor } from './fake-model-governor.ts';
import { completeProposal, grammaticalAcceptance, removeTestRunArtifacts, seedCitingSpecs, seedWorkspacePackageManifest, trackTestRun } from './test-support-fixtures.ts';

export interface SetupInterrupt {
	interruptId: string;
	request: { stateHash: string; draftHash: string; approval: { approvalHash: string } };
}

interface SetupResult {
	runId: string;
	state?: string;
	pendingInterrupt?: SetupInterrupt;
}

// runCli leaves its result untyped; these setup flows only read the fields above.
function setupResult(outcome: { result?: unknown }): SetupResult {
	return outcome.result as SetupResult;
}

export function cleanupRun(runId: string): void {
	removeTestRunArtifacts(runId);
}

export function seedSlice4CrashWorktree(dir: string): void {
	seedCitingSpecs(dir);
	for (const packagePath of ['packages/shared-base', 'services/billing']) {
		seedWorkspacePackageManifest(dir, packagePath);
	}
}

export function waitForBoundary(child: ChildProcess): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let output = '';
		const collect = (chunk: unknown) => {
			output = `${output}${chunk}`.slice(-4000);
		};
		child.stdout?.on('data', collect);
		child.stderr?.on('data', collect);
		const fail = (reason: string) => {
			clearTimeout(timer);
			reject(new Error(`${reason}\n--- child output (tail) ---\n${output}`));
		};
		const timer: NodeJS.Timeout = setTimeout(() => fail('Boundary marker timeout'), 10_000);
		child.once('message', (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.once('exit', (code, signal) => {
			fail(`Child exited before boundary marker (code=${code}, signal=${signal})`);
		});
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

export function collectLocalImportGraph(entry: string): Set<string> {
	const visited = new Set<string>();
	const queue: string[] = [entry];
	for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
		if (visited.has(current)) continue;
		visited.add(current);
		const source = fs.readFileSync(current, 'utf8');
		const imports = [
			...source.matchAll(/(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g),
			...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
		];
		for (const match of imports) {
			const importPath = match[1];
			if (!importPath?.startsWith('.')) continue;
			const candidate = path.resolve(path.dirname(current), importPath);
			const resolved = [
				candidate,
				`${candidate}.ts`,
				`${candidate}.mjs`,
				path.join(candidate, 'index.ts'),
				path.join(candidate, 'index.mjs'),
			].find((item) => fs.existsSync(item));
			if (resolved) queue.push(resolved);
		}
	}
	return visited;
}

export async function startWaitingForApproval(label: string, proposal = completeProposal()) {
	const testSlug = `sdlc-${label}-${trackTestRun(crypto.randomUUID().slice(0, 8))}`;
	const governor = new FakeModelGovernor([proposal]);
	const started = await runCli(
		['start', '--slug', testSlug, '--goal', 'Exercise approval branch recovery'],
		{ rootDir: REPOSITORY_ROOT, governor },
	);
	const startedResult = setupResult(started);
	const runId = startedResult.runId;
	const pending = startedResult.pendingInterrupt;
	assert.ok(pending, `start returned no pending interrupt: ${JSON.stringify(startedResult).slice(0, 1500)}`);
	const response = {
		schemaVersion: '1.0.0',
		interruptId: pending.interruptId,
		stateHash: pending.request.stateHash,
		answers: [
			{ questionId: 'acceptance', value: grammaticalAcceptance('Approval branch resumes') },
			{ questionId: 'failure', value: 'No duplicate terminal event' },
			{ questionId: 'verification', value: 'Inspect durable state' },
		],
	};
	const responseFile = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc',
		runId,
		'approval-branch-setup.json',
	);
	fs.writeFileSync(responseFile, JSON.stringify(response), { mode: 0o600 });
	const waiting = await runCli(
		['answer', '--run', runId, '--interrupt', pending.interruptId, '--response-file', responseFile],
		{ rootDir: REPOSITORY_ROOT, governor },
	);
	const waitingResult = setupResult(waiting);
	assert.equal(
		waitingResult.state,
		'WAITING_FOR_APPROVAL',
		`answer did not reach approval: ${JSON.stringify(waitingResult).slice(0, 1500)}`,
	);
	assert.ok(waitingResult.pendingInterrupt, 'approval wait returned no pending interrupt');
	return { runId, governor, pending: waitingResult.pendingInterrupt };
}

export async function startSpecApproved(label: string, proposal = completeProposal()) {
	const { runId, governor, pending } = await startWaitingForApproval(label, proposal);
	const approval = {
		schemaVersion: '1.0.0',
		interruptId: pending.interruptId,
		stateHash: pending.request.stateHash,
		action: 'approve',
		approvalHash: pending.request.approval.approvalHash,
		draftHash: pending.request.draftHash,
		changes: [],
	};
	const approvalFile = path.join(
		REPOSITORY_ROOT,
		'tools/.agent-sdlc',
		runId,
		'approval-setup.json',
	);
	fs.writeFileSync(approvalFile, JSON.stringify(approval), { mode: 0o600 });
	const approved = await runCli(
		['answer', '--run', runId, '--interrupt', pending.interruptId, '--response-file', approvalFile],
		{ rootDir: REPOSITORY_ROOT, governor },
	);
	assert.equal(setupResult(approved).state, 'SPEC_APPROVED');
	return { runId, governor };
}
