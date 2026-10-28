import fs from 'node:fs';
import path from 'node:path';

export interface ArchiveLedgerRunsResult {
	archived: string[];
	freedTokens: number;
	freedCalls: number;
	freedCostMicrousd: number;
}

interface RawLedgerEnvelope {
	reservations?: unknown[];
	attempts?: {
		charge?: {
			totalTokens?: number;
			physicalCalls?: number;
			costMicrousd?: number;
		};
	}[];
}

/**
 * Scans tools/.model-usage/runs/ for completed or inactive run envelopes
 * and archives them to tools/.model-usage/archive/.
 *
 * An envelope is eligible for archiving if:
 * 1. It is not the currently active run (options.currentRunId).
 * 2. It has zero active reservations (envelope.reservations is empty or missing).
 */
export function archiveCompletedLedgerRuns(
	rootDir: string,
	options: { currentRunId?: string } = {},
): ArchiveLedgerRunsResult {
	const currentRunId = options.currentRunId;
	const runsRoot = path.resolve(rootDir, 'tools/.model-usage/runs');
	const archiveRoot = path.resolve(rootDir, 'tools/.model-usage/archive');

	if (!fs.existsSync(runsRoot)) {
		return { archived: [], freedTokens: 0, freedCalls: 0, freedCostMicrousd: 0 };
	}

	fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });

	const archived: string[] = [];
	let freedTokens = 0;
	let freedCalls = 0;
	let freedCostMicrousd = 0;

	const entries = fs.readdirSync(runsRoot, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
		const runId = entry.name.slice(0, -5);

		if (currentRunId && runId === currentRunId) continue;

		const filePath = path.join(runsRoot, entry.name);
		let envelope: RawLedgerEnvelope | undefined;
		try {
			envelope = JSON.parse(fs.readFileSync(filePath, 'utf8')) as RawLedgerEnvelope;
		} catch {
			fs.renameSync(filePath, path.join(archiveRoot, entry.name));
			archived.push(runId);
			continue;
		}

		const hasActiveReservations =
			Array.isArray(envelope?.reservations) && envelope.reservations.length > 0;
		if (hasActiveReservations) {
			continue;
		}

		if (Array.isArray(envelope?.attempts)) {
			for (const attempt of envelope.attempts) {
				freedTokens += attempt.charge?.totalTokens ?? 0;
				freedCalls += attempt.charge?.physicalCalls ?? 0;
				freedCostMicrousd += attempt.charge?.costMicrousd ?? 0;
			}
		}

		const destPath = path.join(archiveRoot, entry.name);
		fs.renameSync(filePath, destPath);
		archived.push(runId);
	}

	return { archived, freedTokens, freedCalls, freedCostMicrousd };
}
