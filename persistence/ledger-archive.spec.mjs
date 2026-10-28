import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { archiveCompletedLedgerRuns } from './ledger-archive.ts';

function createTempRoot() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-ledger-archive-test-'));
}

test('archiveCompletedLedgerRuns: returns empty when runs directory does not exist', () => {
	const tempDir = createTempRoot();
	try {
		const result = archiveCompletedLedgerRuns(tempDir);
		assert.deepEqual(result, {
			archived: [],
			freedTokens: 0,
			freedCalls: 0,
			freedCostMicrousd: 0,
		});
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('archiveCompletedLedgerRuns: archives completed runs and preserves active and current runs', () => {
	const tempDir = createTempRoot();
	try {
		const runsDir = path.join(tempDir, 'tools/.model-usage/runs');
		fs.mkdirSync(runsDir, { recursive: true });

		// 1. Current run (should NOT be archived)
		const currentRun = {
			runId: 'active-current-run',
			reservations: [],
			attempts: [{ charge: { totalTokens: 1000, physicalCalls: 1, costMicrousd: 100 } }],
		};
		fs.writeFileSync(path.join(runsDir, 'active-current-run.json'), JSON.stringify(currentRun));

		// 2. Run with active reservations (should NOT be archived)
		const activeReservationRun = {
			runId: 'in-flight-run',
			reservations: [{ reservationId: 'res-1' }],
			attempts: [{ charge: { totalTokens: 2000, physicalCalls: 1, costMicrousd: 200 } }],
		};
		fs.writeFileSync(path.join(runsDir, 'in-flight-run.json'), JSON.stringify(activeReservationRun));

		// 3. Completed run without reservations (SHOULD be archived)
		const completedRun = {
			runId: 'old-completed-run',
			reservations: [],
			attempts: [
				{ charge: { totalTokens: 5000, physicalCalls: 2, costMicrousd: 500 } },
				{ charge: { totalTokens: 3000, physicalCalls: 1, costMicrousd: 300 } },
			],
		};
		fs.writeFileSync(path.join(runsDir, 'old-completed-run.json'), JSON.stringify(completedRun));

		const result = archiveCompletedLedgerRuns(tempDir, { currentRunId: 'active-current-run' });

		assert.deepEqual(result.archived, ['old-completed-run']);
		assert.equal(result.freedTokens, 8000);
		assert.equal(result.freedCalls, 3);
		assert.equal(result.freedCostMicrousd, 800);

		// Verify files on disk
		assert.equal(fs.existsSync(path.join(runsDir, 'active-current-run.json')), true);
		assert.equal(fs.existsSync(path.join(runsDir, 'in-flight-run.json')), true);
		assert.equal(fs.existsSync(path.join(runsDir, 'old-completed-run.json')), false);

		const archiveDir = path.join(tempDir, 'tools/.model-usage/archive');
		assert.equal(fs.existsSync(path.join(archiveDir, 'old-completed-run.json')), true);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test('archiveCompletedLedgerRuns: defensively archives corrupt json files', () => {
	const tempDir = createTempRoot();
	try {
		const runsDir = path.join(tempDir, 'tools/.model-usage/runs');
		fs.mkdirSync(runsDir, { recursive: true });

		fs.writeFileSync(path.join(runsDir, 'corrupt-run.json'), 'NOT_VALID_JSON{');

		const result = archiveCompletedLedgerRuns(tempDir);
		assert.deepEqual(result.archived, ['corrupt-run']);

		const archiveDir = path.join(tempDir, 'tools/.model-usage/archive');
		assert.equal(fs.existsSync(path.join(archiveDir, 'corrupt-run.json')), true);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
