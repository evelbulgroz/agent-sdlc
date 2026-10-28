import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	isSecretOrExcludedPath,
	isBinaryFile,
	extractDiffPaths,
	filterTrackedDiff,
	resolveContainedPath,
	collectCodeDiff,
	formatTerminalReport,
	runReviewCli,
} from './agent-review.ts';
import { REPOSITORY_ROOT } from '../persistence/run-paths.ts';

function makeFixtureDir(prefix) {
	const dir = path.join(REPOSITORY_ROOT, 'tools/.review', `${prefix}-${crypto.randomUUID().slice(0, 8)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

test('isSecretOrExcludedPath identifies secrets, certificates, and build artifacts', () => {
	// Secret configs & env
	assert.equal(isSecretOrExcludedPath('security-config'), true);
	assert.equal(isSecretOrExcludedPath('security-config/jwt-keys.json'), true);
	assert.equal(isSecretOrExcludedPath('apps/services/conditioning/src/conditioning.security.config.ts'), true);
	assert.equal(isSecretOrExcludedPath('.env'), true);
	assert.equal(isSecretOrExcludedPath('.env.local'), true);
	assert.equal(isSecretOrExcludedPath('.envrc'), true);
	assert.equal(isSecretOrExcludedPath('.env.example'), true);
	assert.equal(isSecretOrExcludedPath('apps/frontends/example-pwa-frontend/.env.example'), true);
	assert.equal(isSecretOrExcludedPath('apps/services/auth/.env.test'), true);

	// Key and cert files
	assert.equal(isSecretOrExcludedPath('keys/server.key'), true);
	assert.equal(isSecretOrExcludedPath('certs/cert.pem'), true);
	assert.equal(isSecretOrExcludedPath('ca.cert'), true);
	assert.equal(isSecretOrExcludedPath('intermediate.crt'), true);

	// Build and cache dirs
	assert.equal(isSecretOrExcludedPath('dist/index.js'), true);
	assert.equal(isSecretOrExcludedPath('apps/services/registry/dist/main.js'), true);
	assert.equal(isSecretOrExcludedPath('.cache/turbo/hash.tar.zst'), true);
	assert.equal(isSecretOrExcludedPath('coverage/lcov.info'), true);
	assert.equal(isSecretOrExcludedPath('node_modules/uuid/index.js'), true);

	// Allowed normal files
	assert.equal(isSecretOrExcludedPath('src/main.ts'), false);
	assert.equal(isSecretOrExcludedPath('tools/agent-sdlc/review/agent-review.mjs'), false);
	assert.equal(isSecretOrExcludedPath('docs/specs/my-spec.md'), false);
	assert.equal(isSecretOrExcludedPath('packages/ddd-base/package.json'), false);

	// Non-string or malformed
	assert.equal(isSecretOrExcludedPath(null), true);
	assert.equal(isSecretOrExcludedPath(undefined), true);
});

test('isBinaryFile detects binary extensions and null-byte buffer contents', () => {
	const tmpDir = makeFixtureDir('review-bin-test');
	try {
		const pngFile = path.join(tmpDir, 'image.png');
		const wasmFile = path.join(tmpDir, 'module.wasm');
		const txtFile = path.join(tmpDir, 'sample.txt');
		const nullByteFile = path.join(tmpDir, 'payload.dat');

		fs.writeFileSync(pngFile, 'fake-png-data');
		fs.writeFileSync(wasmFile, 'fake-wasm-data');
		fs.writeFileSync(txtFile, 'Hello, world! Normal text.');
		fs.writeFileSync(nullByteFile, Buffer.from([0x61, 0x62, 0x00, 0x63]));

		assert.equal(isBinaryFile(pngFile), true);
		assert.equal(isBinaryFile(wasmFile), true);
		assert.equal(isBinaryFile(txtFile), false);
		assert.equal(isBinaryFile(nullByteFile), true);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('extractDiffPaths extracts file paths from unquoted and quoted git diff headers', () => {
	const unquoted = 'a/src/main.ts b/src/main.ts';
	assert.deepEqual(extractDiffPaths(unquoted), { relA: 'src/main.ts', relB: 'src/main.ts' });

	const quoted = '"a/src/file with space.ts" "b/src/file with space.ts"';
	assert.deepEqual(extractDiffPaths(quoted), {
		relA: 'src/file with space.ts',
		relB: 'src/file with space.ts',
	});
});

test('filterTrackedDiff strips secret and binary hunks from tracked git diff output', () => {
	const sampleDiff = `diff --git a/src/index.ts b/src/index.ts
index 123..456 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-console.log('old');
+console.log('new');
diff --git a/apps/service/.env.example b/apps/service/.env.example
index 000..111 100644
--- a/apps/service/.env.example
+++ b/apps/service/.env.example
@@ -1 +1 @@
+SECRET=leak
diff --git a/security-config/keys.json b/security-config/keys.json
new file mode 100644
--- /dev/null
+++ b/security-config/keys.json
@@ -0,0 +1 @@
+{"key": "secret"}
diff --git a/docs/notes.md b/docs/notes.md
--- a/docs/notes.md
+++ b/docs/notes.md
@@ -1 +1 @@
+Binary files are stored in S3
diff --git a/assets/image.png b/assets/image.png
Binary files a/assets/image.png and b/assets/image.png differ`;

	const { diff, touchedFiles } = filterTrackedDiff(sampleDiff, REPOSITORY_ROOT);

	assert.ok(diff.includes('diff --git a/src/index.ts b/src/index.ts'));
	assert.ok(diff.includes("+console.log('new');"));
	assert.ok(diff.includes('Binary files are stored in S3'), 'Text line mentioning binary files must be kept');
	assert.equal(diff.includes('.env.example'), false, 'Tracked .env.example must be excluded');
	assert.equal(diff.includes('security-config'), false, 'Tracked security-config must be excluded');
	assert.equal(diff.includes('image.png'), false, 'Tracked binary files must be excluded');
	assert.deepEqual(touchedFiles, ['src/index.ts', 'docs/notes.md']);
});

test('collectCodeDiff collects tracked diff and untracked files with secret filters', () => {
	const tmpDir = makeFixtureDir('review-diff-test');
	try {
		// Create normal untracked file
		fs.writeFileSync(path.join(tmpDir, 'feature.ts'), 'export const active = true;\n');
		// Create secret untracked file
		fs.writeFileSync(path.join(tmpDir, '.env.secret'), 'SECRET=12345\n');
		// Create binary untracked file
		fs.writeFileSync(path.join(tmpDir, 'binary.dat'), Buffer.from([0x00, 0x01, 0x02]));

		const mockGitCli = (cmd, args) => {
			if (args[0] === 'diff') {
				return `diff --git a/existing.ts b/existing.ts
--- a/existing.ts
+++ b/existing.ts
@@ -1 +1 @@
-old
+new
diff --git a/.env.example b/.env.example
--- a/.env.example
+++ b/.env.example
@@ -1 +1 @@
+SECRET_TRACKED=bad`;
			}
			if (args[0] === 'ls-files') {
				return 'feature.ts\n.env.secret\nbinary.dat\n';
			}
			return '';
		};

		const result = collectCodeDiff({
			rootDir: tmpDir,
			gitCli: mockGitCli,
		});

		assert.ok(result.diff.includes('diff --git a/existing.ts b/existing.ts'));
		assert.ok(result.diff.includes('diff --git a/feature.ts b/feature.ts'));
		assert.ok(result.diff.includes('+export const active = true;'));
		assert.equal(result.diff.includes('SECRET_TRACKED=bad'), false, 'Tracked secret hunk must be stripped');
		assert.equal(result.diff.includes('SECRET=12345'), false, 'Untracked secret file must be excluded');
		assert.equal(result.diff.includes('binary.dat'), false, 'Untracked binary file must be excluded');
		assert.deepEqual(result.touchedFiles, ['existing.ts', 'feature.ts']);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test('collectCodeDiff fails closed when git CLI encounters an execution error', () => {
	const failingGitCli = (cmd, args) => {
		if (args[0] === 'diff') {
			throw new Error('fatal: not a git repository');
		}
		return '';
	};

	assert.throws(
		() => collectCodeDiff({ rootDir: REPOSITORY_ROOT, gitCli: failingGitCli }),
		(err) => err.code === 'CRITIC_REVIEW_FAILED' && err.message.includes('Git diff execution failed'),
	);

	const failingLsFiles = (cmd, args) => {
		if (args[0] === 'diff') return '';
		if (args[0] === 'ls-files') throw new Error('permission denied');
		return '';
	};

	assert.throws(
		() => collectCodeDiff({ rootDir: REPOSITORY_ROOT, gitCli: failingLsFiles }),
		(err) => err.code === 'CRITIC_REVIEW_FAILED' && err.message.includes('Git ls-files execution failed'),
	);
});

test('collectCodeDiff forwards scope to both git diff and git ls-files', () => {
	const calls = [];
	const mockGitCli = (cmd, args) => {
		calls.push({ cmd, args });
		return '';
	};

	collectCodeDiff({
		rootDir: REPOSITORY_ROOT,
		scope: 'packages/ddd-base',
		gitCli: mockGitCli,
	});

	assert.equal(calls.length, 2);
	assert.ok(calls[0].args.includes('packages/ddd-base'));
	assert.ok(calls[1].args.includes('packages/ddd-base'));
});

test('resolveContainedPath rejects path escapes, sibling prefixes, symlinks, and secrets', () => {
	const fixtureDir = makeFixtureDir('containment-test');
	try {
		const validFile = path.join(fixtureDir, 'valid.md');
		fs.writeFileSync(validFile, '# Valid File\n');

		// Valid relative path
		const resolved = resolveContainedPath(REPOSITORY_ROOT, path.relative(REPOSITORY_ROOT, validFile));
		assert.equal(resolved.absPath, fs.realpathSync(validFile));

		// Missing path
		assert.throws(
			() => resolveContainedPath(REPOSITORY_ROOT, ''),
			(err) => err.code === 'INVALID_INPUT',
		);

		// Non-existent path
		assert.throws(
			() => resolveContainedPath(REPOSITORY_ROOT, 'nonexistent.md'),
			(err) => err.code === 'INVALID_INPUT' && err.message.includes('file not found'),
		);

		// Sibling-prefix escape
		const siblingDir = `${REPOSITORY_ROOT}-evil`;
		assert.throws(
			() => resolveContainedPath(REPOSITORY_ROOT, path.join(siblingDir, 'test.md')),
			(err) => err.code === 'PATH_OUTSIDE_ROOT',
		);

		// Secret path
		assert.throws(
			() => resolveContainedPath(REPOSITORY_ROOT, 'security-config/test.json'),
			(err) => err.code === 'INVALID_INPUT' && err.message.includes('protected or secret path'),
		);

		// Symlink escaping root
		const outsideFile = path.join(os.tmpdir(), `outside-${crypto.randomUUID().slice(0, 8)}.md`);
		fs.writeFileSync(outsideFile, 'secret outside');
		const escapingSymlink = path.join(fixtureDir, 'escape-symlink.md');
		try {
			fs.symlinkSync(outsideFile, escapingSymlink);
			assert.throws(
				() => resolveContainedPath(REPOSITORY_ROOT, path.relative(REPOSITORY_ROOT, escapingSymlink)),
				(err) => err.code === 'PATH_OUTSIDE_ROOT',
			);
		} finally {
			if (fs.existsSync(outsideFile)) fs.unlinkSync(outsideFile);
		}
	} finally {
		fs.rmSync(fixtureDir, { recursive: true, force: true });
	}
});

test('formatTerminalReport formats PASS and FAIL outputs with appropriate severity tags', () => {
	const passResult = {
		status: 'PASS',
		phase: 'spec',
		runId: '2026-09-08-test-run',
		reviewerVendor: 'anthropic',
		reviewerModel: 'claude-3-7-sonnet',
		operationId: 'op-pass-1',
		reportPath: 'tools/.review/2026-09-08-test-run/g1-spec-report.json',
		findingsCount: 0,
		findings: [],
	};

	const passOutput = formatTerminalReport(passResult);
	assert.ok(passOutput.includes('=== Critic Review Result: PASS ==='));
	assert.ok(passOutput.includes('No findings identified'));

	const failResult = {
		status: 'FAIL',
		phase: 'code',
		runId: '2026-09-08-test-run',
		reviewerVendor: 'openai',
		reviewerModel: 'gpt-4o',
		operationId: 'op-fail-1',
		reportPath: 'tools/.review/2026-09-08-test-run/g1-code-report.json',
		findingsCount: 2,
		findings: [
			{
				severity: 'P1',
				category: 'security',
				file: 'src/auth.ts',
				lineRange: '10-15',
				evidence: 'Hardcoded secret token',
				impact: 'Credential leak',
				remediation: 'Inject from vault',
			},
			{
				severity: 'P2',
				category: 'correctness',
				file: 'src/data.ts',
				evidence: 'Missing null check',
				impact: 'Possible TypeError',
				remediation: 'Add optional chaining',
			},
		],
	};

	const failOutput = formatTerminalReport(failResult);
	assert.ok(failOutput.includes('=== Critic Review Result: FAIL ==='));
	assert.ok(failOutput.includes('[P1 - BLOCKING] (security)'));
	assert.ok(failOutput.includes('src/auth.ts:10-15'));
	assert.ok(failOutput.includes('Hardcoded secret token'));
	assert.ok(failOutput.includes('[P2 - ADVISORY] (correctness)'));
});

test('@ac AC-02 @case AC-02.1 runReviewCli prints help and returns 0 with --help', async () => {
	const logs = [];
	const originalLog = console.log;
	console.log = (...args) => logs.push(args.join(' '));

	try {
		const exitCode = await runReviewCli(['--help']);
		assert.equal(exitCode, 0);
		assert.ok(logs.join('\n').includes('Usage: agent-review --phase <spec|plan|code|qa> --author-vendor <vendor> [options]'));
	} finally {
		console.log = originalLog;
	}
});

test('runReviewCli validates required flags and inputs', async () => {
	// Missing phase
	await assert.rejects(
		() => runReviewCli(['--author-vendor', 'google']),
		(err) => err.code === 'INVALID_INPUT' && err.message.includes('--phase'),
	);

	// Invalid phase
	await assert.rejects(
		() => runReviewCli(['--phase', 'invalid', '--author-vendor', 'google']),
		(err) => err.code === 'INVALID_INPUT' && err.message.includes('--phase'),
	);

	// Missing author-vendor
	await assert.rejects(
		() => runReviewCli(['--phase', 'spec']),
		(err) => err.code === 'AUTHOR_VENDOR_UNKNOWN' && err.message.includes('--author-vendor'),
	);

	// Unknown author-vendor
	await assert.rejects(
		() => runReviewCli(['--phase', 'spec', '--author-vendor', 'unrecognized-vendor']),
		(err) => err.code === 'AUTHOR_VENDOR_UNKNOWN',
	);

	// Missing target for spec phase
	await assert.rejects(
		() => runReviewCli(['--phase', 'spec', '--author-vendor', 'google']),
		(err) => err.code === 'INVALID_INPUT' && err.message.includes('--target is required'),
	);

	// Non-existent target
	await assert.rejects(
		() =>
			runReviewCli([
				'--phase',
				'spec',
				'--author-vendor',
				'google',
				'--target',
				'non-existent-file.md',
			]),
		(err) => err.code === 'INVALID_INPUT' && err.message.includes('not found'),
	);

	// Secret target
	await assert.rejects(
		() =>
			runReviewCli([
				'--phase',
				'spec',
				'--author-vendor',
				'google',
				'--target',
				'security-config/foo.json',
			]),
		(err) => err.code === 'INVALID_INPUT' && err.message.includes('protected or secret path'),
	);

	// Target escaping repo root
	await assert.rejects(
		() =>
			runReviewCli([
				'--phase',
				'spec',
				'--author-vendor',
				'google',
				'--target',
				'../../etc/passwd',
			]),
		(err) => err.code === 'PATH_OUTSIDE_ROOT',
	);

	// Missing test-output for qa phase
	await assert.rejects(
		() =>
			runReviewCli([
				'--phase',
				'qa',
				'--author-vendor',
				'google',
				'--target',
				'README.md',
			]),
		(err) => err.code === 'INVALID_INPUT' && err.message.includes('--test-output is required'),
	);

	// Secret test-output for qa phase
	await assert.rejects(
		() =>
			runReviewCli([
				'--phase',
				'qa',
				'--author-vendor',
				'google',
				'--target',
				'README.md',
				'--test-output',
				'security-config/test.security.config.ts',
			]),
		(err) => err.code === 'INVALID_INPUT' && err.message.includes('protected or secret path'),
	);
});
