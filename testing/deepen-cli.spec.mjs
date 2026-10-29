import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as cliEntry from '../cli/cli.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';
import { cleanupRun, slug } from './cli-test-support.mjs';
import {
	NAVIGABILITY_BYTE_CEILING,
	NAVIGABILITY_LINE_CEILING,
} from './navigability-support.mjs';
import { findLeakedTestRunArtifacts } from './test-support.mjs';

const AGENT_SDLC_ROOT = fs.existsSync(path.join(REPOSITORY_ROOT, 'packages/engine'))
	? path.join(REPOSITORY_ROOT, 'packages/engine')
	: REPOSITORY_ROOT;

function filesUnder(directory) {
	const found = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) continue;
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
			found.push(...filesUnder(full));
			continue;
		}
		if (entry.isFile()) found.push(full);
	}
	return found;
}

function importSpecifiers(source) {
	const specifiers = [];
	const pattern = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
	let match = pattern.exec(source);
	while (match) {
		specifiers.push(match[1]);
		match = pattern.exec(source);
	}
	return specifiers;
}

test('@ac AC-01 @case AC-01.4 the interactive terminal files are absent and nothing imports that path', () => {
	assert.equal(fs.existsSync(path.join(AGENT_SDLC_ROOT, 'cli/interactive-terminal.mjs')), false);
	assert.equal(fs.existsSync(path.join(AGENT_SDLC_ROOT, 'cli/interactive-terminal.spec.mjs')), false);
	const importers = [];
	for (const full of filesUnder(AGENT_SDLC_ROOT)) {
		if (!full.endsWith('.mjs') && !full.endsWith('.js') && !full.endsWith('.ts')) continue;
		const source = fs.readFileSync(full, 'utf8');
		for (const specifier of importSpecifiers(source)) {
			if (specifier.includes('interactive-terminal')) {
				importers.push(`${path.relative(REPOSITORY_ROOT, full)} -> ${specifier}`);
			}
		}
	}
	assert.deepEqual(importers, []);
});

test('@ac AC-01 @case AC-01.5 cli.mjs drops the dead exports and the README does not name the retired module', () => {
	assert.equal(Object.hasOwn(cliEntry, 'loadCriticReportForInterrupt'), false);
	assert.equal(Object.hasOwn(cliEntry, 'SESSION_TERMINATING_STATES'), false);
	const readme = fs.readFileSync(path.join(AGENT_SDLC_ROOT, 'README.md'), 'utf8');
	assert.equal(readme.includes('interactive-terminal.mjs'), false);
});

function newlineCount(data) {
	let count = 0;
	for (let index = 0; index < data.length; index += 1) {
		if (data[index] === 10) count += 1;
	}
	return count;
}

function cliAreaFiles() {
	const files = filesUnder(path.join(AGENT_SDLC_ROOT, 'cli')).filter(
		(full) => full.endsWith('.ts') || full.endsWith('.mjs'),
	);
	files.push(path.join(AGENT_SDLC_ROOT, 'policy/authorization.ts'));
	files.push(path.join(AGENT_SDLC_ROOT, 'policy/authorization.spec.mjs'));
	return files;
}

function resolvesToCliEntry(fromFile, specifier) {
	if (!specifier.startsWith('.')) return false;
	const resolved = path.normalize(path.join(path.dirname(fromFile), specifier));
	return resolved === path.join(AGENT_SDLC_ROOT, 'cli/cli.ts');
}

test('@ac AC-05 @case AC-05.1 every CLI-area file is within the ceiling', () => {
	const files = cliAreaFiles();
	assert.ok(files.length > 20);
	for (const full of files) {
		const data = fs.readFileSync(full);
		const rel = path.relative(REPOSITORY_ROOT, full);
		assert.ok(newlineCount(data) <= NAVIGABILITY_LINE_CEILING, `${rel} lines ${newlineCount(data)}`);
		assert.ok(data.length <= NAVIGABILITY_BYTE_CEILING, `${rel} bytes ${data.length}`);
	}
});

test('@ac AC-05 @case AC-05.2 the exceptions file names no CLI-area path', () => {
	const exceptions = JSON.parse(fs.readFileSync(path.join(AGENT_SDLC_ROOT, 'testing/navigability-exceptions.json'), 'utf8'));
	const banned = new Set(cliAreaFiles().map((full) => path.relative(REPOSITORY_ROOT, full)));
	for (const name of [
		'cli/cli.spec.mjs',
		'cli/status-projection.mjs',
		'cli/interactive-terminal.mjs',
		'cli/interactive-terminal.spec.mjs',
		'cli/shell-driver.spec.mjs',
		'cli/host-invocation.spec.mjs',
		'cli/progress.spec.mjs',
	]) {
		banned.add(path.join('packages/engine', name));
	}
	for (const rel of banned) {
		assert.equal(Object.hasOwn(exceptions, rel), false, rel);
	}
});

test('@ac AC-05 @case AC-05.3 a slug run id is a leak until cleanupRun removes it', () => {
	const runId = slug('ac-05');
	const directory = path.join(REPOSITORY_ROOT, 'tools/.agent-sdlc', runId);
	try {
		fs.mkdirSync(directory, { recursive: true });
		assert.ok(findLeakedTestRunArtifacts().some((entry) => entry.endsWith(runId)));
		cleanupRun(runId);
		assert.equal(findLeakedTestRunArtifacts().some((entry) => entry.endsWith(runId)), false);
	} finally {
		cleanupRun(runId);
	}
});

test('@ac AC-03 @case AC-03.1 command and leaf modules do not import cli.mjs', () => {
	const commandsDir = path.join(AGENT_SDLC_ROOT, 'cli/commands');
	const files = [
		...fs.readdirSync(commandsDir)
			.filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
			.map((name) => path.join(commandsDir, name)),
		path.join(AGENT_SDLC_ROOT, 'cli/arguments.ts'),
		path.join(AGENT_SDLC_ROOT, 'cli/run-context.ts'),
		path.join(AGENT_SDLC_ROOT, 'cli/human-result.ts'),
		path.join(AGENT_SDLC_ROOT, 'cli/exit-codes.ts'),
	];
	const hits = [];
	for (const file of files) {
		for (const specifier of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
			if (resolvesToCliEntry(file, specifier)) hits.push(path.relative(REPOSITORY_ROOT, file));
		}
	}
	assert.deepEqual(hits, []);
});
