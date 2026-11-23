// Records the report file a passing task command already wrote. The path stays
// repository-relative. This module does not spawn and does not invent a file.

import fs from 'node:fs';
import path from 'node:path';

const REPORT_FILE = /\.(?:xml|json|tap)$/;

export function commandReportPath(
	worktreeDir: string,
	args: readonly string[],
	exitCode: number,
): string | null {
	if (exitCode !== 0) return null;
	const root = path.resolve(worktreeDir);
	for (const arg of args) {
		if (arg.startsWith('-') || path.isAbsolute(arg) || arg.split(/[\\/]/).includes('..')) continue;
		if (!REPORT_FILE.test(arg)) continue;
		const full = path.resolve(root, arg);
		const relative = path.relative(root, full);
		if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
		try {
			if (!fs.statSync(full).isFile()) continue;
		} catch {
			continue;
		}
		return relative.split(path.sep).join('/');
	}
	return null;
}
