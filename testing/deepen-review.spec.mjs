import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_STANDALONE = !fs.existsSync(path.join(PACKAGE_ROOT, 'packages/agent-sdlc'));
const ROOT = IS_STANDALONE ? PACKAGE_ROOT : path.resolve(PACKAGE_ROOT, '../../..');
const SDLC = IS_STANDALONE ? PACKAGE_ROOT : path.join(ROOT, 'packages/agent-sdlc');

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

function read(rel) {
	return fs.readFileSync(resolvePath(rel), 'utf8');
}

function relativeImports(rel) {
	const found = [];
	for (const match of read(rel).matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
		found.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), match[1])));
	}
	return found;
}

function exportedNames(rel) {
	const names = new Set();
	for (const match of read(rel).matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_]+)/gm)) {
		names.add(match[1]);
	}
	return names;
}

function productionFilesUnder(directory, found = []) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
			productionFilesUnder(path.join(directory, entry.name), found);
			continue;
		}
		if (
			(!entry.name.endsWith('.ts') && !entry.name.endsWith('.mjs')) ||
			entry.name.endsWith('.spec.mjs') ||
			entry.name.endsWith('.spec.ts') ||
			entry.name.endsWith('.d.ts') ||
			entry.name.endsWith('.d.mts')
		) {
			continue;
		}
		const rel = path.relative(SDLC, path.join(directory, entry.name)).split(path.sep).join('/');
		found.push(IS_STANDALONE ? `packages/agent-sdlc/${rel}` : path.relative(ROOT, path.join(directory, entry.name)).split(path.sep).join('/'));
	}
	return found;
}

const NEW_MODULES = [
	'packages/agent-sdlc/review/author-vendor.ts',
	'packages/agent-sdlc/review/critic-prompt.ts',
	'packages/agent-sdlc/review/critic-report-store.ts',
	'packages/agent-sdlc/review/critic-budget.ts',
	'packages/agent-sdlc/review/critic-input-packing.ts',
	'packages/agent-sdlc/review/failure-packet.ts',
	'packages/agent-sdlc/scripts/critic-trends-sources.ts',
];

const SPLIT_PRODUCTION = [
	...NEW_MODULES,
	'packages/agent-sdlc/review/critic-review.ts',
	'packages/agent-sdlc/review/critic-gate.ts',
	'packages/agent-sdlc/review/verifier.ts',
	'packages/agent-sdlc/scripts/aggregate-critic-trends.ts',
];

const SPLIT_SPECS = [
	'packages/agent-sdlc/review/critic-review.spec.mjs',
	'packages/agent-sdlc/review/critic-review.qa.spec.mjs',
	'packages/agent-sdlc/review/critic-review.grounding.spec.mjs',
	'packages/agent-sdlc/review/critic-review.generation.spec.mjs',
	'packages/agent-sdlc/review/author-vendor.spec.mjs',
	'packages/agent-sdlc/review/critic-prompt.spec.mjs',
	'packages/agent-sdlc/review/critic-report-store.spec.mjs',
	'packages/agent-sdlc/review/critic-gate.spec.mjs',
	'packages/agent-sdlc/review/critic-budget.spec.mjs',
	'packages/agent-sdlc/review/critic-input-packing.spec.mjs',
	'packages/agent-sdlc/review/verifier.spec.mjs',
	'packages/agent-sdlc/review/failure-packet.spec.mjs',
	'packages/agent-sdlc/scripts/critic-trends-sources.spec.mjs',
];

// A moved name may only be imported from the module that now owns it.
const MOVED = {
	'packages/agent-sdlc/review/critic-review.ts': [
		'canonicalizeAuthorVendor',
		'canonicalizeAuthorVendors',
		'CRITIC_FINDINGS_SCHEMA',
		'loadRubric',
		'sliceSafe',
		'truncatePromptToTokenCeiling',
	],
	'packages/agent-sdlc/review/critic-gate.ts': [
		'SPEC_CRITIC_CAP',
		'PLAN_CRITIC_CAP',
		'QA_CRITIC_CAP',
		'CODE_CRITIC_CAP',
		'specAttemptKey',
		'planAttemptKey',
		'qaAttemptKey',
		'assertCriticAllowed',
		'nextRound',
		'findingsFromExistingReview',
		'latestPhaseReview',
		'packPlanDocument',
		'derivePlanChangeClass',
		'SPEC_PACKING_TARGET_BYTES',
		'packSpecDocument',
		'packQaExcerpts',
		'detectHostVendor',
		'resolveAuthorVendor',
		'resolveCodeAuthorVendors',
	],
	'packages/agent-sdlc/review/verifier.ts': [
		'isEnvironmentFailure',
		'classifyFailure',
		'failureReferencesAuthorizedPackage',
		'enrichFailureOutputWithAuthorizedExcerpts',
		'buildFailurePacket',
	],
};

test('@ac AC-07 @case AC-07.1 the split modules and spec files are within 500 lines and 20,480 bytes', () => {
	for (const rel of [...SPLIT_PRODUCTION, ...SPLIT_SPECS]) {
		const size = measure(rel);
		assert.ok(size.lines <= 500, `${rel} lines ${size.lines}`);
		assert.ok(size.bytes <= 20480, `${rel} bytes ${size.bytes}`);
	}
});

test('@ac AC-07 @case AC-07.2 no split module or spec file is listed in the navigability exceptions', () => {
	const exceptions = JSON.parse(read('packages/agent-sdlc/testing/navigability-exceptions.json'));
	for (const rel of [...SPLIT_PRODUCTION, ...SPLIT_SPECS]) {
		assert.equal(rel in exceptions, false, rel);
	}
});

test('@ac AC-07 @case AC-07.3 new modules never import their former parent', () => {
	const forbidden = {
		'packages/agent-sdlc/review/author-vendor.ts': ['critic-review', 'critic-gate'],
		'packages/agent-sdlc/review/critic-prompt.ts': ['critic-review', 'critic-gate'],
		'packages/agent-sdlc/review/critic-report-store.ts': ['critic-review', 'critic-gate'],
		'packages/agent-sdlc/review/critic-budget.ts': ['critic-gate'],
		'packages/agent-sdlc/review/critic-input-packing.ts': ['critic-gate'],
		'packages/agent-sdlc/review/failure-packet.ts': ['verifier'],
		'packages/agent-sdlc/scripts/critic-trends-sources.ts': ['aggregate-critic-trends'],
	};
	for (const [rel, parents] of Object.entries(forbidden)) {
		const imports = relativeImports(rel).map((item) => path.posix.basename(item, '.ts'));
		for (const parent of parents) assert.equal(imports.includes(parent), false, `${rel} imports ${parent}`);
	}
});

test('@ac AC-07 @case AC-07.3 the split production modules form no import cycle', () => {
	const set = new Set(SPLIT_PRODUCTION);
	const graph = new Map(SPLIT_PRODUCTION.map((rel) => [rel, relativeImports(rel).filter((item) => set.has(item))]));
	const color = new Map();
	const visit = (node) => {
		const state = color.get(node) ?? 0;
		if (state === 1) return true;
		if (state === 2) return false;
		color.set(node, 1);
		for (const next of graph.get(node) ?? []) if (visit(next)) return true;
		color.set(node, 2);
		return false;
	};
	assert.equal(SPLIT_PRODUCTION.some((rel) => visit(rel)), false);
});

test('@ac AC-07 @case AC-07.4 no production file imports a moved name from its former parent and parents re-export none', () => {
	for (const rel of productionFilesUnder(IS_STANDALONE ? SDLC : path.join(SDLC, '..'))) {
		const dir = path.posix.dirname(rel);
		for (const match of read(rel).matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)'/g)) {
			const target = path.posix.normalize(path.posix.join(dir, match[2]));
			const moved = MOVED[target];
			if (!moved) continue;
			const names = match[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean);
			for (const name of names) assert.equal(moved.includes(name), false, `${rel} imports ${name} from ${target}`);
		}
	}
	for (const [parent, moved] of Object.entries(MOVED)) {
		const source = read(parent);
		assert.equal(/^export\s*(\*|\{[^}]*\})\s*from\s/m.test(source), false, `${parent} re-exports`);
		const exported = exportedNames(parent);
		for (const name of moved) assert.equal(exported.has(name), false, `${parent} exports ${name}`);
	}
});
