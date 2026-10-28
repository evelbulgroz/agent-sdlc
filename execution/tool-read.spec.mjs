import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
	readFileTool,
} from './tool-read.ts';
import {
	grepTool,
} from './tool-search.ts';
import {
	writeFileTool,
} from './tool-mutations.ts';
import {
	runCommandTool,
} from './tool-commands.ts';
import {
	executeTool,
} from './tools.ts';
import {
	WHOLE_FILE_READ_BYTE_CAP,
} from './read-window.ts';
import {
	REPOSITORY_ROOT,
} from '../persistence/run-paths.ts';
function createTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-tools-test-'));
}
test('readFileTool and writeFileTool create, read, and hash file content', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = tempDir;
		const allowedPathPrefixes = ['apps/services/conditioning'];
		// Write file
		const writeRes = writeFileTool(
			{ path: 'apps/services/conditioning/test.txt', content: 'hello world' },
			{ worktreeDir, allowedPathPrefixes },
		);
		assert.equal(writeRes.written, true);
		assert.equal(writeRes.byteLength, 11);
		assert.ok(typeof writeRes.hash === 'string' && writeRes.hash.length === 64);
		// Read file
		const readRes = readFileTool(
			{ path: 'apps/services/conditioning/test.txt' },
			{ worktreeDir },
		);
		assert.equal(readRes.content, 'hello world');
		assert.equal(readRes.byteLength, 11);
		assert.equal(
			readRes.hash,
			crypto.createHash('sha256').update('hello world', 'utf8').digest('hex'),
		);
		// Read non-existent
		assert.throws(
			() => readFileTool({ path: 'apps/services/conditioning/missing.txt' }, { worktreeDir }),
			(err) => err.code === 'INVALID_INPUT',
		);
		assert.equal(readRes.truncated, false);
		assert.equal(readRes.shownStartLine, 1);
		assert.equal(readRes.totalLines, 1);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
test('readFileTool returns a bounded window and a later window keeps the whole-file hash', () => {
	const tempDir = createTempDir();
	try {
		const relPath = 'apps/services/conditioning/src/long.ts';
		fs.mkdirSync(path.dirname(path.join(tempDir, relPath)), { recursive: true });
		const lines = Array.from({ length: 400 }, (_, index) => `export const value${index} = ${index};`);
		const full = `${lines.join('\n')}\n`;
		fs.writeFileSync(path.join(tempDir, relPath), full);
		const first = readFileTool({ path: relPath }, { worktreeDir: tempDir });
		assert.equal(first.byteLength, Buffer.byteLength(full, 'utf8'));
		assert.equal(
			first.hash,
			crypto.createHash('sha256').update(full, 'utf8').digest('hex'),
		);
		assert.equal(first.totalLines, 401);
		assert.equal(first.shownStartLine, 1);
		assert.equal(first.truncated, true);
		assert.ok(first.shownEndLine > 2 && first.shownEndLine < 401);
		assert.equal(first.content.split('\n').length, first.shownEndLine - 1);
		const second = readFileTool(
			{ path: relPath, start_line: first.shownEndLine },
			{ worktreeDir: tempDir },
		);
		assert.equal(second.shownStartLine, first.shownEndLine);
		assert.equal(second.hash, first.hash);
		assert.notEqual(second.content, first.content);
		assert.throws(
			() => readFileTool({ path: relPath, start_line: 0 }, { worktreeDir: tempDir }),
			/start_line must be an integer/,
		);
		assert.throws(
			() =>
				readFileTool(
					{ path: relPath, start_line: 2, end_line: 2 },
					{ worktreeDir: tempDir },
				),
			/end_line must be an integer/,
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('readFileTool resolves a unique same-stem TypeScript source correction', () => {
	const tempDir = createTempDir();
	try {
		const domainDir = path.join(
			tempDir,
			'apps/frontends/fitnessapp-pwa-frontend/src/domain',
		);
		fs.mkdirSync(domainDir, { recursive: true });
		fs.writeFileSync(path.join(domainDir, 'conditioning-log.ts'), 'export const log = true;\n');

		const result = readFileTool(
			{
				path: 'apps/frontends/fitnessapp-pwa-frontend/src/domain/ConditioningLog.js',
			},
			{ worktreeDir: tempDir },
		);
		assert.equal(result.content, 'export const log = true;\n');
		assert.equal(
			result.requestedPath,
			'apps/frontends/fitnessapp-pwa-frontend/src/domain/ConditioningLog.js',
		);
		assert.equal(
			result.resolvedPath,
			'apps/frontends/fitnessapp-pwa-frontend/src/domain/conditioning-log.ts',
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('readFileTool rejects ambiguous same-stem source corrections', () => {
	const tempDir = createTempDir();
	try {
		const domainDir = path.join(
			tempDir,
			'apps/frontends/fitnessapp-pwa-frontend/src/domain',
		);
		fs.mkdirSync(domainDir, { recursive: true });
		fs.writeFileSync(path.join(domainDir, 'conditioning-log.ts'), 'export const ts = true;\n');
		fs.writeFileSync(path.join(domainDir, 'conditioning_log.tsx'), 'export const tsx = true;\n');

		assert.throws(
			() =>
				readFileTool(
					{
						path: 'apps/frontends/fitnessapp-pwa-frontend/src/domain/ConditioningLog.js',
					},
					{ worktreeDir: tempDir },
				),
			(error) =>
				error.code === 'INVALID_INPUT' &&
				/Did you mean/.test(error.message) &&
				/Do not repeat/.test(error.message),
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-12 find_files query and whole-file read stay inside the authorized tree', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = path.join(tempDir, 'worktree');
		const specs = path.join(worktreeDir, 'specs');
		fs.mkdirSync(specs, { recursive: true });
		const sibling = path.join(specs, 'sibling.spec.ts');
		const full = `${'export const pad = 1;\n'.repeat(500)}export const marker = "SIBLING_NEEDLE";\n`;
		fs.writeFileSync(sibling, full);
		fs.writeFileSync(path.join(specs, 'other.ts'), 'export const other = 1;\n');
		const found = executeTool({ toolName: 'find_files', parameters: { path: 'specs', query: 'SIBLING_NEEDLE' }, worktreeDir: worktreeDir });
		assert.equal(found.matches.length, 1);
		assert.equal(found.matches[0].path, 'specs/sibling.spec.ts');
		assert.equal(found.matches[0].line, 501);
		assert.match(found.matches[0].text, /SIBLING_NEEDLE/);
		const read = readFileTool({ path: 'specs/sibling.spec.ts' }, { worktreeDir, wholeFile: true });
		assert.equal(read.content, full);
		assert.equal(read.truncated, false);
		assert.ok(read.content.length > 8000);
		assert.throws(
			() =>
				writeFileTool(
					{ path: 'specs/sibling.spec.ts', content: 'export const overwritten = true;\n' },
					{ worktreeDir, allowedPathPrefixes: ['src'] },
				),
			(error) => /not within authorized|outside|prefix/i.test(error.message),
		);
		assert.equal(fs.readFileSync(sibling, 'utf8'), full);
		assert.equal(read.content.includes('SIBLING_NEEDLE'), true);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-12 @case AC-12.1 list_dir returns the sibling name and writes nothing', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = path.join(tempDir, 'worktree');
		const specs = path.join(worktreeDir, 'specs');
		fs.mkdirSync(specs, { recursive: true });
		const sibling = path.join(specs, 'sibling.spec.ts');
		fs.writeFileSync(sibling, 'export const sibling = true;\n');
		const listed = executeTool({ toolName: 'list_dir', parameters: { path: 'specs' }, worktreeDir: worktreeDir });
		assert.ok(listed.entries.includes('sibling.spec.ts'));
		assert.equal(fs.readFileSync(sibling, 'utf8'), 'export const sibling = true;\n');
		assert.equal(listed.entries.includes('sibling.spec.ts'), true);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.1 a 724-line read with pageOverflow returns every line', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = path.join(tempDir, 'worktree');
		fs.mkdirSync(worktreeDir);
		const lines = Array.from({ length: 724 }, (_, index) => `line-${index}`);
		let content = lines.join('\n');
		const pad = 20_000 - Buffer.byteLength(content, 'utf8');
		assert.ok(pad >= 0);
		content += 'x'.repeat(pad);
		fs.writeFileSync(path.join(worktreeDir, 'wide.txt'), content);
		const read = readFileTool({ path: 'wide.txt' }, { worktreeDir, pageOverflow: true });
		assert.equal(read.content, content);
		assert.equal(read.content.split('\n').length, 724);
		assert.equal(read.truncated, false);
		assert.equal(read.pagedPath, null);
		assert.equal(Buffer.byteLength(content, 'utf8'), 20_000);
		const windowed = readFileTool({ path: 'wide.txt' }, { worktreeDir });
		assert.equal(windowed.truncated, true);
		assert.ok(windowed.content.length < content.length);
		const whole = readFileTool(
			{ path: 'wide.txt', start_line: 41, end_line: 81 },
			{ worktreeDir, wholeFile: true },
		);
		assert.equal(whole.content, content);
		assert.equal(whole.shownStartLine, 1);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.2 paged command output keeps every byte and a later range read returns those lines', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = path.join(tempDir, 'worktree');
		fs.mkdirSync(worktreeDir);
		const lines = [];
		let size = 0;
		let number = 1;
		while (size < 100_000) {
			const line = `L${String(number).padStart(5, '0')}\n`;
			lines.push(line);
			size += Buffer.byteLength(line);
			number += 1;
		}
		const output = Buffer.from(lines.join(''), 'utf8').subarray(0, 100_000).toString('utf8');
		assert.equal(Buffer.byteLength(output, 'utf8'), 100_000);
		let started = false;
		const result = runCommandTool(
			{ command: 'pnpm', args: ['run', 'agent:test-sdlc'] },
			{
				worktreeDir,
				pageOverflow: true,
				execCli: () => {
					started = true;
					return output;
				},
			},
		);
		assert.equal(started, true);
		assert.match(result.stdout, /^\.tmp\/executor-pages\//);
		assert.match(result.stdout, /L00001/);
		const pageFile = path.join(worktreeDir, result.pagedPath);
		assert.equal(fs.readFileSync(pageFile, 'utf8'), output);
		const previewLines = result.stdout.split('\n');
		assert.ok(previewLines.slice(1, 41).some((line) => line.startsWith('L00001')));
		assert.ok(previewLines.slice(-40).length === 40);
		const ranged = readFileTool(
			{ path: result.pagedPath, start_line: 41, end_line: 81 },
			{ worktreeDir, pageOverflow: true },
		);
		assert.match(ranged.content, /L00041/);
		assert.match(ranged.content, /L00080/);
		assert.doesNotMatch(ranged.content, /L00081/);
		assert.equal(ranged.pagedPath, null);
		const before = fs.readdirSync(path.join(worktreeDir, '.tmp/executor-pages'));
		const fullPage = readFileTool({ path: result.pagedPath }, { worktreeDir, pageOverflow: true });
		assert.equal(fullPage.pagedPath, null);
		assert.equal(fullPage.content, output);
		const after = fs.readdirSync(path.join(worktreeDir, '.tmp/executor-pages'));
		assert.deepEqual(after, before);
		const ignored = execFileSync('git', ['check-ignore', result.pagedPath], {
			cwd: REPOSITORY_ROOT,
			encoding: 'utf8',
		}).trim();
		assert.equal(ignored, result.pagedPath);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('@ac AC-03 @case AC-03.3 grep returns a matching line and an empty list when nothing matches', () => {
	const tempDir = createTempDir();
	try {
		const worktreeDir = path.join(tempDir, 'worktree');
		fs.mkdirSync(path.join(worktreeDir, 'src'), { recursive: true });
		fs.writeFileSync(path.join(worktreeDir, 'src/note.txt'), 'alpha\nNEEDLE here\nomega\n');
		const found = grepTool({ path: 'src/note.txt', pattern: 'NEEDLE' }, { worktreeDir });
		assert.equal(found.matches.length, 1);
		assert.equal(found.matches[0].line, 2);
		assert.match(found.matches[0].text, /NEEDLE/);
		const none = grepTool({ path: 'src/note.txt', pattern: 'ABSENT_TOKEN' }, { worktreeDir });
		assert.deepEqual(none.matches, []);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('readFileTool wholeFile still returns a file larger than the lean cap', () => {
	const tempDir = createTempDir();
	try {
		const relPath = 'apps/services/demo/src/big.ts';
		fs.mkdirSync(path.dirname(path.join(tempDir, relPath)), { recursive: true });
		const content = 'x'.repeat(WHOLE_FILE_READ_BYTE_CAP + 1);
		fs.writeFileSync(path.join(tempDir, relPath), content);
		const result = readFileTool({ path: relPath }, { worktreeDir: tempDir, wholeFile: true });
		assert.equal(result.truncated, false);
		assert.equal(result.content.length, content.length);
		assert.equal(result.byteLength, WHOLE_FILE_READ_BYTE_CAP + 1);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('readFileTool returns a unique worktree candidate when the parent directory is missing', () => {
	const tempDir = createTempDir();
	try {
		const realPath = 'apps/services/authentication/src/authentication.service.ts';
		fs.mkdirSync(path.dirname(path.join(tempDir, realPath)), { recursive: true });
		fs.writeFileSync(path.join(tempDir, realPath), 'export class AuthenticationService {}\n');
		const decoy = 'node_modules/pkg/authentication.service.ts';
		fs.mkdirSync(path.dirname(path.join(tempDir, decoy)), { recursive: true });
		fs.writeFileSync(path.join(tempDir, decoy), 'export const decoy = true;\n');
		assert.throws(
			() =>
				readFileTool(
					{ path: 'apps/services/authentication/src/tokens/authentication.service.ts' },
					{ worktreeDir: tempDir },
				),
			(error) => {
				assert.equal(error.code, 'INVALID_INPUT');
				assert.match(error.message, /does not exist/);
				assert.match(error.message, new RegExp(`Did you mean '${realPath}'`));
				assert.match(error.message, /Do not repeat/);
				assert.equal(error.metadata.candidatePath, realPath);
				assert.equal(error.metadata.candidates, undefined);
				return true;
			},
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('readFileTool reports no candidate when nothing in the worktree matches', () => {
	const tempDir = createTempDir();
	try {
		fs.mkdirSync(tempDir, { recursive: true });
		assert.throws(
			() =>
				readFileTool(
					{ path: 'apps/services/authentication/src/missing/no-such-service.ts' },
					{ worktreeDir: tempDir },
				),
			(error) => {
				assert.match(error.message, /list_dir or find_files/);
				assert.doesNotMatch(error.message, /Did you mean/);
				assert.equal(error.metadata.candidatePath, undefined);
				return true;
			},
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('readFileTool lists several worktree candidates and does not pick one', () => {
	const tempDir = createTempDir();
	try {
		const first = 'apps/services/authentication/src/a/authentication.service.ts';
		const second = 'apps/services/authentication/src/b/authentication.service.ts';
		for (const relPath of [first, second]) {
			fs.mkdirSync(path.dirname(path.join(tempDir, relPath)), { recursive: true });
			fs.writeFileSync(path.join(tempDir, relPath), 'export const value = 1;\n');
		}
		assert.throws(
			() =>
				readFileTool(
					{ path: 'apps/services/authentication/src/missing/authentication.service.ts' },
					{ worktreeDir: tempDir },
				),
			(error) => {
				assert.equal(error.metadata.candidatePath, undefined);
				assert.deepEqual(error.metadata.candidates, [first, second]);
				assert.match(error.message, /Did you mean/);
				assert.doesNotMatch(error.message, /matches\)/);
				return true;
			},
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('readFileTool does not claim a unique candidate when more than five stems match', () => {
	const tempDir = createTempDir();
	try {
		const paths = [];
		for (let index = 0; index < 6; index += 1) {
			const relPath = `apps/services/authentication/src/dir-${index}/authentication.service.ts`;
			paths.push(relPath);
			fs.mkdirSync(path.dirname(path.join(tempDir, relPath)), { recursive: true });
			fs.writeFileSync(path.join(tempDir, relPath), 'export const value = 1;\n');
		}
		assert.throws(
			() =>
				readFileTool(
					{ path: 'apps/services/authentication/src/missing/authentication.service.ts' },
					{ worktreeDir: tempDir },
				),
			(error) => {
				assert.equal(error.metadata.candidatePath, undefined);
				assert.equal(error.metadata.candidates.length, 5);
				assert.match(error.message, /6 matches/);
				return true;
			},
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('readFileTool keeps an ambiguous same-directory correction local', () => {
	const tempDir = createTempDir();
	try {
		const domainDir = path.join(tempDir, 'apps/services/demo/src/domain');
		const elsewhere = path.join(tempDir, 'apps/services/demo/src/elsewhere');
		fs.mkdirSync(domainDir, { recursive: true });
		fs.mkdirSync(elsewhere, { recursive: true });
		fs.writeFileSync(path.join(domainDir, 'conditioning-log.ts'), 'export const ts = true;\n');
		fs.writeFileSync(path.join(domainDir, 'conditioning_log.tsx'), 'export const tsx = true;\n');
		fs.writeFileSync(path.join(elsewhere, 'conditioning-log.mjs'), 'export const other = true;\n');
		assert.throws(
			() =>
				readFileTool(
					{ path: 'apps/services/demo/src/domain/ConditioningLog.js' },
					{ worktreeDir: tempDir },
				),
			(error) => {
				assert.match(error.message, /Did you mean/);
				assert.match(error.message, /domain\/conditioning-log\.ts/);
				assert.doesNotMatch(error.message, /elsewhere/);
				assert.equal(error.metadata.candidatePath, undefined);
				return true;
			},
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('readFileTool still auto-reads the same-directory source when another stem match exists', () => {
	const tempDir = createTempDir();
	try {
		const domainDir = path.join(tempDir, 'apps/services/demo/src/domain');
		const elsewhere = path.join(tempDir, 'apps/services/demo/src/elsewhere');
		fs.mkdirSync(domainDir, { recursive: true });
		fs.mkdirSync(elsewhere, { recursive: true });
		fs.writeFileSync(path.join(domainDir, 'conditioning-log.ts'), 'export const local = true;\n');
		fs.writeFileSync(path.join(elsewhere, 'conditioning-log.ts'), 'export const other = true;\n');
		const result = readFileTool(
			{ path: 'apps/services/demo/src/domain/ConditioningLog.js' },
			{ worktreeDir: tempDir },
		);
		assert.equal(result.content, 'export const local = true;\n');
		assert.equal(result.resolvedPath, 'apps/services/demo/src/domain/conditioning-log.ts');
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
