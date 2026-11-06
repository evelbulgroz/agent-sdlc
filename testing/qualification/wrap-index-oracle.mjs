// Offline scorer for qualification case N2: runs a produced wrap-index spec against a reference and hidden mutants.
// Usage: node wrap-index-oracle.mjs <produced wrap-index.spec.mjs>. Exit 0 all mutants killed, 4 survivors, 5 reference fails.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const GUARD = `if (!Number.isInteger(length) || length <= 0 || !Number.isInteger(index)) throw new RangeError('invalid');`;
const body = (guard, expr) =>
	`export function wrapIndex(index, length) {\n${guard}\nreturn ${expr};\n}\n`;

export const VARIANTS = Object.freeze({
	reference: body(GUARD, '((index % length) + length) % length + 0'),
	'negative-not-wrapped': body(GUARD, 'index % length'),
	'multiple-returns-length': body(GUARD, 'index % length === 0 && index !== 0 ? length : ((index % length) + length) % length'),
	'zero-length-allowed': body(GUARD.replace('length <= 0', 'length < 0'), '((index % length) + length) % length'),
	'wrong-error-type': body(GUARD.replace('RangeError', 'TypeError'), '((index % length) + length) % length'),
	'fractional-index-allowed': body(GUARD.replace(' || !Number.isInteger(index)', ''), '((index % length) + length) % length'),
	'negative-length-allowed': body(GUARD.replace('length <= 0', 'length === 0'), '((index % length) + length) % length'),
});

export function scoreProducedSpec(specPath) {
	const specSource = fs.readFileSync(specPath, 'utf8');
	const results = {};
	for (const [name, source] of Object.entries(VARIANTS)) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2-oracle-'));
		try {
			fs.writeFileSync(path.join(dir, 'wrap-index.mjs'), source);
			fs.writeFileSync(path.join(dir, 'wrap-index.spec.mjs'), specSource);
			const run = spawnSync(process.execPath, ['--test', path.join(dir, 'wrap-index.spec.mjs')], {
				encoding: 'utf8',
				timeout: 60_000,
				// An inherited test context makes the child report success without running assertions.
				env: { ...process.env, NODE_TEST_CONTEXT: undefined },
			});
			results[name] = run.status === 0 ? 'passed' : 'failed';
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
	const survivors = Object.entries(results)
		.filter(([name, status]) => name !== 'reference' && status === 'passed')
		.map(([name]) => name);
	return { referencePasses: results.reference === 'passed', survivors, results };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const report = scoreProducedSpec(path.resolve(process.argv[2] ?? ''));
	console.log(JSON.stringify(report, null, 2));
	process.exit(!report.referencePasses ? 5 : report.survivors.length > 0 ? 4 : 0);
}
