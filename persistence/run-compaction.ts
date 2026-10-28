import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SdlcError } from '../policy/errors.ts';

export const DROPPED_CHECKPOINT_TABLES: readonly string[] = Object.freeze([
	'checkpoints',
	'checkpoint_writes',
]);

export interface CompactedDatabaseVerification {
	integrity: 'ok';
	retainedTables: readonly string[];
	rowCounts: Readonly<Record<string, number>>;
}

function quoteIdent(identifier: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
		throw new SdlcError('INVALID_INPUT', `Unsafe SQLite table identifier: ${identifier}`);
	}
	return `"${identifier}"`;
}

function listUserTables(db: DatabaseSync): string[] {
	const raw: unknown = db
		.prepare(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
			 ORDER BY name ASC`,
		)
		.all();
	return (raw as { name: string }[]).map((row) => row.name);
}

function getRowCounts(db: DatabaseSync, tableNames: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const table of tableNames) {
		const raw: unknown = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`).get();
		const row = raw as { count: number | bigint } | undefined;
		counts.set(table, Number(row?.count ?? 0));
	}
	return counts;
}

export function verifyCompactedDatabase(
	sourceDatabasePath: string,
	targetDatabasePath: string,
): Readonly<CompactedDatabaseVerification> {
	let sourceDb: DatabaseSync | undefined;
	let targetDb: DatabaseSync | undefined;
	try {
		sourceDb = new DatabaseSync(sourceDatabasePath, { readOnly: true });
		targetDb = new DatabaseSync(targetDatabasePath, { readOnly: true });

		const integrityRow = targetDb.prepare('PRAGMA integrity_check').get();
		const integrityResult =
			integrityRow?.integrity_check ?? Object.values(integrityRow ?? {})[0];
		if (integrityResult !== 'ok') {
			throw new SdlcError(
				'STORE_CORRUPT',
				`Compacted database failed PRAGMA integrity_check: ${String(integrityResult)}`,
			);
		}

		const targetTables = new Set(listUserTables(targetDb));
		for (const droppedTable of DROPPED_CHECKPOINT_TABLES) {
			if (targetTables.has(droppedTable)) {
				throw new SdlcError(
					'STORE_CORRUPT',
					`Compacted database still contains dropped table ${droppedTable}`,
				);
			}
		}

		const retainedSourceTables = listUserTables(sourceDb).filter(
			(name) => !DROPPED_CHECKPOINT_TABLES.includes(name),
		);
		const sourceCounts = getRowCounts(sourceDb, retainedSourceTables);
		for (const table of retainedSourceTables) {
			if (!targetTables.has(table)) {
				throw new SdlcError(
					'STORE_CORRUPT',
					`Compacted database is missing retained table ${table}`,
				);
			}
		}
		const targetCounts = getRowCounts(targetDb, retainedSourceTables);
		for (const table of retainedSourceTables) {
			const expected = sourceCounts.get(table) ?? 0;
			const actual = targetCounts.get(table) ?? 0;
			if (actual !== expected) {
				throw new SdlcError(
					'STORE_CORRUPT',
					`Row count mismatch on retained table ${table}: expected ${expected}, got ${actual}`,
					{ table, expected, actual },
				);
			}
		}
		return Object.freeze({
			integrity: 'ok',
			retainedTables: Object.freeze(retainedSourceTables),
			rowCounts: Object.freeze(Object.fromEntries(targetCounts)),
		});
	} finally {
		try {
			sourceDb?.close();
		} catch {
			// Ignore close error.
		}
		try {
			targetDb?.close();
		} catch {
			// Ignore close error.
		}
	}
}

export function compactRunDatabase(
	sourceDatabasePath: string,
	targetDatabasePath: string,
	{ beforeVerify }: { beforeVerify?: (targetPath: string) => void } = {},
): Readonly<CompactedDatabaseVerification> {
	fs.mkdirSync(path.dirname(targetDatabasePath), { recursive: true, mode: 0o700 });
	if (fs.existsSync(targetDatabasePath)) {
		fs.rmSync(targetDatabasePath, { force: true });
	}
	let sourceDb: DatabaseSync | undefined;
	try {
		sourceDb = new DatabaseSync(sourceDatabasePath, { readOnly: true });
		const escapedTarget = targetDatabasePath.replaceAll("'", "''");
		sourceDb.exec(`VACUUM INTO '${escapedTarget}'`);
	} finally {
		try {
			sourceDb?.close();
		} catch {
			// Ignore close error.
		}
	}

	let targetDb: DatabaseSync | undefined;
	try {
		targetDb = new DatabaseSync(targetDatabasePath);
		for (const table of DROPPED_CHECKPOINT_TABLES) {
			targetDb.exec(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
		}
		targetDb.exec('VACUUM');
	} finally {
		try {
			targetDb?.close();
		} catch {
			// Ignore close error.
		}
	}

	if (typeof beforeVerify === 'function') {
		beforeVerify(targetDatabasePath);
	}

	return verifyCompactedDatabase(sourceDatabasePath, targetDatabasePath);
}
