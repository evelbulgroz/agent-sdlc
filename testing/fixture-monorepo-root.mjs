import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_MONOREPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-monorepo');
