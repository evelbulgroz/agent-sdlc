import path from 'node:path';
import { readEvidenceFile } from '../host/evidence-files.ts';
import type { EvidenceCompletion } from '../host/evidence-types.ts';
import type { EvidenceObligation, QualityPolicy } from '../policy/contracts/quality-schema.ts';

export interface QualityEvidencePacketInput {
	worktreeDir: string;
	obligations: readonly EvidenceObligation[];
	receipts: readonly { receiptHash: string; completion: EvidenceCompletion | null }[];
	policy: QualityPolicy;
}

export interface QualityEvidencePacket {
	status: 'complete' | 'insufficient_evidence';
	reason: string | null;
	text: string;
	files: readonly { path: string; content: string }[];
	byteCount: number;
	lineCount: number;
}

export function packQualityEvidencePacket({
	worktreeDir,
	obligations,
	receipts,
	policy,
}: QualityEvidencePacketInput): QualityEvidencePacket {
	if (obligations.length === 0 || receipts.length === 0) {
		return Object.freeze({
			status: 'insufficient_evidence',
			reason: 'The checkpoint has no scoped obligations or execution receipts',
			text: '',
			files: Object.freeze([]),
			byteCount: 0,
			lineCount: 0,
		});
	}
	const receiptEvidence = receipts.map(({ receiptHash, completion }) => {
		if (
			!completion ||
			completion.receipt.status !== 'passed' ||
			completion.invocation.status !== 'completed' ||
			!completion.report
		) {
			return null;
		}
		return {
			receiptHash,
			dischargedObligationIds: completion.receipt.dischargedObligationIds,
			cases: completion.report.cases.map((result) => ({
				file: result.file,
				caseKey: result.caseKey,
				obligationIds: result.obligationIds,
				outcome: result.outcome,
				exercisedCapabilities: result.exercisedCapabilities,
				attempts: result.attempts.map(({ index, outcome, durationMs }) => ({
					index,
					outcome,
					durationMs,
				})),
			})),
		};
	});
	if (receiptEvidence.some((evidence) => evidence === null)) {
		return Object.freeze({
			status: 'insufficient_evidence',
			reason: 'A checkpoint receipt is missing, invalidated, or incomplete',
			text: '',
			files: Object.freeze([]),
			byteCount: 0,
			lineCount: 0,
		});
	}
	const normalizedReceipts = receiptEvidence.filter((item) => item !== null);
	for (const obligation of obligations) {
		const discharged = normalizedReceipts.some((receipt) =>
			receipt.dischargedObligationIds.includes(obligation.obligationId) &&
			obligation.testCases.every((testCase) =>
				receipt.cases.some((result) =>
					result.file === testCase.file &&
					result.caseKey === testCase.caseKey &&
					result.outcome === 'passed' &&
					result.obligationIds.includes(obligation.obligationId) &&
					obligation.requiredCapabilities.every((capability) =>
						result.exercisedCapabilities.includes(capability),
					),
				),
			),
		);
		if (!discharged) {
			return Object.freeze({
				status: 'insufficient_evidence',
				reason: `No current passing receipt discharges obligation ${obligation.obligationId}`,
				text: '',
				files: Object.freeze([]),
				byteCount: 0,
				lineCount: 0,
			});
		}
	}
	const casePaths = [...new Set(obligations.flatMap((obligation) =>
		obligation.testCases.map((testCase) => testCase.file),
	))].sort();
	const implementationPaths = [...new Set(obligations.flatMap((obligation) =>
		obligation.implementationPaths,
	))].sort();
	const sourcePaths = [...new Set([...casePaths, ...implementationPaths])].sort();
	const files: Array<{ path: string; content: string }> = [];
	let sourceBytes = 0;
	let sourceLines = 0;
	for (const sourcePath of sourcePaths) {
		const absolutePath = path.resolve(worktreeDir, sourcePath);
		const relative = path.relative(worktreeDir, absolutePath);
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
			return insufficient('A declared case path escaped the candidate worktree');
		}
		let content: string;
		try {
			content = readEvidenceFile(path.resolve(worktreeDir), sourcePath,
				policy.retrieval.maxPacketBytes - sourceBytes).toString('utf8');
		} catch {
			return insufficient(`Case source is unavailable: ${sourcePath}`);
		}
		sourceBytes += Buffer.byteLength(content, 'utf8');
		sourceLines += content.split('\n').length;
		if (
			sourceBytes > policy.retrieval.maxPacketBytes ||
			sourceLines > policy.retrieval.maxPacketLines
		) {
			return insufficient('Case sources exceed the bounded initial evidence packet');
		}
		files.push({ path: sourcePath, content });
	}
	const fileByPath = new Map(files.map((file) => [file.path, file.content]));
	const packet = {
		checkpointEvidence: obligations.map((obligation) => ({
			obligationId: obligation.obligationId,
			criterionId: obligation.criterionId,
			caseId: obligation.caseId,
			owner: obligation.owner,
			observableOutcome: obligation.observableOutcome,
			setupAction: obligation.setupAction,
			expectedResult: obligation.expectedResult,
			layer: obligation.layer,
			requiredCapabilities: obligation.requiredCapabilities,
			executedCases: obligation.testCases.map((testCase) => ({
				...testCase,
				source: fileByPath.get(testCase.file),
			})),
		})),
		implementationSources: implementationPaths.map((filePath) => ({
			path: filePath,
			source: fileByPath.get(filePath),
		})),
		receipts: normalizedReceipts,
	};
	const text = JSON.stringify(packet);
	const byteCount = Buffer.byteLength(text, 'utf8');
	const lineCount = sourceLines + text.split('\n').length;
	if (byteCount > policy.retrieval.maxPacketBytes || lineCount > policy.retrieval.maxPacketLines) {
		return insufficient('Case obligations and sources exceed the bounded initial evidence packet');
	}
	return Object.freeze({
		status: 'complete',
		reason: null,
		text,
		files: Object.freeze(files),
		byteCount,
		lineCount,
	});

	function insufficient(reason: string): QualityEvidencePacket {
		return Object.freeze({
			status: 'insufficient_evidence',
			reason,
			text: '',
			files: Object.freeze([]),
			byteCount: sourceBytes,
			lineCount: sourceLines,
		});
	}
}
