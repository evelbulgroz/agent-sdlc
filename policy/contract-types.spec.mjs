import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

const IS_STANDALONE = !fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/engine'));
const FACTORY_ROOT = IS_STANDALONE ? REPOSITORY_ROOT : path.join(REPOSITORY_ROOT, 'packages/engine');
const DAG_SCHEMA_TS_PATH = path.join(FACTORY_ROOT, 'policy/contracts/dag-schema.ts');
const PLANNING_SCHEMA_TS_PATH = path.join(FACTORY_ROOT, 'policy/contracts/planning-schema.ts');
const CONTRACTS_DIR = path.join(FACTORY_ROOT, 'policy/contracts');
const TSCONFIG_PATH = path.join(FACTORY_ROOT, 'tsconfig.json');
const PACKAGE_JSON_PATH = path.join(FACTORY_ROOT, 'package.json');
const TSC_BIN = path.join(FACTORY_ROOT, 'node_modules/.bin/tsc');

function runTscOnTempFixture(sourceText) {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sdlc-contract-types-'));
	try {
		fs.copyFileSync(PACKAGE_JSON_PATH, path.join(tempDir, 'package.json'));
		const baseConfig = JSON.parse(fs.readFileSync(TSCONFIG_PATH, 'utf8'));
		const fixtureConfig = {
			...baseConfig,
			compilerOptions: {
				...baseConfig.compilerOptions,
				typeRoots: [path.join(FACTORY_ROOT, 'node_modules/@types')],
			},
			include: ['fixture.ts'],
		};
		fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), `${JSON.stringify(fixtureConfig, null, 2)}\n`);
		fs.writeFileSync(path.join(tempDir, 'fixture.ts'), sourceText);
		return spawnSync(TSC_BIN, ['--noEmit', '-p', tempDir], {
			cwd: FACTORY_ROOT,
			encoding: 'utf8',
			timeout: 60_000,
		});
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

test('@ac AC-03 @case AC-03.1 @ac AC-04 @case AC-04.1 contract types in policy/contracts/*.ts derive from Zod schemas via z.infer including TaskManifest, DagTask, and TaskPlan', () => {
	const planningSource = fs.readFileSync(PLANNING_SCHEMA_TS_PATH, 'utf8');
	assert.match(planningSource, /export\s+type\s+TaskManifest\s*=\s*z\.infer<typeof\s+TaskManifestSchema>/);

	const dagSource = fs.readFileSync(DAG_SCHEMA_TS_PATH, 'utf8');
	assert.match(dagSource, /export\s+type\s+DagTask\s*=\s*z\.infer<typeof\s+DagTaskSchema>/);
	assert.match(dagSource, /export\s+type\s+TaskPlan\s*=\s*z\.infer<typeof\s+TaskPlanSchema>/);

	const contractFiles = fs
		.readdirSync(CONTRACTS_DIR)
		.filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'));
	assert.ok(contractFiles.length >= 13);
	for (const file of contractFiles) {
		const content = fs.readFileSync(path.join(CONTRACTS_DIR, file), 'utf8');
		assert.doesNotMatch(
			content,
			/export\s+interface\s+(?:TaskManifest|DagTask|TaskPlan|SpecificationDraft|RunAuthorization|HostInvocation|RuntimeStateRecord|ReviewReport|VerificationResult)\b/,
			`${file} must derive record types via z.infer rather than hand-written interfaces`,
		);
	}
});

test('@ac AC-03 @case AC-03.2 a temporary typecheck fixture that assigns a TaskManifest missing taskId fails tsc', () => {
	const planningSchemaImportPath = PLANNING_SCHEMA_TS_PATH.split(path.sep).join('/');
	const invalidManifestFixture = [
		`import type { TaskManifest } from '${planningSchemaImportPath}';`,
		'export const invalidManifest: TaskManifest = {',
		"\tschemaVersion: '1.0.0',",
		'\tslices: [',
		'\t\t{',
		"\t\t\tsliceId: 'slice-1',",
		"\t\t\tkind: 'vertical',",
		"\t\t\tgoal: 'Deliver feature',",
		"\t\t\tacceptanceCriteria: ['AC-01'],",
		'\t\t\tdependsOn: [],',
		'\t\t},',
		'\t],',
		'\ttasks: [',
		'\t\t{',
		"\t\t\tsliceId: 'slice-1',",
		"\t\t\ttargetPackage: 'tools',",
		"\t\t\tauthoredPaths: ['tools/agent-sdlc/cli/cli.ts'],",
		"\t\t\tpathPrefixes: ['tools/agent-sdlc/cli'],",
		'\t\t\tgeneratedOutputs: [],',
		'\t\t\tdependsOn: [],',
		"\t\t\tdeliveryLayers: ['tooling'],",
		'\t\t\tdependencyMutations: [],',
		'\t\t\tshadowPaths: {',
		"\t\t\t\tunhappy: 'non-zero exit',",
		"\t\t\t\ttimeout: 'deadline exceeded',",
		"\t\t\t\tempty: 'empty diff',",
		"\t\t\t\tboundary: 'path containment breach',",
		'\t\t\t},',
		"\t\t\tverificationCommand: ['pnpm', 'run', 'test:unit'],",
		'\t\t\tgeneratorCommand: null,',
		"\t\t\tacceptanceCriteria: ['AC-01'],",
		'\t\t},',
		'\t],',
		'};',
		'',
	].join('\n');

	const failedResult = runTscOnTempFixture(invalidManifestFixture);
	const failedOutput = `${failedResult.stdout ?? ''}\n${failedResult.stderr ?? ''}`;
	assert.notEqual(failedResult.status, 0, failedOutput);
	assert.match(failedOutput, /taskId/);

	const validManifestFixture = invalidManifestFixture.replace(
		"\t\t\tsliceId: 'slice-1',\n\t\t\ttargetPackage: 'tools',",
		"\t\t\ttaskId: 'valid-task',\n\t\t\tsliceId: 'slice-1',\n\t\t\ttargetPackage: 'tools',",
	);
	const passedResult = runTscOnTempFixture(validManifestFixture);
	const passedOutput = `${passedResult.stdout ?? ''}\n${passedResult.stderr ?? ''}`;
	assert.equal(passedResult.status, 0, passedOutput);
});

test('@ac AC-04 @case AC-04.2 a temporary typecheck fixture that assigns a task without taskId to the DagTask type fails tsc', () => {
	const dagSchemaImportPath = DAG_SCHEMA_TS_PATH.split(path.sep).join('/');
	const invalidFixture = [
		`import type { DagTask } from '${dagSchemaImportPath}';`,
		'export const invalidTask: DagTask = {',
		"\ttitle: 'Missing taskId',",
		"\ttargetPackage: 'tools',",
		"\tpathPrefixes: ['tools/agent-sdlc'],",
		'\tdependsOn: [],',
		"\tstatus: 'pending',",
		'\tintegrationOrder: 0,',
		"\tworktreeSubdir: 'worktrees/missing-id',",
		"\tbaseCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',",
		'\tparentTreeSha: null,',
		'\tparentCommitSha: null,',
		'\ttargetTreeSha: null,',
		'\tpatchHash: null,',
		'\tfailurePacketArtifact: null,',
		'\trepairCount: 0,',
		'};',
		'',
	].join('\n');

	const failedResult = runTscOnTempFixture(invalidFixture);
	const failedOutput = `${failedResult.stdout ?? ''}\n${failedResult.stderr ?? ''}`;
	assert.notEqual(failedResult.status, 0, failedOutput);
	assert.match(failedOutput, /taskId/);
});
