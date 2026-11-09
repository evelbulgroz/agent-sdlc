import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { engineModule } from './primitives.ts';
import { resolveRoleRecord } from './role-definitions.ts';

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('engineModule loads engine modules by extensionless name and fails closed when absent', async () => {
  assert.equal(typeof (await engineModule('roles/role-registry')).RoleRegistry, 'function');
  await assert.rejects(engineModule('roles/does-not-exist'), /engine module not found/);
});

test('role definitions resolve through the engine registry without environment variables', async () => {
  const saved = process.env.AGENT_SDLC_PATH;
  delete process.env.AGENT_SDLC_PATH;
  try {
    const record = await resolveRoleRecord(ENGINE_ROOT);
    assert.deepEqual(record.roles.map((role) => role.roleId),
      ['specifier', 'implementer', 'reviewer', 'critic-reviewer']);
    assert.match(record.resolvedSha256, /^[0-9a-f]{64}$/);
  } finally { if (saved !== undefined) process.env.AGENT_SDLC_PATH = saved; }
});
