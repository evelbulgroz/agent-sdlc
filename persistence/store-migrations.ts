import { STORE_SCHEMA_VERSION } from '../policy/contracts.ts';
import { SdlcError } from '../policy/errors.ts';
import { type MigrationStep, applyBaselineSchema } from './migrations/baseline-schema.ts';
import { upgradesV1ToV7 } from './migrations/upgrades-v1-v7.ts';
import { upgradesV8ToV13 } from './migrations/upgrades-v8-v13.ts';
import type { StoreDatabase } from './run-ledger.ts';

export const MIGRATION_LADDER: readonly MigrationStep[] = Object.freeze([
	...upgradesV1ToV7,
	...upgradesV8ToV13,
]);

export function assertLadder(steps: readonly { version: number }[]): void {
	if (!Array.isArray(steps) || steps.length === 0) {
		throw new Error('Migration ladder is empty');
	}
	for (let index = 1; index < steps.length; index += 1) {
		if (steps[index].version !== steps[index - 1].version + 1) {
			throw new Error(
				`Migration ladder version ${steps[index].version} does not follow ${steps[index - 1].version}`,
			);
		}
	}
	const last = steps[steps.length - 1].version;
	if (last !== STORE_SCHEMA_VERSION) {
		throw new Error(`Migration ladder ends at ${last}, expected ${STORE_SCHEMA_VERSION}`);
	}
}

function recordVersion(database: StoreDatabase, version: number): void {
	database
		.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
		.run(version, new Date().toISOString());
}

function hasColumn(database: StoreDatabase, table: string, name: string): boolean {
	const rawCols: unknown = database.prepare(`PRAGMA table_info(${table})`).all();
	const cols = rawCols as { name: string }[];
	return cols.some((column) => column.name === name);
}

function applyUnversionedRepairs(database: StoreDatabase): void {
	const rawGenCols: unknown = database.prepare('PRAGMA table_info(generations)').all();
	const genCols = rawGenCols as { name: string }[];
	if (genCols.length > 0 && !genCols.some((col) => col.name === 'oracle_snapshot_json')) {
		database.exec('ALTER TABLE generations ADD COLUMN oracle_snapshot_json TEXT');
	}

	database.exec(`
		CREATE TABLE IF NOT EXISTS continuation_attempts (
			run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
			blocked_reason TEXT NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 1,
			policy_fingerprint TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY(run_id, blocked_reason)
		);
	`);
	const rawContCols: unknown = database.prepare('PRAGMA table_info(continuation_attempts)').all();
	const continuationColumns = rawContCols as { name: string }[];
	if (
		continuationColumns.length > 0 &&
		!continuationColumns.some((column) => column.name === 'policy_fingerprint')
	) {
		database.exec('ALTER TABLE continuation_attempts ADD COLUMN policy_fingerprint TEXT');
	}
}

export function migrateRuntimeStore(
	database: StoreDatabase,
	transaction: <T>(operation: () => T) => T,
): void {
	database.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			applied_at TEXT NOT NULL
		)
	`);
	const rawVersionRow: unknown = database
		.prepare('SELECT max(version) AS version FROM schema_migrations')
		.get();
	const versionRow = rawVersionRow as { version: number | null } | undefined;
	const current = versionRow?.version ?? 0;
	if (current > STORE_SCHEMA_VERSION) {
		throw new SdlcError(
			'STORE_VERSION_UNSUPPORTED',
			`Runtime store schema ${current} is newer than supported ${STORE_SCHEMA_VERSION}`,
		);
	}
	if (current === 0) {
		transaction(() => {
			applyBaselineSchema(database);
			recordVersion(database, STORE_SCHEMA_VERSION);
		});
		return;
	}
	for (const step of MIGRATION_LADDER) {
		if (step.version <= current) continue;
		transaction(() => {
			step.up(database, { hasColumn });
			recordVersion(database, step.version);
		});
	}
	applyUnversionedRepairs(database);
}

assertLadder(MIGRATION_LADDER);
