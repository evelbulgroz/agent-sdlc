import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AdapterRegistration, EvidenceReport } from '../policy/contracts/quality-schema.ts';
import {
	AdapterQualificationReceiptSchema, EvidenceDependencyManifestSchema,
} from '../policy/contracts/quality-evidence-schema.ts';

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
		if (fs.realpathSync(current) !== current) throw new Error('unsafe-file-path');
		const bytes = fs.readFileSync(descriptor);
		if (bytes.length > maxBytes) throw new Error('invalid-file-size-or-kind');
		return bytes;
	} finally {
		fs.closeSync(descriptor);
	}
}

export function verifyEvidenceRegistration(
	root: string,
	registration: AdapterRegistration,
	assertAllowed: (relative: string) => void,
): void {
	const command = registration.argv[0];
	if (!command || !path.isAbsolute(command) || path.resolve(command) !== command ||
		!registration.executableSha256) throw new Error('unqualified-evidence-executable');
	const executable = readEvidenceFile(path.parse(command).root,
		command.slice(path.parse(command).root.length), Number.MAX_SAFE_INTEGER);
	if (hashEvidenceBytes(executable) !== registration.executableSha256 ||
		(fs.statSync(command).mode & 0o111) === 0) throw new Error('frozen-adapter-file-changed');
	let manifestFiles: { path: string; sha256: string }[] = [];
	if (registration.dependencyManifest) {
		const file = registration.dependencyManifest;
		const bytes = readEvidenceFile(root, file.path, 20 * 1024 * 1024);
		if (hashEvidenceBytes(bytes) !== file.sha256) throw new Error('frozen-adapter-file-changed');
		manifestFiles = EvidenceDependencyManifestSchema.parse(JSON.parse(bytes.toString('utf8'))).files;
	}
	for (const file of [
		...registration.bundleFiles, ...registration.dependencyFiles, ...registration.configurationFiles,
		...manifestFiles,
	]) {
		// A manifest-backed registration grants frozen read inputs, never model write scope.
		if (!registration.dependencyManifest) assertAllowed(file.path);
		// The schema has no bundle-size ceiling; read and hash exact regular-file bytes.
		if (hashEvidenceBytes(readEvidenceFile(root, file.path, Number.MAX_SAFE_INTEGER)) !== file.sha256) {
			throw new Error('frozen-adapter-file-changed');
		}
	}
	const qualification = registration.qualificationArtifact;
	if (!qualification || qualification.sha256 !== registration.qualificationArtifactHash) {
		throw new Error('unqualified-evidence-adapter');
	}
	if (!registration.dependencyManifest) assertAllowed(qualification.path);
	const qualificationBytes = readEvidenceFile(root, qualification.path, 1024 * 1024);
	if (hashEvidenceBytes(qualificationBytes) !== registration.qualificationArtifactHash) {
		throw new Error('frozen-adapter-file-changed');
	}
	let qualificationInput: unknown;
	try {
		qualificationInput = JSON.parse(qualificationBytes.toString('utf8'));
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error('unqualified-evidence-adapter');
		throw error;
	}
	const receipt = AdapterQualificationReceiptSchema.safeParse(qualificationInput);
	if (!receipt.success) {
		throw new Error('unqualified-evidence-adapter');
	}
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
