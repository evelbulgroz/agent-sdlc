// Candidate-learning projection. Strict reads throw; lenient reads return null.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_SCHEMA_VERSION } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';

export interface CandidateLearningItem {
	type: string;
	key: string;
	scope: string;
	query: string;
	insight: string;
	confidence: string | number;
	source: string;
	stagedAt?: string;
}

export interface CandidateLearningStoreLike {
	listCandidateLearnings?(runId: string): readonly CandidateLearningItem[];
}

function errnoCode(error: unknown): string | undefined {
	if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
		return error.code;
	}
	return undefined;
}

/**
 * strict: store, then legacy file, throw on malformed JSON.
 * lenient: legacy file only, null when the file is missing or malformed.
 */
export function readCandidateLearnings(options: {
	mode: 'strict';
	runtimeStore: { listCandidateLearnings(runId: string): readonly CandidateLearningItem[] };
	runId: string;
	legacyPath?: string | null;
}): readonly CandidateLearningItem[];
export function readCandidateLearnings(options: {
	mode: 'lenient';
	runtimeStore?: CandidateLearningStoreLike | null;
	runId?: string;
	legacyPath?: string | null;
}): readonly CandidateLearningItem[] | null;
export function readCandidateLearnings({
	mode,
	runtimeStore,
	runId = '',
	legacyPath,
}: {
	mode: 'strict' | 'lenient';
	runtimeStore?: CandidateLearningStoreLike | null;
	runId?: string;
	legacyPath?: string | null;
}): readonly CandidateLearningItem[] | null {
	if (mode === 'strict') {
		let candidateLearnings: readonly CandidateLearningItem[] =
			runtimeStore?.listCandidateLearnings?.(runId) ?? [];
		if (candidateLearnings.length === 0 && legacyPath && fs.existsSync(legacyPath)) {
			try {
				const legacyPayload = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as
					| CandidateLearningItem[]
					| { candidates?: CandidateLearningItem[] };
				candidateLearnings = Array.isArray(legacyPayload)
					? legacyPayload
					: (legacyPayload.candidates ?? []);
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				throw new SdlcError(
					'INVALID_CONTRACT',
					`Candidate learning projection is invalid: ${message}`,
					{},
					{ cause: error },
				);
			}
		}
		return candidateLearnings;
	}
	if (!legacyPath || !fs.existsSync(legacyPath)) return null;
	try {
		const candidateContent = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as
			| CandidateLearningItem[]
			| ({ candidates?: CandidateLearningItem[] } & CandidateLearningItem);
		return Array.isArray(candidateContent)
			? candidateContent
			: (candidateContent.candidates ?? [candidateContent]);
	} catch {
		return null;
	}
}

export function writeCandidateLearningsProjection(
	runDir: string,
	runId: string,
	runtimeStore: CandidateLearningStoreLike | null | undefined,
): void {
	if (!runtimeStore?.listCandidateLearnings) return;
	const candidates = runtimeStore.listCandidateLearnings(runId);
	if (!candidates || candidates.length === 0) return;
	const candidateLearningsPath = path.join(runDir, 'candidate-learnings.json');
	const payload = {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		runId,
		generatedAt: candidates
			.map((candidate) => candidate.stagedAt)
			.filter((val): val is string => Boolean(val))
			.sort()
			.at(-1),
		candidates: candidates.map((c) => ({
			type: c.type,
			key: c.key,
			scope: c.scope,
			query: c.query,
			insight: c.insight,
			confidence: c.confidence,
			source: c.source,
		})),
	};
	atomicWrite(candidateLearningsPath, `${JSON.stringify(payload, null, 2)}\n`);
}

export function atomicWrite(
	destination: string,
	content: string,
	{ exclusive = false }: { exclusive?: boolean } = {},
): void {
	fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
	const temporary = path.join(
		path.dirname(destination),
		`.${path.basename(destination)}.${crypto.randomUUID()}.pending`,
	);
	try {
		fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
		if (exclusive) {
			try {
				fs.linkSync(temporary, destination);
				fs.unlinkSync(temporary);
			} catch (error: unknown) {
				if (errnoCode(error) === 'EEXIST') {
					throw new SdlcError('INVALID_INPUT', `Destination exists: ${destination}`);
				}
				throw error;
			}
		} else {
			fs.renameSync(temporary, destination);
		}
	} catch (error: unknown) {
		try {
			if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
		} catch {
			// Preserve the original atomic publication error.
		}
		if (error instanceof SdlcError) throw error;
		throw new SdlcError(
			'INTERNAL_ERROR',
			`Atomic write failed: ${destination}`,
			{},
			{
				cause: error,
			},
		);
	}
}
