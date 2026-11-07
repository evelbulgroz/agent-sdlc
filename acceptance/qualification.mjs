import path from 'node:path';
import { fail } from './primitives.mjs';

// Offline qualification never grants capabilities: it lists what is unproven and every case stays untested.
export function qualificationResult(corpus, inventory) {
  if (corpus?.schemaVersion !== '1.0.0' || !Array.isArray(corpus.cases) || !corpus.cases.length) {
    fail('invalid qualification corpus');
  }
  if (inventory?.schemaVersion !== '1.0.0' || !Array.isArray(inventory.files)
    || !inventory.files.length) fail('invalid runtime inventory');
  if (!Array.isArray(inventory.nativeInterpreters ?? [])) fail('invalid native interpreter inventory');
  const failures = [...(inventory.blockingRequirements ?? [])];
  for (const native of inventory.nativeInterpreters ?? []) {
    const expectedPath = typeof native?.interpreter === 'string'
      && path.isAbsolute(native.interpreter) && !native.interpreter.split('/').includes('..')
      && !native.interpreter.includes('\\') && !native.interpreter.includes('\0')
      ? `sysroot${native.interpreter}` : null;
    const loader = expectedPath && inventory.files.find(file => file?.path === expectedPath);
    if (!native || typeof native.path !== 'string' || !loader
      || !/^[a-f0-9]{64}$/.test(loader.sha256 ?? '')) {
      failures.push(`Unqualified native interpreter: ${native?.path ?? 'unknown'} -> ${native?.interpreter ?? 'unknown'}`);
    }
  }
  failures.push('Complete runtime, native containment and real runner qualification are not yet proven');
  return {
    schemaVersion: '1.0.0', status: 'blocked', failures,
    observedCases: [], untestedCases: corpus.cases.map((entry) => entry.id),
  };
}
