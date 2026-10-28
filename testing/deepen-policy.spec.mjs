import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = fs.existsSync(path.join(PACKAGE_ROOT, 'packages/agent-sdlc'))
	? PACKAGE_ROOT
	: path.resolve(PACKAGE_ROOT, '../../..');
const SDLC = fs.existsSync(path.join(ROOT, 'packages/agent-sdlc'))
	? path.join(ROOT, 'packages/agent-sdlc')
	: PACKAGE_ROOT;

function resolvePath(rel) {
	if (fs.existsSync(path.join(ROOT, rel))) return path.join(ROOT, rel);
	return path.join(SDLC, rel.replace(/^packages\/agent-sdlc\//, ''));
}

function measure(rel) {
	const data = fs.readFileSync(resolvePath(rel));
	let lines = 0;
	for (const byte of data) if (byte === 0x0a) lines += 1;
	return { lines, bytes: data.length };
}

function titles(rel) {
	const found = [];
	for (const line of fs.readFileSync(resolvePath(rel), 'utf8').split('\n')) {
		const match = line.match(/^test\('((?:\\'|[^'])*)'/);
		if (match) found.push(match[1]);
	}
	return found;
}

function productionFiles(dirRel) {
	return fs
		.readdirSync(resolvePath(dirRel))
		.filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts'))
		.sort()
		.map((name) => `${dirRel}/${name}`);
}

function specFiles(dirRel) {
	return fs
		.readdirSync(resolvePath(dirRel))
		.filter((name) => name.endsWith('.spec.mjs'))
		.sort()
		.map((name) => `${dirRel}/${name}`);
}

function relativeImports(rel) {
	const text = fs.readFileSync(resolvePath(rel), 'utf8');
	const found = [];
	for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
		found.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[1])));
	}
	return found;
}

function hasCycle(files) {
	const set = new Set(files);
	const graph = new Map(
		files.map((file) => [file, relativeImports(file).filter((item) => set.has(item))]),
	);
	const color = new Map();
	const visit = (node) => {
		const state = color.get(node) ?? 0;
		if (state === 1) return true;
		if (state === 2) return false;
		color.set(node, 1);
		for (const next of graph.get(node) ?? []) {
			if (visit(next)) return true;
		}
		color.set(node, 2);
		return false;
	};
	return files.some((file) => visit(file));
}

function assertWithinCeiling(files) {
	for (const rel of files) {
		const size = measure(rel);
		assert.ok(size.lines <= 500, `${rel} lines ${size.lines}`);
		assert.ok(size.bytes <= 20480, `${rel} bytes ${size.bytes}`);
	}
}

const reliabilityModules = [
	'packages/agent-sdlc/policy/reliability.ts',
	...productionFiles('packages/agent-sdlc/policy/reliability'),
];
const plannerModules = [
	'packages/agent-sdlc/policy/task-planner.ts',
	...productionFiles('packages/agent-sdlc/policy/task-planner'),
];

test('@ac AC-01 @case AC-01.1 the reliability facade and six submodules are within the ceiling', () => {
	assert.equal(reliabilityModules.length, 7);
	assertWithinCeiling(reliabilityModules);
});

test('@ac AC-01 @case AC-01.2 reliability submodules do not import the facade and have no cycle', () => {
	const modules = productionFiles('packages/agent-sdlc/policy/reliability');
	for (const rel of modules) {
		assert.equal(
			relativeImports(rel).includes('packages/agent-sdlc/policy/reliability.ts'),
			false,
			rel,
		);
	}
	assert.equal(hasCycle(modules), false);
});

test('@ac AC-04 @case AC-04.1 the task-planner facade and three submodules are within the ceiling', () => {
	assert.equal(plannerModules.length, 4);
	assertWithinCeiling(plannerModules);
});

test('@ac AC-04 @case AC-04.3 taskReaches is defined only in task-graph.mjs', () => {
	const definition = /(?:function|const)\s+taskReaches\b/;
	const closure = /(?:function|const)\s+(?:taskReaches|reaches)\b/;
	const hits = [];
	const isMonorepo = fs.existsSync(path.join(ROOT, 'packages/agent-sdlc'));
	const expected = isMonorepo
		? ['packages/agent-sdlc/policy/task-planner/task-graph.ts']
		: ['policy/task-planner/task-graph.ts'];
	const walk = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts') || entry.name.endsWith('.d.ts')) continue;
			if (definition.test(fs.readFileSync(full, 'utf8'))) {
				hits.push(
					isMonorepo
						? path.relative(ROOT, full).split(path.sep).join('/')
						: path.relative(SDLC, full).split(path.sep).join('/'),
				);
			}
		}
	};
	walk(path.join(SDLC, 'policy'));
	assert.deepEqual(hits, expected);
	for (const rel of [
		'packages/agent-sdlc/policy/task-planner.ts',
		'packages/agent-sdlc/policy/task-planner/task-readiness.ts',
	]) {
		assert.equal(closure.test(fs.readFileSync(resolvePath(rel), 'utf8')), false, rel);
	}
});

test('@ac AC-04 @case AC-04.5 no task-planner submodule imports the facade', () => {
	const modules = productionFiles('packages/agent-sdlc/policy/task-planner');
	for (const rel of modules) {
		assert.equal(
			relativeImports(rel).includes('packages/agent-sdlc/policy/task-planner.ts'),
			false,
			rel,
		);
	}
	assert.equal(hasCycle(modules), false);
});

test('@ac AC-07 @case AC-07.1 policy spec files in this split are within the ceiling', () => {
	assertWithinCeiling([
		'packages/agent-sdlc/policy/reliability.spec.mjs',
		'packages/agent-sdlc/policy/task-planner.spec.mjs',
		...specFiles('packages/agent-sdlc/policy/reliability'),
		...specFiles('packages/agent-sdlc/policy/task-planner'),
	]);
});

test('@ac AC-07 @case AC-07.2 exceptions omit the split reliability and task-planner paths', () => {
	const exceptions = JSON.parse(
		fs.readFileSync(path.join(SDLC, 'testing/navigability-exceptions.json'), 'utf8'),
	);
	for (const key of Object.keys(exceptions)) {
		assert.equal(key.includes('policy/reliability'), false, key);
		assert.equal(key.includes('policy/task-planner'), false, key);
	}
});

test('@ac AC-07 @case AC-07.3 facade spec titles are not repeated in a submodule spec', () => {
	const reliabilityTitles = new Set(titles('packages/agent-sdlc/policy/reliability.spec.mjs'));
	for (const rel of specFiles('packages/agent-sdlc/policy/reliability')) {
		for (const title of titles(rel)) assert.equal(reliabilityTitles.has(title), false, title);
	}
	const plannerTitles = new Set(titles('packages/agent-sdlc/policy/task-planner.spec.mjs'));
	for (const rel of specFiles('packages/agent-sdlc/policy/task-planner')) {
		for (const title of titles(rel)) assert.equal(plannerTitles.has(title), false, title);
	}
});
