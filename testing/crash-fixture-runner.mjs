#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../cli/cli.ts';
import { SdlcError } from '../policy/errors.ts';
import { FakeModelGovernor } from './fake-model-governor.mjs';
import {
	completeProposal,
	createMockExecCli,
	createMockGitCli,
	createSlice2SmartGovernor,
	createSlice4SmartGovernor,
	seedCitingSpecs,
	seedWorkspacePackageManifest,
} from './test-support.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
	const arg = process.argv[index];
	if (arg.startsWith('--')) {
		const next = process.argv[index + 1];
		if (next && !next.startsWith('--')) {
			args.set(arg, next);
			index++;
		} else {
			args.set(arg, 'true');
		}
	}
}

const rootDir = args.get('--root');
const mode = args.get('--mode');
const boundary = args.get('--boundary');
const occurrence = Number(args.get('--occurrence') ?? '1');
const taskIdFilter = args.get('--task-id') || null;
if (!rootDir || !mode || !boundary || !Number.isSafeInteger(occurrence) || occurrence < 1) {
	throw new Error(
		'Usage: crash-fixture-runner --root <root> --mode <start|answer|authorize|resume|cancel> --boundary <name> [mode options]',
	);
}

let seen = 0;
const onBoundary = async (name, details) => {
	if (name !== boundary) return;
	if (taskIdFilter && details?.taskId !== taskIdFilter) return;
	if (++seen !== occurrence) return;
	const marker = { type: 'boundary', name, ...details };
	if (process.send) process.send(marker);
	else process.stdout.write(`${JSON.stringify(marker)}\n`);
	await new Promise((resolve) => {
		process.once('message', (message) => {
			if (message?.type === 'continue') resolve();
		});
	});
};

const mockSystem = args.has('--mock-system');
const isSlice4 = args.has('--slice4');
const governorError = args.get('--governor-error');
const failPreflightCalls = Number(args.get('--fail-preflight-calls') ?? '0');
const failPreflight = args.has('--fail-preflight') || failPreflightCalls > 0;
const failReview = args.has('--fail-review');

const surfaces = isSlice4
	? ['packages/shared-base', 'services/billing']
	: undefined;

const governor = governorError
	? new FakeModelGovernor([new SdlcError(governorError, 'Injected governed failure')])
	: isSlice4
		? createSlice4SmartGovernor({ surfaces, failReview })
		: mockSystem
			? createSlice2SmartGovernor({ failReview })
			: new FakeModelGovernor([completeProposal()]);

const gitCli = isSlice4
	? createMockGitCli({
			onWorktreeAdd: (dir) => {
				seedCitingSpecs(dir);
				for (const packagePath of ['packages/shared-base', 'services/billing']) {
					seedWorkspacePackageManifest(dir, packagePath);
				}
			},
		})
	: mockSystem
		? createMockGitCli({ stagedPath: 'tools/example.mjs', onWorktreeAdd: seedCitingSpecs })
		: undefined;
const execCli = isSlice4 || mockSystem
	? createMockExecCli({
			preflightStatus: args.has('--fail-preflight') && failPreflightCalls === 0 ? 'FAIL' : 'OK',
			failPreflightFirstNCalls: failPreflightCalls,
			commitSha: args.has('--create-local-commits') ? 'c'.repeat(40) : null,
		})
	: undefined;

let cliArgs;
if (mode === 'start') {
	const slug = args.get('--slug');
	if (!slug) throw new Error('--slug is required for start mode');
	cliArgs = ['start', '--slug', slug, '--goal', 'Exercise deterministic crash recovery'];
} else if (mode === 'answer') {
	const runId = args.get('--run');
	const interruptId = args.get('--interrupt');
	const responseFile = args.get('--response-file');
	if (!runId || !interruptId || !responseFile) {
		throw new Error('--run, --interrupt, and --response-file are required for answer mode');
	}
	if (!fs.statSync(path.resolve(responseFile)).isFile()) {
		throw new Error('Response file must exist');
	}
	cliArgs = ['answer', '--run', runId, '--interrupt', interruptId, '--response-file', responseFile];
} else if (mode === 'authorize') {
	const runId = args.get('--run');
	if (!runId) throw new Error('--run is required for authorize mode');
	cliArgs = ['authorize', '--run', runId];
	if (args.has('--envelope-file')) {
		cliArgs.push('--envelope-file', args.get('--envelope-file'));
	}
	if (args.has('--interactive')) {
		cliArgs.push('--interactive');
	}
	if (args.has('--create-branch')) {
		cliArgs.push('--create-branch');
	}
	if (args.has('--create-local-commits')) {
		cliArgs.push('--create-local-commits');
	}
	if (args.has('--branch-name')) {
		cliArgs.push('--branch-name', args.get('--branch-name'));
	}
} else if (mode === 'resume') {
	const runId = args.get('--run');
	if (!runId) throw new Error('--run is required for resume mode');
	cliArgs = ['resume', '--run', runId];
} else if (mode === 'cancel') {
	const runId = args.get('--run');
	if (!runId) throw new Error('--run is required for cancel mode');
	cliArgs = ['cancel', '--run', runId];
} else {
	throw new Error(`Unsupported crash fixture mode: ${mode}`);
}

const outcome = await runCli(cliArgs, {
	rootDir,
	governor,
	onBoundary,
	gitCli,
	execCli,
});
process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
process.exitCode = outcome.exitCode;

