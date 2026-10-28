// Ceiling check for tools/agent-sdlc and tools/model-usage.
// A file is within the ceiling at 500 newline bytes and 20,480 bytes.
// Callers pass the repository root and the exceptions object so tests can
// prove the rules on a temporary tree.

import fs from 'node:fs';
import path from 'node:path';

export const NAVIGABILITY_LINE_CEILING = 500;
export const NAVIGABILITY_BYTE_CEILING = 20_480;

const SCAN_ROOTS = ['packages/agent-sdlc', 'packages/model-usage'];

function isSpecFile(name) {
	return name.endsWith('.spec.mjs') || name.endsWith('.spec.ts');
}

function isCodeFile(name) {
	return name.endsWith('.mjs') || name.endsWith('.ts');
}

function isExempt(rel, name) {
	if (isSpecFile(name)) return false;
	if (rel.startsWith('packages/agent-sdlc/testing/')) return true;
	if (rel.startsWith('packages/model-usage/') && /-(support|child)\.(mjs|ts)$/.test(name)) return true;
	return false;
}

function newlineCount(data) {
	let count = 0;
	for (let index = 0; index < data.length; index += 1) {
		if (data[index] === 10) count += 1;
	}
	return count;
}

function walk(directory, relBase, files) {
	if (!fs.existsSync(directory)) return;
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
			walk(path.join(directory, entry.name), `${relBase}/${entry.name}`, files);
			continue;
		}
		if (!entry.isFile() || !isCodeFile(entry.name)) continue;
		const rel = `${relBase}/${entry.name}`;
		if (isExempt(rel, entry.name)) continue;
		const data = fs.readFileSync(path.join(directory, entry.name));
		files.push({ path: rel, lines: newlineCount(data), bytes: data.length });
	}
}

/**
 * @param {string} rootDir Repository root, or a temporary root with the same layout.
 * @param {Record<string, {lines: number, bytes: number}>} exceptions
 * @returns {{path: string, lines: number, bytes: number, reason: 'unlisted' | 'grown'}[]}
 */
export function findNavigabilityViolations(rootDir, exceptions) {
	if (exceptions === null || typeof exceptions !== 'object' || Array.isArray(exceptions)) {
		throw new TypeError('navigability exceptions must be an object');
	}
	const files = [];
	for (const relRoot of SCAN_ROOTS) {
		walk(path.join(rootDir, relRoot), relRoot, files);
	}
	const violations = [];
	for (const file of files) {
		const recorded = exceptions[file.path];
		if (recorded) {
			const recordedLines = Number(recorded.lines);
			const recordedBytes = Number(recorded.bytes);
			if (file.lines > recordedLines || file.bytes > recordedBytes) {
				violations.push({
					path: file.path,
					lines: file.lines,
					bytes: file.bytes,
					reason: 'grown',
				});
			}
			continue;
		}
		if (file.lines > NAVIGABILITY_LINE_CEILING || file.bytes > NAVIGABILITY_BYTE_CEILING) {
			violations.push({
				path: file.path,
				lines: file.lines,
				bytes: file.bytes,
				reason: 'unlisted',
			});
		}
	}
	violations.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
	return violations;
}
