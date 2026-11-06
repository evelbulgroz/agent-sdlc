// Shared mutation scorer: runs a produced spec against a reference module and hidden mutants in isolated temp dirs.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function scoreSpecAgainstVariants({ specPath, moduleFile, variants }) {
	const specSource = fs.readFileSync(specPath, 'utf8');
	const specFile = moduleFile.replace(/\.mjs$/, '.spec.mjs');
	const results = {};
	for (const [name, source] of Object.entries(variants)) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-oracle-'));
		try {
			fs.writeFileSync(path.join(dir, moduleFile), source);
			fs.writeFileSync(path.join(dir, specFile), specSource);
			const run = spawnSync(process.execPath, ['--test', path.join(dir, specFile)], {
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

export function exitCodeFor(report) {
	return !report.referencePasses ? 5 : report.survivors.length > 0 ? 4 : 0;
}
