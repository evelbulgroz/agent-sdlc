// Offline scorer for qualification case N2: runs a produced wrap-index spec against a reference and hidden mutants.
// Usage: node wrap-index-oracle.mjs <produced wrap-index.spec.mjs>. Exit 0 all mutants killed, 4 survivors, 5 reference fails.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exitCodeFor, scoreSpecAgainstVariants } from './mutation-oracle-core.mjs';

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
	return scoreSpecAgainstVariants({ specPath, moduleFile: 'wrap-index.mjs', variants: VARIANTS });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const report = scoreProducedSpec(path.resolve(process.argv[2] ?? ''));
	console.log(JSON.stringify(report, null, 2));
	process.exit(exitCodeFor(report));
}
