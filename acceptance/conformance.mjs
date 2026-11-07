import { spawn } from 'node:child_process';
import { engineContracts } from './contracts.mjs';
import { fail } from './primitives.mjs';

const MAX_REPORT_BYTES = 1048576;

/** Runs an adapter command with the request on stdin, as the supervisor parent does. */
export function runAdapterProcess({ argv, cwd, input, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, env: { PATH: process.env.PATH ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.stdin.on('error', () => {});
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.end(input);
  });
}

/** Wire-contract check of an adapter result: throws unless the report is exactly what the request asked for. */
export async function verifyAdapterResult(request, result) {
  const contracts = await engineContracts();
  if (result.code !== 0) fail(`adapter exited ${result.code}`);
  if (Buffer.byteLength(result.stdout) > MAX_REPORT_BYTES) fail('adapter report too large');
  const parsed = contracts.EvidenceReportSchema.parse(JSON.parse(result.stdout));
  if (parsed.operationId !== request.operationId || parsed.profileId !== request.profileId
    || parsed.adapterBindingHash !== request.adapterBindingHash
    || parsed.requestHash !== contracts.sha256(request)) fail('adapter report is not bound to its request');
  const expected = new Map();
  for (const obligation of request.obligations) {
    for (const { file, caseKey } of obligation.testCases) {
      const ids = expected.get(`${file}\0${caseKey}`) ?? new Set();
      ids.add(obligation.obligationId);
      expected.set(`${file}\0${caseKey}`, ids);
    }
  }
  const actual = new Map(parsed.cases.map((entry) => [`${entry.file}\0${entry.caseKey}`, entry]));
  if (actual.size !== expected.size || [...expected.keys()].some((key) => !actual.has(key))) {
    fail('adapter report does not cover exactly the selected cases');
  }
  for (const [key, ids] of expected) {
    if ([...ids].sort().join() !== [...actual.get(key).obligationIds].sort().join()) fail('adapter report obligation mismatch');
  }
  return parsed;
}

const HASH = 'a'.repeat(64);
const TREE = 'b'.repeat(40);

/** A minimal valid request with two obligations sharing one case, for adapter conformance runs. */
export function conformanceRequest({ layer = 'unit', artifactDirectory = '/tmp/conformance' } = {}) {
  const obligation = (id, caseId) => ({
    obligationId: id, criterionId: 'AC-01', caseId, owner: { kind: 'task', id: 'task-1' },
    observableOutcome: 'ready state visible', setupAction: 'activate the control',
    expectedResult: 'the ready state is asserted', layer, requiredCapabilities: [],
    implementationPaths: ['src/code.ts'],
    testCases: [{ file: 'src/check.spec.ts', caseKey: 'ready' }, ...(id === 'obligation-2' ? [{ file: 'src/check.spec.ts', caseKey: 'second' }] : [])],
    adapterBindingHash: HASH, profileId: layer,
  });
  return {
    schemaVersion: '1.0.0', operationId: 'conformance-1',
    binding: { runId: '2026-11-01-conformance', approvedSpecHash: HASH, taskPlanHash: HASH, qualityPolicyHash: HASH,
      checkpointId: 'task-1', checkpointKind: 'task', ownerId: 'task-1', candidateRevision: 0,
      baseCommitSha: TREE, treeSha: TREE, revisionSetHash: HASH, preparationHash: HASH },
    adapterBindingHash: HASH, profileId: layer,
    obligations: [obligation('obligation-1', 'AC-01.1'), obligation('obligation-2', 'AC-01.2')],
    artifactDirectory,
  };
}
