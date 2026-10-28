import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import {
	NAVIGABILITY_BYTE_CEILING,
	NAVIGABILITY_LINE_CEILING,
} from './navigability-support.mjs';

const IS_STANDALONE = !fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/agent-sdlc'));
const PACKAGE_ROOT = IS_STANDALONE ? REPOSITORY_ROOT : path.join(REPOSITORY_ROOT, 'packages/agent-sdlc');
const PACKAGE_AGENTS_DOC = `${'AGENTS'}.md`;

const MODULE_README_FOLDERS = Object.freeze([
	'cli',
	'workflow',
	'execution',
	'review',
	'persistence',
	'policy',
	'roles',
	'adapters',
	'host',
	'ledger',
	'prompts',
]);

const CAPABILITY_FOLDERS = Object.freeze([
	'cli',
	'workflow',
	'execution',
	'review',
	'persistence',
	'policy',
	'roles',
	'adapters',
	'host',
	'ledger',
	'prompts',
]);

const TESTING_SPEC_FILES = Object.freeze([
	'living-docs.spec.mjs',
	'package-docs.spec.mjs',
	'host-docs.spec.mjs',
	'package-shape.spec.mjs',
	'layout.spec.mjs',
	'review-living-docs.spec.mjs',
]);

const MODULE_PATH = /packages\/agent-sdlc\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:mjs|ts)/g;

function missingModulePaths(packageRelPath) {
	const text = fs.readFileSync(path.join(PACKAGE_ROOT, packageRelPath), 'utf8');
	const missing = [];
	for (const line of text.split('\n')) {
		for (const modulePath of line.match(MODULE_PATH) ?? []) {
			const resolved =
				fs.existsSync(path.join(REPOSITORY_ROOT, modulePath)) ||
				(IS_STANDALONE &&
					fs.existsSync(
						path.join(PACKAGE_ROOT, modulePath.replace(/^packages\/agent-sdlc\//, '')),
					));
			if (resolved) continue;
			missing.push(modulePath);
		}
	}
	return missing;
}

function countNewlines(buffer) {
	let count = 0;
	for (let i = 0; i < buffer.length; i += 1) {
		if (buffer[i] === 10) count += 1;
	}
	return count;
}

test('@ac AC-03 @case AC-03.1 none of the 5 spec files in packages/agent-sdlc/testing/ contains monorepo handbook, retired spec, or root AGENTS.md references', () => {
	const forbiddenTokens = [
		`${'docs'}/${'handbook'}/`,
		`${'docs'}/${'specs'}/${'retired'}/`,
		`'${'AGENTS'}.${'md'}'`,
	];
	for (const specFile of TESTING_SPEC_FILES) {
		const text = fs.readFileSync(path.join(PACKAGE_ROOT, 'testing', specFile), 'utf8');
		for (const token of forbiddenTokens) {
			assert.equal(
				text.includes(token),
				false,
				`packages/agent-sdlc/testing/${specFile} must not contain ${token}`,
			);
		}
	}
});

test('@ac AC-03 @case AC-03.2 package README, ARCHITECTURE.md, and AGENTS.md module paths exist inside packages/agent-sdlc', () => {
	assert.deepEqual(missingModulePaths('README.md'), []);
	assert.deepEqual(missingModulePaths('ARCHITECTURE.md'), []);
	assert.deepEqual(missingModulePaths(PACKAGE_AGENTS_DOC), []);
});

test('@ac AC-02 @case AC-02.1 the package README names the capability folders', () => {
	const readme = fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');
	for (const folder of CAPABILITY_FOLDERS) {
		assert.match(readme, new RegExp(`^(?:├──|└──) ${folder}/`, 'm'), folder);
	}
});

test('AC-09: package README describes run retention, prune-runs, index.jsonl, and auto-prune with valid module paths', () => {
	const readme = fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');
	for (const snippet of [
		'prune-runs [--dry-run] [--json]',
		'index.jsonl',
		'unlanded.patch',
		'AGENT_SDLC_AUTO_PRUNE',
		'run-retention.ts',
		'run-cleanup.ts',
		'run-compaction.ts',
		'run-archive.ts',
		'landed-check.ts',
		'auto-prune.ts',
	]) {
		assert.equal(readme.includes(snippet), true, `README missing ${snippet}`);
	}
});

test('@ac AC-01 root packages/agent-sdlc/README.md and ARCHITECTURE.md stay within navigability ceilings and README links all module READMEs', () => {
	for (const docName of ['README.md', 'ARCHITECTURE.md']) {
		const docRaw = fs.readFileSync(path.join(PACKAGE_ROOT, docName));
		assert.ok(
			countNewlines(docRaw) <= NAVIGABILITY_LINE_CEILING,
			`packages/agent-sdlc/${docName} exceeds line ceiling: ${countNewlines(docRaw)}`,
		);
		assert.ok(
			docRaw.length <= NAVIGABILITY_BYTE_CEILING,
			`packages/agent-sdlc/${docName} exceeds byte ceiling: ${docRaw.length}`,
		);
	}
	const raw = fs.readFileSync(path.join(PACKAGE_ROOT, 'README.md'));
	const text = raw.toString('utf8');
	assert.equal(
		text.includes('(./ARCHITECTURE.md)'),
		true,
		'root README missing link to ./ARCHITECTURE.md',
	);
	for (const folder of MODULE_README_FOLDERS) {
		assert.equal(
			text.includes(`(./${folder}/README.md)`),
			true,
			`root README missing link to ./${folder}/README.md`,
		);
	}
});

test('@ac AC-02 feature module READMEs exist within navigability limits and are indexed in packages/agent-sdlc/AGENTS.md', () => {
	const agentsMd = fs.readFileSync(path.join(PACKAGE_ROOT, PACKAGE_AGENTS_DOC), 'utf8');
	for (const folder of MODULE_README_FOLDERS) {
		const relPath = `${folder}/README.md`;
		const absPath = path.join(PACKAGE_ROOT, relPath);
		assert.equal(fs.existsSync(absPath), true, `missing packages/agent-sdlc/${relPath}`);
		const raw = fs.readFileSync(absPath);
		assert.ok(
			countNewlines(raw) <= NAVIGABILITY_LINE_CEILING,
			`packages/agent-sdlc/${relPath} exceeds line ceiling: ${countNewlines(raw)}`,
		);
		assert.ok(
			raw.length <= NAVIGABILITY_BYTE_CEILING,
			`packages/agent-sdlc/${relPath} exceeds byte ceiling: ${raw.length}`,
		);
		assert.equal(
			agentsMd.includes(`./${folder}/README.md`),
			true,
			`packages/agent-sdlc/AGENTS.md missing ./${folder}/README.md`,
		);
	}
});

test('@ac AC-03 module READMEs contain no missing module paths or legacy tools/agent-sdlc or tools/model-usage paths', () => {
	const legacyPathPattern = /tools\/(?:agent-sdlc|model-usage)(?:\/|\b)/;
	for (const folder of MODULE_README_FOLDERS) {
		const relPath = `${folder}/README.md`;
		const missing = missingModulePaths(relPath);
		assert.deepEqual(missing, [], `packages/agent-sdlc/${relPath}`);
		const text = fs.readFileSync(path.join(PACKAGE_ROOT, relPath), 'utf8');
		assert.equal(
			legacyPathPattern.test(text),
			false,
			`packages/agent-sdlc/${relPath} contains legacy tools/agent-sdlc or tools/model-usage path`,
		);
	}
});

