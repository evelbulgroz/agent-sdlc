import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArguments } from './arguments.ts';
import { projectHostInvocation } from './host-invocation.ts';
import { shellReply, shellWatch } from './shell-driver.ts';
import { SdlcError } from '../policy/errors.ts';
import { readStaticImportGraph } from '../policy/static-import-graph.ts';
import {
	acceptCorrectionResponse,
	assertUnresolvedTask,
	offerFromOwner,
	selectCorrectionOwner,
} from './correction-reply.ts';

const PATHS = ['pkg/billing/src/orphan.ts'];
const authorization = { allowedPathPrefixes: ['pkg/billing'] };

function escalated(paths = PATHS) {
	return {
		runId: '2026-11-11-correction-card',
		state: 'ESCALATED',
		blockedReason: 'AUTONOMOUS_REPAIR_RETIRED',
		lastError: {
			metadata: {
				integrationFailure: {
					haltPath: 'AUTONOMOUS_REPAIR_RETIRED',
					classification: 'quality_failure',
					category: 'coverage_floor_regression',
					targetPaths: paths,
					continuation: 'stop',
				},
				correctionOffer: { paths, taskId: 'retire-route', taskIdRequired: false },
			},
		},
	};
}

function task(taskId, paths, order = 0) {
	return {
		taskId,
		targetPackage: 'pkg/billing',
		authoredPaths: paths,
		pathPrefixes: paths,
		integrationOrder: order,
	};
}

function graph(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'correction-owner-'));
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
	}
	const built = readStaticImportGraph({ rootDir: root, roots: ['pkg/billing'] });
	fs.rmSync(root, { recursive: true, force: true });
	return built;
}

test('@ac AC-01 @case AC-01.1 the published slot is accepted', async () => {
	const state = escalated();
	const card = projectHostInvocation(state, { authorization, highRiskPaths: [] });
	assert.equal(card.executable, true);
	assert.deepEqual(card.responseSlots.choices, ['approve-correction', 'stop']);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'correction-reply-'));
	const responseFile = path.join(dir, 'reply.json');
	fs.writeFileSync(responseFile, JSON.stringify({ action: 'approve-correction', paths: PATHS }));
	let submitted = null;
	await shellReply({
		runId: state.runId,
		responseFile,
		rootDir: dir,
		streams: { stdin: process.stdin, stdout: { write() {} }, stderr: { write() {} } },
		runCliFn: async (args) => {
			if (args[0] === 'status') return { exitCode: 2, result: { hostInvocation: card }, human: '' };
			submitted = args;
			const file = args[args.indexOf('--response-file') + 1];
			submitted = JSON.parse(fs.readFileSync(file, 'utf8'));
			return { exitCode: 0, result: { ok: true, command: 'resume' }, human: '' };
		},
	});
	assert.equal(submitted.action, 'approve-correction');
	assert.deepEqual(submitted.paths, PATHS);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('@ac AC-01 @case AC-01.2 an approve-remedy flag is rejected by the reply allowlist', () => {
	assert.throws(
		() => parseArguments(['shell', 'reply', '--run', '2026-11-11-correction-card', '--approve-remedy']),
		(error) => error instanceof SdlcError && /approve-remedy/.test(error.message),
	);
});

test('@ac AC-01 @case AC-01.3 shell watch leaves the card pending', async () => {
	const calls = [];
	const status = {
		ok: true,
		continuation: { action: 'answer', reason: 'HUMAN_RESPONSE_REQUIRED' },
		hostInvocation: projectHostInvocation(escalated(), { authorization, highRiskPaths: [] }),
	};
	const final = await shellWatch({
		runId: '2026-11-11-correction-card',
		rootDir: process.cwd(),
		streams: { stdin: process.stdin, stdout: { write() {} }, stderr: { write() {} } },
		runCliFn: async (args) => {
			calls.push(args[0]);
			return { exitCode: 2, result: status, human: '' };
		},
	});
	assert.deepEqual(calls, ['status']);
	assert.equal(final.continuation.action, 'answer');
});

test('@ac AC-02 @case AC-02.4 one removed import selects that task and the response must repeat taskId', () => {
	const baseGraph = graph({
		'pkg/billing/src/retire.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/orphan.ts': 'export const orphan = 1;\n',
	});
	const targetGraph = graph({ 'pkg/billing/src/retire.ts': 'export const retired = 1;\n' });
	const owner = selectCorrectionOwner({
		tasks: [task('retire-route', ['pkg/billing/src/retire.ts'])],
		paths: PATHS,
		baseGraph,
		targetGraphs: { 'retire-route': targetGraph },
	});
	assert.equal(owner.kind, 'removed-import');
	const offer = offerFromOwner(PATHS, owner);
	assert.equal(offer.taskIdRequired, true);
	assert.throws(() => acceptCorrectionResponse(offer, { action: 'approve-correction', paths: PATHS }));
	const accepted = acceptCorrectionResponse(offer, {
		action: 'approve-correction',
		taskId: 'retire-route',
		paths: PATHS,
	});
	assert.equal(accepted.taskId, 'retire-route');
});

test('@ac AC-02 @case AC-02.5 zero or several removed imports require taskId', () => {
	const baseGraph = graph({
		'pkg/billing/src/retire.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/other.ts': "import { orphan } from './orphan.ts';\n",
		'pkg/billing/src/orphan.ts': 'export const orphan = 1;\n',
	});
	const targetGraph = graph({
		'pkg/billing/src/retire.ts': 'export const retired = 1;\n',
		'pkg/billing/src/other.ts': 'export const other = 1;\n',
	});
	const several = selectCorrectionOwner({
		tasks: [
			task('retire-route', ['pkg/billing/src/retire.ts'], 0),
			task('other-route', ['pkg/billing/src/other.ts'], 1),
		],
		paths: PATHS,
		baseGraph,
		targetGraphs: { 'retire-route': targetGraph, 'other-route': targetGraph },
	});
	assert.equal(several.kind, 'unresolved');
	const none = selectCorrectionOwner({
		tasks: [task('retire-route', ['pkg/billing/src/retire.ts'])],
		paths: PATHS,
		baseGraph: graph({ 'pkg/billing/src/retire.ts': 'export const retired = 1;\n' }),
		targetGraphs: {},
	});
	assert.equal(none.kind, 'unresolved');
	const offer = offerFromOwner(PATHS, none);
	assert.throws(() => acceptCorrectionResponse(offer, { action: 'approve-correction', paths: PATHS }));
});

test('@ac AC-02 @case AC-02.6 taskId is accepted only when the path is under targetPackage and inside allowedPathPrefixes', () => {
	const tasks = [task('retire-route', ['pkg/billing/src/retire.ts'])];
	const accepted = assertUnresolvedTask({
		tasks,
		taskId: 'retire-route',
		paths: PATHS,
		allowedPathPrefixes: ['pkg/billing'],
	});
	assert.equal(accepted.taskId, 'retire-route');
	assert.throws(() => assertUnresolvedTask({
		tasks,
		taskId: 'retire-route',
		paths: ['pkg/other/src/orphan.ts'],
		allowedPathPrefixes: ['pkg/billing', 'pkg/other'],
	}));
	assert.throws(() => assertUnresolvedTask({
		tasks,
		taskId: 'retire-route',
		paths: PATHS,
		allowedPathPrefixes: ['pkg/other'],
	}));
	assert.throws(() => assertUnresolvedTask({
		tasks,
		taskId: 'missing-route',
		paths: PATHS,
		allowedPathPrefixes: ['pkg/billing'],
	}));
});

test('@ac AC-02 @case AC-02.7 a taskId that contradicts a unique write-set owner is rejected', () => {
	const owner = selectCorrectionOwner({
		tasks: [task('retire-route', PATHS)],
		paths: PATHS,
		baseGraph: graph({}),
		targetGraphs: {},
	});
	assert.equal(owner.kind, 'write-set');
	const offer = offerFromOwner(PATHS, owner);
	assert.throws(
		() => acceptCorrectionResponse(offer, { action: 'approve-correction', taskId: 'other-route', paths: PATHS }),
		(error) => error instanceof SdlcError && /owner/.test(error.message),
	);
});

test('a null reply and an empty path list are rejected', () => {
	const offer = offerFromOwner(PATHS, { kind: 'write-set', taskId: 'retire-route' });
	assert.throws(() => acceptCorrectionResponse(offer, null));
	assert.throws(() => acceptCorrectionResponse(offer, { action: 'approve-correction', paths: [] }));
	assert.equal(acceptCorrectionResponse(offer, { action: 'stop' }).action, 'stop');
});
