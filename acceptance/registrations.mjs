import fs from 'node:fs';
import path from 'node:path';
import { bytesHash, engineModule, fail, readJson, regularFile, verifyFile } from './primitives.mjs';
import { engineContracts } from './contracts.mjs';
import { artifact } from './artifacts.mjs';

const reference = (root, relative) => ({
  path: relative, sha256: bytesHash(fs.readFileSync(regularFile(root, relative))),
});

// Builds engine AdapterRegistrations from frozen host files, one per configured runner. The adapter
// qualification receipt is the one the execution manifest already binds per runner.
export function buildRegistrations(root, config, { execution, dependencyManifest }) {
  verifyFile(root, dependencyManifest);
  return Object.entries(config.runners).map(([kind, runner]) => {
    if (!runner.config) fail(`runner has no config: ${kind}`);
    const binding = execution.adapters?.find((entry) => entry.kind === kind);
    if (!binding?.qualification) fail(`missing adapter qualification: ${kind}`);
    verifyFile(root, binding.qualification);
    const receipt = readJson(path.join(root, binding.qualification.path));
    if (receipt.status !== 'passed' || receipt.liveQualified !== false || receipt.providerOperations !== 0) {
      fail(`adapter qualification not passed: ${kind}`);
    }
    return {
      adapterId: `${config.repositoryId}-${kind}`, protocolVersion: '1.0.0',
      bundleFiles: runner.bundleFiles.map((file) => reference(root, file)),
      dependencyFiles: [], dependencyManifest,
      configurationFiles: [reference(root, `${config.packageRoot}/${runner.config}`),
        reference(root, artifact(config, 'executionManifest'))],
      argv: [...runner.argv], executableSha256: bytesHash(fs.readFileSync(fs.realpathSync(runner.argv[0]))),
      profiles: [{ profileId: kind, layers: [kind], capabilities: runner.capabilities ?? [] }],
      qualificationArtifactHash: binding.qualification.sha256, qualificationArtifact: binding.qualification,
      limits: { timeoutMs: runner.timeoutMs ?? 120000, maxReportBytes: 1048576, maxArtifactBytes: 16777216, maxArtifacts: 8 },
    };
  });
}

export async function validateRegistrations(root, registrations) {
  const contracts = await engineContracts();
  const { verifyEvidenceRegistration } = await engineModule('host/evidence-files');
  for (const registration of registrations) {
    contracts.AdapterRegistrationSchema.parse(registration);
    verifyEvidenceRegistration(root, registration, () => fail('compact frozen dependency manifest required'));
  }
  return registrations.map((registration) => ({
    adapterId: registration.adapterId, bindingHash: contracts.sha256(registration),
  }));
}
