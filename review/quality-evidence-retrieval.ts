import crypto from 'node:crypto';
import path from 'node:path';
import { readEvidenceFile } from '../host/evidence-files.ts';
import type { QualityPolicy, RetrievalRequest, RetrievalResponse } from '../policy/contracts/quality-schema.ts';
import { RetrievalRequestSchema, RetrievalResponseSchema } from '../policy/contracts/quality-schema.ts';
import { sha256 } from '../policy/contracts.ts';
import type { CriticFinding } from './critic-review.ts';

export interface QualityRetrievalResult {
	request: RetrievalRequest;
	response: RetrievalResponse;
	files: readonly { path: string; content: string }[];
}

export function makeQualityRetrievalRequest({
	findings,
	obligations,
	bindingHash,
	reviewOperationId,
}: {
	findings: readonly CriticFinding[];
	obligations: readonly { obligationId: string; implementationPaths: readonly string[] }[];
	bindingHash: string;
	reviewOperationId: string;
}): RetrievalRequest | null {
	for (const finding of findings) {
		if (!Array.isArray(finding.lineRange) || finding.lineRange.length !== 2) continue;
		const [start, end] = finding.lineRange;
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) continue;
		const obligation = obligations.find((candidate) =>
			candidate.implementationPaths.includes(finding.file),
		);
		if (!obligation) continue;
		const operationId = `retrieval-${sha256({
			bindingHash,
			reviewOperationId,
			obligationId: obligation.obligationId,
			file: finding.file,
			start,
			end,
		}).slice(0, 40)}`;
		return RetrievalRequestSchema.parse({
			schemaVersion: '1.0.0',
			operationId,
			reviewOperationId,
			bindingHash,
			obligationId: obligation.obligationId,
			file: finding.file,
			selector: { kind: 'lines', start, end },
		});
	}
	return null;
}

export function retrieveQualitySource({
	worktreeDir,
	request,
	policy,
	alreadyRetrievedBytes,
	alreadyRetrievedLines,
}: {
	worktreeDir: string;
	request: RetrievalRequest;
	policy: QualityPolicy;
	alreadyRetrievedBytes: number;
	alreadyRetrievedLines: number;
}): QualityRetrievalResult {
	const root = path.resolve(worktreeDir);
	const absolutePath = path.resolve(root, request.file);
	const relative = path.relative(root, absolutePath);
	if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('retrieval-path-escaped-candidate');
	}
	if (request.selector.kind !== 'lines') {
		return unavailable(request, 'Helper-symbol retrieval is not available');
	}
	const requestedLines = request.selector.end - request.selector.start + 1;
	const remainingBytes = Math.max(0, policy.retrieval.maxTotalBytesPerCandidate - alreadyRetrievedBytes);
	const maxBytes = Math.min(policy.retrieval.maxPacketBytes, remainingBytes);
	const remainingLines = Math.max(0, policy.retrieval.maxTotalLinesPerCandidate - alreadyRetrievedLines);
	const maxLines = Math.min(policy.retrieval.maxPacketLines, remainingLines);
	if (!Number.isSafeInteger(requestedLines) || requestedLines > maxLines || maxBytes <= 0) {
		return unavailable(request, 'Retrieval exceeds the remaining candidate packet budget');
	}
	let bytes: Buffer;
	try {
		bytes = readEvidenceFile(root, request.file, maxBytes);
	} catch {
		return unavailable(request, 'Requested source file is unavailable');
	}
	const source = bytes.toString('utf8');
	const lines = source.split(/\r?\n/);
	if (request.selector.end > lines.length) return unavailable(request, 'Requested lines are outside the source file');
	const text = lines.slice(request.selector.start - 1, request.selector.end).join('\n');
	const response = RetrievalResponseSchema.parse({
		schemaVersion: '1.0.0',
		requestHash: sha256(request),
		fileHash: crypto.createHash('sha256').update(bytes).digest('hex'),
		ranges: [{ start: request.selector.start, end: request.selector.end, text }],
		omittedRanges: [
			...(request.selector.start > 1 ? [{ start: 1, end: request.selector.start - 1 }] : []),
			...(request.selector.end < lines.length ? [{ start: request.selector.end + 1, end: lines.length }] : []),
		],
		unresolvedHelpers: [],
		outcome: 'complete',
	});
	const responseBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
	if (responseBytes > maxBytes || responseBytes > policy.retrieval.maxPacketBytes) {
		return unavailable(request, 'Retrieved response exceeds the remaining candidate packet budget');
	}
	return { request, response, files: [{ path: request.file, content: text }] };
}

function unavailable(request: RetrievalRequest, reason: string): QualityRetrievalResult {
	const response = RetrievalResponseSchema.parse({
		schemaVersion: '1.0.0',
		requestHash: sha256(request),
		fileHash: '0'.repeat(64),
		ranges: [],
		omittedRanges: [],
		unresolvedHelpers: [reason],
		outcome: 'unavailable',
	});
	return { request, response, files: [] };
}
