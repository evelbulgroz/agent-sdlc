import type { MigrationStep } from './baseline-schema.ts';

// v14: run authorizations record the bound verificationPreparation policy hash (null when none).
export const upgradesFromV14: readonly MigrationStep[] = [
	{
		version: 14,
		up(db, helpers) {
			if (typeof helpers.hasColumn !== 'function') {
				throw new Error('Migration step requires hasColumn');
			}
			const tableExists = (db.prepare('PRAGMA table_info(run_authorizations)').all() as unknown[]).length > 0;
			if (tableExists && !helpers.hasColumn(db, 'run_authorizations', 'preparation_policy_hash')) {
				db.exec('ALTER TABLE run_authorizations ADD COLUMN preparation_policy_hash TEXT');
			}
		},
	},
];
