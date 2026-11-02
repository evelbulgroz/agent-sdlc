import { applyQualitySchema } from '../quality-storage.ts';
import type { MigrationStep } from './baseline-schema.ts';

export const upgradesFromV15: readonly MigrationStep[] = [
	{ version: 15, up(database) { applyQualitySchema(database); } },
];
