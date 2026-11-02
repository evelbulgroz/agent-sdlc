import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HASH_PATTERN, GIT_SHA, IDENTIFIER_PATTERN, sha256 } from '../policy/contracts/primitives.ts';
import { assertSafeQualityPath, qualityFailure, type QualityStorage } from './quality-storage.ts';

const VerificationReceiptSchema = z.strictObject({
	schemaVersion: z.literal('1.0.0'), runId: z.string(),
	taskId: z.string().regex(IDENTIFIER_PATTERN), executionRevision: z.number().int().nonnegative(),
	treeSha: z.string().regex(GIT_SHA), command: z.array(z.string().min(1)).min(1),
	artifactHash: z.string().regex(HASH_PATTERN), exitCode: z.literal(0), status: z.literal('passed'),
});
export type VerificationReceipt = z.infer<typeof VerificationReceiptSchema>;

export function createQualityVerification(storage: QualityStorage, databasePath: string) {
	function saveVerificationReceipt(input: VerificationReceipt): string {
		const receipt = VerificationReceiptSchema.parse(input);
		const artifact = z.object({ storage_path: z.string() }).optional().parse(
			storage.ctx.database.prepare('SELECT storage_path FROM artifacts WHERE hash=?').get(receipt.artifactHash));
		const artifactPath = artifact ? assertSafeQualityPath(path.dirname(databasePath), artifact.storage_path) : null;
		if (!artifactPath || !fs.existsSync(artifactPath) ||
			!fs.lstatSync(artifactPath).isFile() || fs.lstatSync(artifactPath).isSymbolicLink() ||
			crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex') !== receipt.artifactHash) {
			qualityFailure('Deterministic verification artifact is missing or corrupt');
		}
		const hash = sha256(receipt);
		storage.put(receipt.runId, 'verification-receipt', hash, receipt);
		return hash;
	}
	function getVerificationReceipt(runId: string, hash: string): VerificationReceipt | null {
		if (storage.invalidated(runId, 'verification-receipt', hash)) return null;
		return storage.get(runId, 'verification-receipt', hash);
	}
	return { saveVerificationReceipt, getVerificationReceipt };
}
