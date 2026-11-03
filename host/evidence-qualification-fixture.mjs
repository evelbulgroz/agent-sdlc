import fs from 'node:fs';
import path from 'node:path';
import { hashEvidenceBytes } from './evidence-files.ts';

export function qualify(root, artifactPath, sourceCommitSha, inventorySha256) {
	const bytes = Buffer.from(JSON.stringify({
		schemaVersion: '1.0.0', kind: 'test-runtime', status: 'passed',
		liveQualified: false, providerOperations: 0, sourceCommitSha, inventorySha256,
	}));
	fs.writeFileSync(path.join(root, artifactPath), bytes);
	const artifact = { path: artifactPath, sha256: hashEvidenceBytes(bytes) };
	return { qualificationArtifactHash: artifact.sha256, qualificationArtifact: artifact };
}
