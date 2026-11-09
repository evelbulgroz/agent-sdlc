import fs from 'node:fs';
import { argumentsFor, bytesHash, engineModule, fail, isMain, main, writeJson } from './primitives.ts';

type RoleRecord = { roleId: string; requestedLimits: { maxPhysicalAttempts: number;
  maxRetriesPerRoute: number; maxFailovers: number } };

type RegistryModule = { RoleRegistry: new (options: { rootDir: string }) => {
  loadRole(roleId: string): { role: { modelProfile: unknown; requestedLimits: RoleRecord['requestedLimits'] };
    hashes: { roleHash: string; promptPolicyHash: string } };
} };

const ROLE_IDS = ['specifier', 'implementer', 'reviewer', 'critic-reviewer'];

// Freezes the roles as the engine resolves them, including host overrides under .agents/workflows/roles.
export async function resolveRoleRecord(root: string) {
  const { RoleRegistry } = await engineModule<RegistryModule>('roles/role-registry');
  const registry = new RoleRegistry({ rootDir: root });
  const roles = ROLE_IDS.map((roleId) => {
    const { role, hashes } = registry.loadRole(roleId);
    return { roleId, modelProfile: role.modelProfile, requestedLimits: role.requestedLimits,
      roleHash: hashes.roleHash, promptPolicyHash: hashes.promptPolicyHash };
  });
  const failures: string[] = [];
  const criticRole: RoleRecord | undefined = roles.find((role: RoleRecord) => role.roleId === 'critic-reviewer');
  if (!criticRole) return fail('critic-reviewer role is not defined');
  const critic = criticRole.requestedLimits;
  if (critic.maxPhysicalAttempts !== 2 || critic.maxRetriesPerRoute !== 1 || critic.maxFailovers !== 0) {
    failures.push('critic-reviewer must use 2 attempts, 1 retry and 0 failovers');
  }
  return { schemaVersion: '1.0.0', status: failures.length ? 'blocked' : 'passed', failures, roles,
    resolvedSha256: bytesHash(Buffer.from(JSON.stringify(roles))) };
}

if (isMain(import.meta.url)) await main(async () => {
  const args = argumentsFor(process.argv.slice(2), ['--output']);
  const record = await resolveRoleRecord(fs.realpathSync(process.cwd()));
  writeJson(args['--output'], record);
  process.stdout.write(`${record.status}\n${JSON.stringify(record.roles.map((role) =>
    [role.roleId, role.modelProfile, role.requestedLimits]), null, 1)}\n`);
});
