import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bytesHash, fail, readJson, regularFile, writeJson } from './primitives.mjs';
import { artifact } from './artifacts.mjs';
import { responseFiles } from './live-records.mjs';

const HASH = /^[a-f0-9]{64}$/;

export const admissionDir = (config, head) => `${config.output}/h${head.slice(0, 8)}`;
export const runIdFor = (config, now) => `${now.toISOString().slice(0, 10)}-${config.slug}`;

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// Every { path, sha256 } object in a record; paths under a sandbox mount ('@worktree/…') are not host files.
export function pinnedReferences(value, found = []) {
	if (Array.isArray(value)) value.forEach((item) => pinnedReferences(item, found));
	else if (value && typeof value === 'object') {
		if (typeof value.path === 'string' && HASH.test(value.sha256 ?? '') && !value.path.startsWith('@')) found.push(value);
		else Object.values(value).forEach((item) => pinnedReferences(item, found));
	}
	return found;
}

// A pin that names a missing or changed file is what admission would reject much later, so name it now.
export function stalePins(root, label, value) {
	const problems = [];
	for (const pin of pinnedReferences(value)) {
		try {
			if (bytesHash(fs.readFileSync(regularFile(root, pin.path))) !== pin.sha256) problems.push(`${label}: changed ${pin.path}`);
		} catch { problems.push(`${label}: missing ${pin.path}`); }
	}
	return problems;
}

export function assertPreflightCurrent(root, config, head) {
	if (!config.preflightResult) fail('preflightResult is not configured');
	const result = readJson(path.join(root, config.preflightResult));
	if (result.gitHeadSha !== head || result.status !== 'OK' || result.canonical !== true || result.skippedGates?.length) {
		fail(`preflight is not a canonical OK for HEAD ${head.slice(0, 8)}; run ${(config.preflightCommand ?? ['the preflight']).join(' ')}`);
	}
}

export function assertPinsCurrent(root, config) {
	const execution = readJson(path.join(root, artifact(config, 'executionManifest')));
	const problems = [...stalePins(root, 'task-lint-recipe', readJson(path.join(root, artifact(config, 'taskLintRecipe')))),
		...stalePins(root, 'execution adapters', execution.adapters)];
	if (problems.length) fail(`stale pinned references:\n${problems.join('\n')}`);
}

// Runs the whole offline admission chain at the current host HEAD. Approval is a separate, explicit step.
export async function regenerateAdmission({ root, config, engine, now = new Date(), run }) {
	if (!engine) fail('AGENT_SDLC_PATH is required');
	if (fs.realpathSync(process.cwd()) !== root) fail('run from the host root');
	const head = git(root, 'rev-parse', 'HEAD');
	const dirty = git(root, 'status', '--porcelain=v1', '--untracked-files=all');
	if (dirty) fail(`host worktree is dirty:\n${dirty}`);
	assertPreflightCurrent(root, config, head);
	if (git(engine, 'status', '--porcelain=v1', '--untracked-files=no')) fail('engine has uncommitted tracked changes; admission pins the engine commit');
	assertPinsCurrent(root, config);
	const dir = admissionDir(config, head), first = `${dir}/first-run`, runId = runIdFor(config, now);
	if (fs.existsSync(path.join(root, dir))) fail(`admission directory exists, move it aside: ${dir}`);
	const { spec, tasks } = config.canary ?? fail('acceptanceEvidence.canary is not configured');
	const roles = `${dir}/role-definitions.json`, registrations = `${dir}/adapter-registrations.json`;
	await run('registrations', ['--dependency-manifest', artifact(config, 'runtimeDependencies'), '--output', registrations]);
	const problems = stalePins(root, 'registrations', readJson(path.join(root, registrations)));
	if (problems.length) fail(`stale pinned references:\n${problems.join('\n')}`);
	await run('governor-resolution', ['--output', `${dir}/governor-resolution.json`]);
	await run('role-definitions', ['--output', roles]);
	await run('experiment-config', ['--role-definitions', roles, '--output-dir', first, '--run-id', runId]);
	await run('authorize', ['--spec', spec, '--tasks', tasks, '--registrations', registrations,
		'--quality-policy', `${first}/quality-policy.json`, '--run-id', runId, '--output', `${first}/run-authorizations.json`]);
	await run('prompt-fit', ['--spec', spec, '--tasks', tasks, '--role-definitions', roles, '--output', `${first}/prompt-fit.json`]);
	await run('admission-records', ['--engine', engine, '--run-dir', first, '--output-dir', `${first}/records`, '--roles', roles]);
	await run('admission-proposal', ['--engine', engine, '--run-dir', first, '--roles', roles, '--output', `${dir}/proposal.json`]);
	await run('admission-assemble', ['--proposal', `${dir}/proposal.json`, '--output', `${dir}/admission.json`]);
	return { head, dir, runId };
}

// Writes the two approval receipts, the approved manifest and the frozen envelope. The operator's words are recorded verbatim.
export async function approveAdmission({ root, config, approval, now = new Date(), verify }) {
	const head = git(root, 'rev-parse', 'HEAD'), dir = admissionDir(config, head);
	const admission = readJson(path.join(root, `${dir}/admission.json`));
	const receipt = (name, scope) => {
		writeJson(path.join(root, `${dir}/${name}.json`), { schemaVersion: '1.0.0', status: 'passed', baseCommitSha: head,
			approvedBy: approval.approvedBy, approvedAt: now.toISOString(), approval: approval.text, scope });
		const file = `${dir}/${name}.json`;
		return { path: file, sha256: bytesHash(fs.readFileSync(path.join(root, file))) };
	};
	admission.admission = 'APPROVED';
	admission.implementationApprovalReceipt = receipt('implementationApprovalReceipt', approval.implementationScope);
	admission.liveApprovalReceipt = receipt('liveApprovalReceipt', approval.liveScope);
	writeJson(path.join(root, `${dir}/admission.approved.json`), admission);
	const authorization = readJson(path.join(root, `${dir}/first-run/run-authorizations.json`)).authorizations[0];
	const envelope = path.join(root, responseFiles(config).envelope);
	fs.rmSync(envelope, { force: true });
	writeJson(envelope, authorization);
	await verify(`${dir}/admission.approved.json`);
	return { manifest: `${dir}/admission.approved.json`, runId: authorization.runId };
}
