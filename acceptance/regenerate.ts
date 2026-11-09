import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bytesHash, fail, regularFile, writeJson } from './primitives.ts';
import { readAs, type AdmissionConfig, type AdmissionManifest, type FileReference, type RunAuthorization } from './admission-types.ts';
import { artifact } from './artifacts.ts';
import { responseFiles } from './live-records.ts';

interface RegenerateInputs {
	root: string;
	config: AdmissionConfig;
	engine: string | undefined;
	now?: Date;
	run: (command: string, args: string[]) => Promise<unknown>;
}

interface ApproveInputs {
	root: string;
	config: AdmissionConfig;
	approval: { approvedBy: string; text: string; implementationScope: unknown; liveScope: unknown };
	now?: Date;
	verify: (manifest: string) => Promise<unknown>;
}

const HASH = /^[a-f0-9]{64}$/;

export const admissionDir = (config: AdmissionConfig, head: string): string => `${config.output}/h${head.slice(0, 8)}`;
export const runIdFor = (config: AdmissionConfig, now: Date): string => `${now.toISOString().slice(0, 10)}-${config.slug}`;

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

// Every { path, sha256 } object in a record; paths under a sandbox mount ('@worktree/…') and absolute executable paths are not host files.
export function pinnedReferences(value: unknown, found: FileReference[] = []): FileReference[] {
	if (Array.isArray(value)) value.forEach((item) => pinnedReferences(item, found));
	else if (value && typeof value === 'object') {
		const record = value as { path?: unknown; sha256?: unknown };
		if (typeof record.path === 'string' && HASH.test(String(record.sha256 ?? '')) && !record.path.startsWith('@') && !path.isAbsolute(record.path)) found.push(record as FileReference);
		else Object.values(record).forEach((item) => pinnedReferences(item, found));
	}
	return found;
}

// A pin that names a missing or changed file is what admission would reject much later, so name it now.
export function stalePins(root: string, label: string, value: unknown): string[] {
	const problems: string[] = [];
	for (const pin of pinnedReferences(value)) {
		try {
			if (bytesHash(fs.readFileSync(regularFile(root, pin.path))) !== pin.sha256) problems.push(`${label}: changed ${pin.path}`);
		} catch { problems.push(`${label}: missing ${pin.path}`); }
	}
	return problems;
}

export function assertPreflightCurrent(root: string, config: AdmissionConfig, head: string): void {
	if (!config.preflightResult) fail('preflightResult is not configured');
	const result = readAs<{ gitHeadSha?: string; status?: string; canonical?: boolean; skippedGates?: unknown[] }>(path.join(root, config.preflightResult));
	if (result.gitHeadSha !== head || result.status !== 'OK' || result.canonical !== true || result.skippedGates?.length) {
		fail(`preflight is not a canonical OK for HEAD ${head.slice(0, 8)}; run ${(config.preflightCommand ?? ['the preflight']).join(' ')}`);
	}
}

export function assertPinsCurrent(root: string, config: AdmissionConfig): void {
	const execution = readAs<{ adapters?: unknown }>(path.join(root, artifact(config, 'executionManifest')));
	const problems = [...stalePins(root, 'task-lint-recipe', readAs<unknown>(path.join(root, artifact(config, 'taskLintRecipe')))),
		...stalePins(root, 'execution adapters', execution.adapters)];
	if (problems.length) fail(`stale pinned references:\n${problems.join('\n')}`);
}

// Runs the whole offline admission chain at the current host HEAD. Approval is a separate, explicit step.
export async function regenerateAdmission({ root, config, engine, now = new Date(), run }: RegenerateInputs): Promise<{ head: string; dir: string; runId: string }> {
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
	await run('command-qualify', []);
	await run('registrations', ['--output', registrations]);
	const problems = stalePins(root, 'registrations', readAs<unknown>(path.join(root, registrations)));
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
export async function approveAdmission({ root, config, approval, now = new Date(), verify }: ApproveInputs): Promise<{ manifest: string; runId: string }> {
	const head = git(root, 'rev-parse', 'HEAD'), dir = admissionDir(config, head);
	const admission = readAs<Partial<AdmissionManifest>>(path.join(root, `${dir}/admission.json`));
	const receipt = (name: string, scope: unknown) => {
		writeJson(path.join(root, `${dir}/${name}.json`), { schemaVersion: '1.0.0', status: 'passed', baseCommitSha: head,
			approvedBy: approval.approvedBy, approvedAt: now.toISOString(), approval: approval.text, scope });
		const file = `${dir}/${name}.json`;
		return { path: file, sha256: bytesHash(fs.readFileSync(path.join(root, file))) };
	};
	admission.admission = 'APPROVED';
	admission.implementationApprovalReceipt = receipt('implementationApprovalReceipt', approval.implementationScope);
	admission.liveApprovalReceipt = receipt('liveApprovalReceipt', approval.liveScope);
	writeJson(path.join(root, `${dir}/admission.approved.json`), admission);
	const authorization = readAs<{ authorizations: RunAuthorization[] }>(path.join(root, `${dir}/first-run/run-authorizations.json`)).authorizations[0];
	const envelope = path.join(root, responseFiles(config).envelope);
	fs.rmSync(envelope, { force: true });
	writeJson(envelope, authorization);
	await verify(`${dir}/admission.approved.json`);
	return { manifest: `${dir}/admission.approved.json`, runId: authorization.runId };
}
