import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AdapterRegistration, EvidenceReport } from '../policy/contracts/quality-schema.ts';
import { verifyCommandRegistration } from './command-evidence.ts';

export function hashEvidenceBytes(bytes: Buffer): string {
	return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function assertEvidenceDirectory(directory: string): void {
	if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) {
		throw new Error('invalid-engine-directory');
	}
	let current = path.parse(directory).root;
	for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe-directory');
	}
}

export function readEvidenceFile(root: string, relative: string, maxBytes: number): Buffer {
	if (!relative || relative.includes('\\') || relative.includes('\0') ||
		path.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
		throw new Error('unsafe-file-path');
	}
	assertEvidenceDirectory(root);
	let current = root;
	const segments = relative.split('/');
	for (const [index, segment] of segments.entries()) {
		current = path.join(current, segment);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
			throw new Error('unsafe-file-path');
		}
	}
	const descriptor = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile() || stat.size > maxBytes) throw new Error('invalid-file-size-or-kind');
		// The native realpath is one libc call, versus one lstat per segment in the JS implementation.
		if (fs.realpathSync.native(current) !== current) throw new Error('unsafe-file-path');
		const bytes = fs.readFileSync(descriptor);
		if (bytes.length > maxBytes) throw new Error('invalid-file-size-or-kind');
		return bytes;
	} finally {
		fs.closeSync(descriptor);
	}
}

export function verifyEvidenceRegistration(root: string, registration: AdapterRegistration): void {
	verifyCommandRegistration(root, registration);
}

export function verifyEvidenceArtifacts(
	directory: string,
	report: EvidenceReport,
	registration: AdapterRegistration,
): void {
	if (report.artifacts.length > registration.limits.maxArtifacts) throw new Error('artifact-count-limit');
	let totalBytes = 0;
	const declared = new Set(report.artifacts.map((file) => file.path));
	for (const file of report.artifacts) {
		const bytes = readEvidenceFile(directory, file.path, registration.limits.maxArtifactBytes);
		totalBytes += bytes.length;
		if (totalBytes > registration.limits.maxArtifactBytes ||
			bytes.length !== file.sizeBytes || hashEvidenceBytes(bytes) !== file.sha256) {
			throw new Error('artifact-manifest-mismatch');
		}
	}
	for (const result of report.cases) {
		for (const attempt of result.attempts) {
			if (attempt.artifactPaths.some((file) => !declared.has(file))) {
				throw new Error('undeclared-attempt-artifact');
			}
		}
	}
}
