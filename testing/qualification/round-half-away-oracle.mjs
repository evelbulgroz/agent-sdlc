// Offline scorer for qualification case N2b: runs a produced round-half-away spec against a reference and hidden mutants.
// Usage: node round-half-away-oracle.mjs <produced round-half-away.spec.mjs>. Exit 0 all killed, 4 survivors, 5 reference fails.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exitCodeFor, scoreSpecAgainstVariants } from './mutation-oracle-core.mjs';

const GUARD = `if (!Number.isFinite(value) || !Number.isInteger(digits) || digits < 0 || digits > 10) throw new RangeError('invalid');`;
// Decimal-exponent shifting, so ties such as 1.005 at 2 digits round away from zero as written.
const SHIFT = 'const shift = (n, d) => { const [c, e = "0"] = String(n).split("e"); return Number(`${c}e${Number(e) + d}`); };';
const body = (digitsExpr, magnitudeExpr, tail) =>
	`${SHIFT} const s = shift(${magnitudeExpr}, ${digitsExpr}); if (!Number.isFinite(s)) return value; const m = shift(Math.round(s), -(${digitsExpr})); ${tail}`;
const CORE = body('digits', 'Math.abs(value)', 'return m === 0 ? 0 : value < 0 ? -m : m;');
const make = (guard, core) =>
	`export function roundHalfAway(value, digits = 0) {\n${guard}\n${core}\n}\n`;

export const VARIANTS = Object.freeze({
	reference: make(GUARD, CORE),
	'negative-half-toward-positive': make(GUARD, body('digits', 'value', 'return m === 0 ? 0 : m;')),
	'negative-zero-returned': make(GUARD, body('digits', 'Math.abs(value)', 'return value < 0 ? -m : m;')),
	'digits-ignored': make(GUARD, body('0', 'Math.abs(value)', 'return m === 0 ? 0 : value < 0 ? -m : m;')),
	'non-finite-allowed': make(GUARD.replace('!Number.isFinite(value) || ', ''), CORE),
	'fractional-digits-allowed': make(GUARD.replace('!Number.isInteger(digits) || ', ''), CORE),
	'negative-digits-allowed': make(GUARD.replace(' || digits < 0', ''), CORE),
	'digits-cap-missing': make(GUARD.replace(' || digits > 10', ''), CORE),
	'wrong-error-type': make(GUARD.replace('RangeError', 'TypeError'), CORE),
});

export function scoreProducedSpec(specPath) {
	return scoreSpecAgainstVariants({ specPath, moduleFile: 'round-half-away.mjs', variants: VARIANTS });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const report = scoreProducedSpec(path.resolve(process.argv[2] ?? ''));
	console.log(JSON.stringify(report, null, 2));
	process.exit(exitCodeFor(report));
}
