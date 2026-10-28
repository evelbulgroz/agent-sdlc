import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { containsSensitiveCredential } from '@fitness-app/model-usage/sanitize-failure-text';
import { canonicalJson, normalizeText, sha256 } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import type { RunLedger } from './run-ledger.ts';

export type ArtifactRegistryStore = Pick<RunLedger, 'registerArtifact' | 'getArtifact'>;

export function assertProjectionSafe(text: unknown): string {
	const normalized = normalizeText(String(text));
	if (containsSensitiveCredential(normalized)) {
		throw new SdlcError(
			'INVALID_CONTRACT',
			'Projection contains a high-risk secret pattern and was not written',
		);
	}
	return normalized;
}

export function assertAuthoritativeInputSafe<T>(value: T, subject = 'Authoritative input'): T {
	const candidates: string[] = [typeof value === 'string' ? value : canonicalJson(value)];
	collectStrings(value, candidates);
	for (const text of candidates) {
		if (containsSensitiveCredential(text)) {
			throw new SdlcError('INVALID_CONTRACT', `${subject} contains a high-risk secret pattern`);
		}
	}
	return value;
}

function collectStrings(value: unknown, output: string[]): void {
	if (typeof value === 'string') {
		output.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, output);
		return;
	}
	if (value && typeof value === 'object') {
		for (const item of Object.values(value)) collectStrings(item, output);
	}
}

export class ArtifactStore {
	readonly artifactsDir: string;
	readonly runtimeStore: ArtifactRegistryStore;
	readonly maxArtifactBytes: number;

	constructor({
		artifactsDir,
		runtimeStore,
		maxArtifactBytes = 524_288,
	}: {
		artifactsDir: string;
		runtimeStore: ArtifactRegistryStore;
		maxArtifactBytes?: number;
	}) {
		this.artifactsDir = artifactsDir;
		this.runtimeStore = runtimeStore;
		this.maxArtifactBytes = maxArtifactBytes;
		fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
	}

	writeJson(
		type: string,
		value: unknown,
		{ redactionStatus = 'local-raw' }: { redactionStatus?: string } = {},
	): string {
		return this.write(type, `${canonicalJson(value)}\n`, {
			mediaType: 'application/json',
			redactionStatus,
		});
	}

	writeText(
		type: string,
		value: unknown,
		{ redactionStatus = 'local-raw' }: { redactionStatus?: string } = {},
	): string {
		return this.write(type, normalizeText(String(value)), {
			mediaType: 'text/plain; charset=utf-8',
			redactionStatus,
		});
	}

	write(
		type: string,
		content: string,
		{ mediaType, redactionStatus }: { mediaType: string; redactionStatus: string },
	): string {
		const bytes = Buffer.from(content, 'utf8');
		if (bytes.byteLength === 0) {
			throw new SdlcError('INVALID_CONTRACT', `Artifact '${type}' cannot be empty`);
		}
		if (bytes.byteLength > this.maxArtifactBytes) {
			throw new SdlcError('INVALID_CONTRACT', `Artifact '${type}' exceeds size limit`);
		}
		const hash = sha256(content);
		const extension = mediaType === 'application/json' ? 'json' : 'txt';
		const filename = `${hash}.${extension}`;
		const destination = path.join(this.artifactsDir, filename);
		if (!fs.existsSync(destination)) {
			const temporary = path.join(this.artifactsDir, `.${filename}.${crypto.randomUUID()}.pending`);
			try {
				fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
				fs.renameSync(temporary, destination);
			} catch (error: unknown) {
				try {
					if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
				} catch {
					// The original typed write error remains authoritative.
				}
				throw new SdlcError(
					'INTERNAL_ERROR',
					`Artifact write failed for '${type}'`,
					{},
					{
						cause: error,
					},
				);
			}
		}
		this.runtimeStore.registerArtifact({
			hash,
			type,
			mediaType,
			byteLength: bytes.byteLength,
			storagePath: `artifacts/${filename}`,
			redactionStatus,
		});
		return hash;
	}

	read(hash: string | null | undefined): string {
		if (!hash) throw new SdlcError('ARTIFACT_CORRUPT', `Unknown artifact ${String(hash)}`);
		const metadata = this.runtimeStore.getArtifact(hash);
		if (!metadata) throw new SdlcError('ARTIFACT_CORRUPT', `Unknown artifact ${hash}`);
		const artifactPath = path.join(path.dirname(this.artifactsDir), metadata.storagePath);
		let bytes: Buffer;
		try {
			bytes = fs.readFileSync(artifactPath);
		} catch (error: unknown) {
			throw new SdlcError(
				'ARTIFACT_CORRUPT',
				`Artifact ${hash} cannot be read`,
				{},
				{
					cause: error,
				},
			);
		}
		if (bytes.byteLength !== metadata.byteLength || sha256(bytes.toString('utf8')) !== hash) {
			throw new SdlcError('ARTIFACT_CORRUPT', `Artifact ${hash} failed integrity validation`);
		}
		return bytes.toString('utf8');
	}

	readJson(hash: string | null | undefined): Record<string, unknown> {
		try {
			const parsed: unknown = JSON.parse(this.read(hash));
			return parsed as Record<string, unknown>;
		} catch (error: unknown) {
			if (error instanceof SdlcError) throw error;
			throw new SdlcError(
				'ARTIFACT_CORRUPT',
				`Artifact ${String(hash)} is invalid JSON`,
				{},
				{
					cause: error,
				},
			);
		}
	}
}
